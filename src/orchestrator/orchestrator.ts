import { join } from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import {
  BacklogMutationNotStartedError,
  type BacklogAdapter,
} from "../backlog/adapter.js";
import type { CodingAgentAdapter } from "../agent/adapter.js";
import type { BranchProtection, ForgeAdapter, PullRequest } from "../pr/adapter.js";
import type { RunmillConfig } from "../config/types.js";
import { StateStore } from "../state/store.js";
import type { Clock } from "../platform/clock.js";
import type { BacklogIssue, RepositoryTarget } from "../domain/types.js";
import { WorkspaceManager, type Workspace } from "../workspace/manager.js";
import {
  VerificationEngine,
  assertEffectiveVerificationChecks,
  resolveManifest,
  type CheckSpec,
} from "../verification/engine.js";
import { buildTaskPacket, renderIssueDocument } from "../agent/task-packet.js";
import { outputPathFor, readStructuredOutput } from "../agent/output-contract.js";
import { parseReviewJson, blockingFindings, crossCheckVerdict, type Review } from "../review/schema.js";
import { reconcileChecks, type CheckMapping, type ReconcileVerdict } from "../pr/reconcile.js";
import {
  GitRefLease,
  LeaseConflictError,
  type HeldLease,
} from "../queue/git-lease.js";
import { RunmillError , errorMessage } from "../errors/runmill-error.js";
import { renderPullRequestBody } from "./pr-body.js";
import { createIssueAuthoritySnapshot } from "../domain/snapshot.js";
import { RunLog } from "../state/run-log.js";
import { evaluateAutomaticMergeRisk } from "./risk-policy.js";
import { RunBudget } from "./run-budget.js";
import {
  buildPullRequestEvidence,
  PR_EVIDENCE_PATH,
  serializePullRequestEvidence,
} from "./pr-evidence.js";
import { tryGit, tryGitBytes } from "../platform/git.js";
import { normalizeRepositoryPath } from "../workspace/path-scope.js";
import { buildEligibilityPolicy } from "../queue/selector.js";
import { assessIssueAuthority } from "./issue-authority.js";

export type RunState =
  | "DISCOVERED"
  | "ELIGIBILITY_CHECKED"
  | "CLAIMED"
  | "WORKSPACE_READY"
  | "TASK_PACKET_READY"
  | "IMPLEMENTING"
  | "LOCAL_VERIFY"
  | "LOCAL_REVIEW"
  | "FIXING"
  | "PR_READY"
  | "PUSHED"
  | "PR_OPEN"
  | "CI_WAIT"
  | "PR_REVIEW"
  | "MERGE_READY"
  | "AWAITING_APPROVAL"
  | "MERGED"
  | "BACKLOG_UPDATED"
  | "PR_DELIVERED"
  | "CLEANUP"
  | "COMPLETED"
  | "NEEDS_HUMAN"
  | "QUARANTINED"
  | "ABORTED";

export interface OrchestratorDeps {
  readonly backlog: BacklogAdapter;
  readonly provider: CodingAgentAdapter;
  /**
   * Runs `local-reviewer` and `pr-reviewer`.
   *
   * Optional, and equal to `provider` when unset. Pointing it at a different
   * vendor is what makes review independent rather than merely fresh: a model
   * reviewing its own work agrees with itself for the same reasons it was
   * wrong, and no amount of context clearing fixes that.
   */
  readonly reviewProvider?: CodingAgentAdapter | undefined;
  readonly forge: ForgeAdapter;
  readonly store: StateStore;
  readonly clock: Clock;
  readonly config: RunmillConfig;
  readonly workspaces?: WorkspaceManager | undefined;
  readonly verification: VerificationEngine;
  readonly sourceRepoPath: string;
  /** GitHub owner/name parsed from the exact local origin being cloned. */
  readonly sourceRepository: string;
  /**
   * Exact trusted source commit/ref for the run workspace. Production binds
   * this to the remote base fetch; evaluation may bind it to historical data.
   */
  readonly sourceBaseRef?: string | undefined;
  readonly workspaceRoot: string;
  /** Human-readable activity journal. Defaults beside machine state, never in source. */
  readonly runLogPath?: string | undefined;
  readonly checks: readonly CheckSpec[];
  readonly checkMappings?: readonly CheckMapping[] | undefined;
  readonly onEvent?: ((message: string) => void) | undefined;
  /** How often CI_WAIT re-reads the checks. Lowered by tests. */
  readonly ciPollIntervalMs?: number | undefined;
  /** Injectable so tests do not spend real time in the CI poll loop. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface RunOutcome {
  readonly runId: string;
  readonly issueId: string;
  readonly finalState: RunState;
  /** Branch this run pushed. */
  readonly branch?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly prUrl?: string | undefined;
  readonly mergeSha?: string | undefined;
  readonly costUsd: number;
  readonly agentInvocations?: number | undefined;
  readonly reason?: string | undefined;
}

class TerminalStatePersistenceError extends Error {
  constructor(runId: string, state: RunState, cause: unknown) {
    super(
      `terminal state ${state} for ${runId} could not be persisted: ${errorMessage(cause)}`,
      { cause },
    );
    this.name = "TerminalStatePersistenceError";
  }
}

/**
 * Drives one issue from selection to a governed outcome.
 *
 * Two invariants hold throughout. Every external mutation is preceded by an
 * outbox intent row and a lease fence, so a crash leaves a reconcilable record
 * and a fenced-out worker cannot act. And every state change is a
 * compare-and-swap against the store, so two processes cannot both advance the
 * same run.
 */
export class Orchestrator {
  readonly #d: OrchestratorDeps;
  readonly #workspaces: WorkspaceManager;
  readonly #verification: VerificationEngine;
  readonly #runLog: RunLog;
  #state: RunState = "DISCOVERED";
  #version = 1;

  constructor(deps: OrchestratorDeps) {
    this.#d = deps;
    this.#workspaces = deps.workspaces ?? new WorkspaceManager();
    this.#verification = deps.verification;
    this.#runLog = new RunLog(deps.runLogPath ?? join(deps.workspaceRoot, "..", "log.md"));
  }

  #codingToolInventory(): readonly string[] {
    const core = ["git", "rg", "node", "npm", "npx"];
    const configured = this.#d.config.verification.commands.flatMap((check) => {
      const command = check.run;
      const executable = command.trim().split(/\s+/, 1)[0];
      if (executable === undefined || executable === "") return [];
      // A relative path lives in the writable candidate tree. Granting it for
      // the whole provider session would let the agent replace bytes after
      // qualification. Relative checks run later in the read-only verification
      // checkout; provider tools are bare installed names or absolute operator paths.
      if (executable.includes("/") && !executable.startsWith("/")) return [];
      return [executable];
    });
    return [...new Set([...core, ...configured])];
  }

  #preparedDependencyPaths(workspacePath: string): readonly string[] {
    const lookup = this.#workspaces as WorkspaceManager & {
      agentDependencyPath?: (path: string) => string | undefined;
    };
    const path = lookup.agentDependencyPath?.(workspacePath);
    return path === undefined ? [] : [path];
  }

  /** The adapter that runs review roles. Falls back to the implementer's. */
  get #reviewer(): CodingAgentAdapter {
    return this.#d.reviewProvider ?? this.#d.provider;
  }

  #log(message: string): void {
    this.#d.onEvent?.(message);
  }

  /** Capture repository guidance from the exact base commit before implementation. */
  async #reviewGuidance(
    configuredPath: string | undefined,
    workspace: Workspace,
  ): Promise<{ source: string; content: string } | undefined> {
    if (configuredPath === undefined) return undefined;

    try {
      normalizeRepositoryPath(configuredPath);
    } catch (cause) {
      throw RunmillError.fromCatalog("RM-CONFIG-001", {
        whatHappened:
          `${JSON.stringify(configuredPath)} is not a normalized, non-empty ` +
          "repository-relative POSIX review guidance path.",
        cause,
      });
    }

    const tree = await tryGit(workspace.path, [
      "--literal-pathspecs",
      "ls-tree",
      "-z",
      workspace.baseCommit,
      "--",
      configuredPath,
    ]);
    const entry = tree.ok ? tree.stdout : "";
    const separator = entry.indexOf("\t");
    const metadata = separator === -1 ? [] : entry.slice(0, separator).split(" ");
    const listedPath = separator === -1 ? "" : entry.slice(separator + 1, -1);
    const [mode, type, objectId] = metadata;
    if (
      !tree.ok ||
      !entry.endsWith("\0") ||
      entry.indexOf("\0") !== entry.length - 1 ||
      listedPath !== configuredPath ||
      (mode !== "100644" && mode !== "100755") ||
      type !== "blob" ||
      objectId === undefined
    ) {
      throw RunmillError.fromCatalog("RM-CONFIG-001", {
        whatHappened:
          `${JSON.stringify(configuredPath)} at base commit ${workspace.baseCommit} ` +
          "is not a regular Git blob.",
      });
    }

    const sizeResult = await tryGit(workspace.path, ["cat-file", "-s", objectId]);
    const sizeText = sizeResult.stdout.trim();
    const size = /^\d+$/u.test(sizeText) ? Number(sizeText) : Number.NaN;
    if (!sizeResult.ok || !Number.isSafeInteger(size) || size < 0) {
      throw RunmillError.fromCatalog("RM-CONFIG-001", {
        whatHappened:
          `Could not determine the size of ${JSON.stringify(configuredPath)} at base commit ` +
          `${workspace.baseCommit}.`,
      });
    }
    if (size > MAX_REVIEW_GUIDANCE_BYTES) {
      throw RunmillError.fromCatalog("RM-CONFIG-001", {
        whatHappened:
          `${configuredPath} is larger than ${MAX_REVIEW_GUIDANCE_BYTES} bytes. ` +
          "Repository review guidance is prompt input, so keep it bounded.",
      });
    }

    const blob = await tryGitBytes(
      workspace.path,
      ["cat-file", "blob", objectId],
      Math.max(1, size),
    );
    if (!blob.ok || blob.stdout.length !== size) {
      throw RunmillError.fromCatalog("RM-CONFIG-001", {
        whatHappened:
          `Could not read ${JSON.stringify(configuredPath)} exactly from base commit ` +
          `${workspace.baseCommit}.`,
      });
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blob.stdout);
    } catch (cause) {
      throw RunmillError.fromCatalog("RM-CONFIG-001", {
        whatHappened:
          `${JSON.stringify(configuredPath)} at base commit ${workspace.baseCommit} ` +
          "is not valid UTF-8 review guidance.",
        cause,
      });
    }
    if (!Buffer.from(content, "utf8").equals(blob.stdout)) {
      throw RunmillError.fromCatalog("RM-CONFIG-001", {
        whatHappened:
          `Could not preserve ${JSON.stringify(configuredPath)} exactly from base commit ` +
          `${workspace.baseCommit}.`,
      });
    }
    return { source: configuredPath, content };
  }

  /** Re-read the remote PR and bind it to the exact local candidate. */
  async #pullRequestAtCandidate(input: {
    repo: string;
    number: number;
    candidateSha: string;
  }): Promise<{ pullRequest?: PullRequest; blocked?: string }> {
    const current = await this.#d.forge.getPullRequest({
      repo: input.repo,
      number: input.number,
    });
    if (current === undefined) {
      return { blocked: `pull request #${input.number} could not be read from ${input.repo}` };
    }
    if (current.state !== "open") {
      return {
        blocked: `pull request #${input.number} is ${current.state}, not the open candidate Runmill created`,
      };
    }
    if (current.headSha !== input.candidateSha) {
      return {
        blocked:
          `pull request #${input.number} head ${current.headSha} does not match the exact ` +
          `candidate ${input.candidateSha}; refusing stale or externally amended evidence`,
      };
    }
    return { pullRequest: current };
  }

  /** Wait for required CI contexts on one exact candidate SHA. */
  async #waitForCi(input: {
    target: RepositoryTarget;
    candidateSha: string;
    lease: GitRefLease;
    held: HeldLease;
    budget: RunBudget;
  }): Promise<
    | { blocked: string }
    | { protection: BranchProtection; verdicts: ReadonlyMap<string, ReconcileVerdict> }
  > {
    input.budget.assertActive("reading branch protection");
    const ciWaitStartedMs = this.#d.clock.now().getTime();
    const protection = await this.#d.forge.getBranchProtection({
      repo: input.target.repo,
      branch: input.target.baseBranch,
    });

    // Unreadable rules are not absent rules. A 403 on the protection endpoint
    // is common, and treating it as "nothing required" would fail open.
    if (protection.unreadable) {
      return {
        blocked:
          "branch protection could not be read, so required checks and approvals are " +
          "unknown; refusing to treat unreadable rules as absent rules",
      };
    }

    const pollIntervalMs = this.#d.ciPollIntervalMs ?? CI_POLL_INTERVAL_MS;
    const pause = this.#d.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    const mappings =
      this.#d.checkMappings ??
      protection.requiredChecks.map((context) => ({
        localId: context,
        contextName: context,
      }));

    let verdicts = new Map<string, ReconcileVerdict>();
    let unsatisfied: [string, ReconcileVerdict][] = [];
    const maxAttempts = Math.max(1, Math.ceil(CI_SCHEDULE_DEADLINE_MS / pollIntervalMs)) + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      input.budget.assertActive("polling CI");
      const observed = await this.#d.forge.listChecks({
        repo: input.target.repo,
        ref: input.candidateSha,
      });
      verdicts = reconcileChecks({
        requiredContexts: protection.requiredChecks,
        mappings,
        observed,
        headSha: input.candidateSha,
        waitedMs: this.#d.clock.now().getTime() - ciWaitStartedMs,
        scheduleDeadlineMs: CI_SCHEDULE_DEADLINE_MS,
        ...(protection.usesMergeQueue ? { event: "merge_group" as const } : {}),
      });
      unsatisfied = [...verdicts].filter(([, verdict]) => verdict.state !== "satisfied");
      if (unsatisfied.length === 0) break;
      if (unsatisfied.some(([, verdict]) => verdict.state !== "waiting")) break;
      if (this.#d.clock.now().getTime() - ciWaitStartedMs >= CI_SCHEDULE_DEADLINE_MS) break;

      await input.lease.assertHeld(input.held);
      input.budget.assertActive("waiting for CI");
      await pause(pollIntervalMs);
    }

    if (unsatisfied.length > 0) {
      return {
        blocked: `CI not satisfied — ${unsatisfied
          .map(([name, verdict]) => `${name}: ${verdict.detail}`)
          .join("; ")}`,
      };
    }
    return { protection, verdicts };
  }

  #advance(runId: string, to: RunState, reason?: string): void {
    this.#d.store.transitionRun(runId, {
      from: this.#state,
      to,
      expectedVersion: this.#version,
      ...(reason === undefined ? {} : { reason }),
    });
    this.#state = to;
    this.#version += 1;
    this.#log(`→ ${to}`);
  }


  /** Journal, publish, and exactly observe acquisition before granting authority. */
  async #acquireLease(input: {
    lease: GitRefLease;
    issueId: string;
    runId: string;
    repo: string;
    priorStateId: string;
    priorAssigneeId?: string | undefined;
  }): Promise<HeldLease> {
    const prepared = await input.lease.prepareAcquire(input.issueId, {
      priorStateId: input.priorStateId,
      ...(input.priorAssigneeId === undefined
        ? {}
        : { priorAssigneeId: input.priorAssigneeId }),
    });
    this.#d.store.beginLeaseAcquisition({
      issueId: input.issueId,
      runId: input.runId,
      repo: input.repo,
      generation: prepared.generation,
      refName: prepared.refName,
      objectId: prepared.objectId,
      acquiredAt: prepared.acquiredAt,
      expiresAt: prepared.expiresAt,
      heartbeatAt: prepared.heartbeatAt,
      hostId: prepared.hostId,
      pid: prepared.pid,
      ...(prepared.bootId === undefined ? {} : { bootId: prepared.bootId }),
      ...(prepared.priorStateId === undefined
        ? {}
        : { priorStateId: prepared.priorStateId }),
      ...(prepared.priorAssigneeId === undefined
        ? {}
        : { priorAssigneeId: prepared.priorAssigneeId }),
    });

    let mutationError: unknown;
    try {
      await input.lease.publishAcquire(prepared);
    } catch (error) {
      mutationError = error;
    }

    let observedObjectId: string | undefined;
    try {
      observedObjectId = await input.lease.observeObjectId(input.issueId);
    } catch (observationError) {
      throw new Error(
        `lease acquisition outcome for ${input.issueId} is unknown; its durable ` +
          "acquiring intent must be reconciled manually",
        { cause: mutationError ?? observationError },
      );
    }
    const reconciled = this.#d.store.reconcileLeaseObservation({
      issueId: input.issueId,
      runId: input.runId,
      generation: prepared.generation,
      refName: prepared.refName,
      objectId: prepared.objectId,
      observedObjectId: observedObjectId ?? null,
    });
    if (reconciled.outcome === "intended") {
      if (mutationError !== undefined) {
        this.#log(
          `lease acquisition response was lost; exact ref observation confirmed ${prepared.objectId}`,
        );
      }
      return prepared;
    }
    if (reconciled.outcome === "absent") {
      throw new Error(
        `could not claim issue ${input.issueId}: the exact remote lease ref is absent` +
          (mutationError === undefined ? "" : `; ${errorMessage(mutationError)}`),
        mutationError === undefined ? undefined : { cause: mutationError },
      );
    }

    const current = await input.lease.read(input.issueId).catch(() => undefined);
    throw new LeaseConflictError(
      `issue ${input.issueId} is fenced by a contradictory lease object ` +
        `${observedObjectId ?? "unknown"}`,
      current?.runId,
      current?.generation,
    );
  }

  /** Journal, publish, and exactly observe release before clearing ownership. */
  async #releaseLease(
    lease: GitRefLease,
    held: HeldLease,
    issueId: string,
    runId: string,
  ): Promise<void> {
    await lease.assertHeld(held);
    this.#d.store.beginLeaseRelease({
      issueId,
      runId,
      generation: held.generation,
      refName: held.refName,
      objectId: held.objectId,
    });

    let mutationError: unknown;
    try {
      await lease.publishRelease(held);
    } catch (error) {
      mutationError = error;
    }

    let observedObjectId: string | undefined;
    try {
      observedObjectId = await lease.observeObjectId(issueId);
    } catch (observationError) {
      throw new Error(
        `lease release outcome for ${issueId} is unknown; its durable releasing ` +
          "intent must be reconciled manually",
        { cause: mutationError ?? observationError },
      );
    }
    const reconciled = this.#d.store.reconcileLeaseObservation({
      issueId,
      runId,
      generation: held.generation,
      refName: held.refName,
      objectId: held.objectId,
      observedObjectId: observedObjectId ?? null,
    });
    if (reconciled.outcome === "absent") return;
    if (reconciled.outcome === "expected") {
      throw new Error(
        `lease release for ${issueId} did not apply; the exact expected object remains` +
          (mutationError === undefined ? "" : `; ${errorMessage(mutationError)}`),
        mutationError === undefined ? undefined : { cause: mutationError },
      );
    }
    throw new LeaseConflictError(
      `lease release for ${issueId} was fenced by contradictory object ` +
        `${observedObjectId ?? "unknown"}`,
    );
  }

  async #revalidateIssueAuthority(input: {
    runId: string;
    stage: "before-first-push" | "before-pr-delivery" | "before-merge";
    initial: BacklogIssue;
    target: RepositoryTarget;
    candidateSha: string;
    claimTransitioned: boolean;
    assignmentChanged: boolean;
  }): Promise<{ readonly blocked?: string | undefined }> {
    const initialSnapshot = createIssueAuthoritySnapshot(input.initial);
    const recordUnknown = (reason: string): { readonly blocked: string } => {
      this.#d.store.recordStandalonePolicyDecision({
        runId: input.runId,
        candidateSha: input.candidateSha,
        inputs: {
          kind: "issue-authority-revalidation",
          stage: input.stage,
          initial_fingerprint: initialSnapshot.fingerprint,
          observed_fingerprint: null,
          target: input.target,
        },
        matched: { rules: [] },
        outcome: "unknown",
        explanation: reason,
      });
      return { blocked: reason };
    };

    let persistedInitial: ReturnType<StateStore["standaloneIssueSnapshot"]>;
    try {
      persistedInitial = this.#d.store.standaloneIssueSnapshot(input.runId);
    } catch (cause) {
      return recordUnknown(
        `persisted issue authority is malformed at ${input.stage}: ${errorMessage(cause)}`,
      );
    }
    if (persistedInitial === undefined) {
      return recordUnknown(`persisted issue authority is missing at ${input.stage}`);
    }
    if (
      persistedInitial.issueId !== input.initial.identifier ||
      persistedInitial.fingerprint !== initialSnapshot.fingerprint ||
      persistedInitial.body !== initialSnapshot.body
    ) {
      return recordUnknown(
        `persisted issue authority contradicts the claimed input at ${input.stage}`,
      );
    }

    let observed: BacklogIssue | undefined;
    try {
      observed = await this.#d.backlog.getIssue(input.initial.identifier);
    } catch (cause) {
      return recordUnknown(
        `issue authority could not be re-observed at ${input.stage}: ${errorMessage(cause)}`,
      );
    }
    if (observed === undefined) {
      return recordUnknown(
        `issue authority could not be re-observed at ${input.stage}: issue is missing`,
      );
    }

    const applied = (operation: string, target: string): boolean => {
      const effect = this.#d.store.getSideEffect(
        StateStore.sideEffectKey(input.runId, operation, target),
      );
      return (
        effect?.status === "confirmed" &&
        effect.remoteId !== "orchestrator:not-applied" &&
        effect.remoteId !== "operator:not-applied"
      );
    };
    const claimAssignee = this.#d.config.backlog.claimAssignee;
    const assignmentRequired =
      claimAssignee !== undefined && input.initial.assigneeId !== claimAssignee;
    const leasedIssueIds = this.#d.store.activeLeaseIssueIds();
    leasedIssueIds.delete(input.initial.identifier);
    let assessment: ReturnType<typeof assessIssueAuthority>;
    try {
      assessment = assessIssueAuthority({
        initial: input.initial,
        observed,
        target: input.target,
        policy: buildEligibilityPolicy({
          config: this.#d.config,
          leasedIssueIds,
        }),
        claim: {
          state: this.#d.config.backlog.claimState,
          stateEffectConfirmed:
            input.claimTransitioned &&
            applied("transition-claim", input.initial.identifier),
          ...(claimAssignee === undefined ? {} : { assignee: claimAssignee }),
          assignmentEffectConfirmed:
            !assignmentRequired ||
            (input.assignmentChanged &&
              applied(
                "assign-claim",
                `${input.initial.identifier}#${claimAssignee ?? ""}`,
              )),
        },
      });
    } catch (cause) {
      return recordUnknown(
        `issue authority evidence was malformed at ${input.stage}: ${errorMessage(cause)}`,
      );
    }

    this.#d.store.recordStandalonePolicyDecision({
      runId: input.runId,
      candidateSha: input.candidateSha,
      inputs: {
        kind: "issue-authority-revalidation",
        stage: input.stage,
        initial_fingerprint: assessment.initialFingerprint,
        observed_fingerprint: assessment.observedFingerprint,
        normalized_fingerprint: assessment.normalizedFingerprint,
        target: input.target,
      },
      matched: {
        resolved_target: assessment.decision.target ?? null,
        rules: assessment.decision.rules.map((rule) => ({
          rule: rule.rule,
          passed: rule.passed,
          reason: rule.reason,
          code: rule.code ?? null,
        })),
      },
      outcome: assessment.accepted ? "accepted" : "refused",
      explanation: assessment.reason,
    });
    return assessment.accepted ? {} : { blocked: assessment.reason };
  }

  /** Intent, then act, then confirm. Never act first. */
  async #withOutbox<T>(
    runId: string,
    system: string,
    operation: string,
    target: string,
    assertLease: () => Promise<void>,
    act: () => Promise<T>,
    recordResult?: ((result: T) => void) | undefined,
  ): Promise<T> {
    const begun = this.#d.store.beginSideEffect({
      runId,
      system,
      operation,
      target,
    });
    if (begun.disposition !== "new") {
      throw RunmillError.fromCatalog("RM-STATE-002", {
        whatHappened:
          `external effect ${operation} → ${target} is already ${begun.disposition}; ` +
          "automatic continuation is disabled until its exact outcome is reconciled",
        runId,
      });
    }
    const { key } = begun;
    try {
      // The intent must exist before the fence: a crash after a successful
      // fence is still observable. If the fence itself refuses, however, the
      // external call provably never started and the intent can be closed as
      // not applied instead of blocking every later run.
      await assertLease();
    } catch (err) {
      this.#d.store.resolveSideEffect(key, "not-applied", "orchestrator");
      throw err;
    }
    this.#d.store.markSideEffectInFlight(key);
    let result: T;
    try {
      result = await act();
    } catch (err) {
      if (err instanceof BacklogMutationNotStartedError) {
        this.#d.store.resolveSideEffect(key, "not-applied", "orchestrator");
        throw err;
      }
      // Failure does not prove the effect did not land. The row stays pending
      // and blocks new work until an operator checks the named remote system.
      this.#d.store.failSideEffect(key, errorMessage(err));
      throw err;
    }
    recordResult?.(result);
    // Confirmation is outside the remote-call catch. If this durable write
    // fails, the in-flight row remains ambiguous; it must never be rewritten
    // as though the already-successful remote call itself failed.
    this.#d.store.confirmSideEffect(key);
    return result;
  }

  async run(input: {
    runId: string;
    issue: BacklogIssue;
    target: RepositoryTarget;
    lease: GitRefLease;
  }): Promise<RunOutcome> {
    const { runId, issue, target } = input;
    const cfg = this.#d.config;
    let held: HeldLease | undefined;
    let workspace: Workspace | undefined;
    let workspaceBound = false;
    let branch: string | undefined;
    let costUsd = 0;
    let logged = false;
    let claimTransitioned = false;
    let assignmentChanged = false;
    let pullRequestOpened = false;
    let runCreated = false;
    let leaseReleaseAttempted = false;
    const budget = new RunBudget({
      clock: this.#d.clock,
      maxWallMs: cfg.budgets.maxWallMinutesPerIssue * 60_000,
      maxCostUsd: cfg.budgets.maxCostUsdPerIssue,
      maxInvocations: cfg.budgets.maxAgentInvocations,
      clampInvocationTimeout: cfg.budgets.clampInvocationTimeoutToRemaining,
      costEnforcement: cfg.budgets.costEnforcement,
    });
    const providerTimeout = (role: Parameters<RunBudget["beginInvocation"]>[0]): number =>
      budget.beginInvocation(role, cfg.providers.timeoutMinutes * 60_000);
    const accountUsage = (events: Parameters<RunBudget["finishInvocation"]>[0]): void => {
      try {
        budget.finishInvocation(events);
      } finally {
        // Preserve observed spend even when this invocation crossed the cap.
        costUsd = budget.costUsd;
      }
    };
    const assertLease = async (): Promise<void> => {
      if (held === undefined) throw new Error("external mutation attempted without a held lease");
      await input.lease.assertHeld(held);
    };

    /**
     * Record the terminal state before returning it.
     *
     * The returned outcome and the persisted state must agree: recovery reads
     * the store, and `runmill list` shows it. A run that ends NEEDS_HUMAN but
     * is stored as LOCAL_REVIEW is invisible to both.
     */
    const finish = (state: RunState, extra: Partial<RunOutcome> = {}): RunOutcome => {
      if (state !== this.#state) {
        try {
          this.#advance(runId, state, extra.reason);
        } catch (cause) {
          throw new TerminalStatePersistenceError(runId, state, cause);
        }
      }
      const outcome: RunOutcome = {
        runId,
        issueId: issue.identifier,
        finalState: state,
        costUsd,
        agentInvocations: budget.invocationCount,
        ...(branch === undefined ? {} : { branch }),
        ...extra,
      };
      if (
        !logged &&
        (state === "PR_DELIVERED" || (state === "COMPLETED" && extra.reason !== "observe mode"))
      ) {
        try {
          this.#runLog.append({
            at: this.#d.clock.now(),
            issue,
            outcome: state,
            runId,
            costUsd,
            ...(extra.prNumber === undefined ? {} : { prNumber: extra.prNumber }),
            ...(extra.prUrl === undefined ? {} : { prUrl: extra.prUrl }),
            ...(extra.mergeSha === undefined ? {} : { mergeSha: extra.mergeSha }),
          });
          logged = true;
        } catch (err) {
          this.#log(`could not append the activity log: ${errorMessage(err)}`);
        }
      }
      return outcome;
    };

    try {
      // Config validation and doctor are advisory entry gates, not runtime
      // authority. Direct embedders can bypass both, so prove the effective
      // operator + repository union before acquiring a lease, mutating the
      // backlog, creating a workspace, or invoking an agent.
      const initialManifest = resolveManifest({
        configured: this.#d.checks,
        changedPaths: [],
      });
      assertEffectiveVerificationChecks(initialManifest);

      const pendingEffects = this.#d.store.pendingSideEffects();
      if (pendingEffects.length > 0) {
        throw RunmillError.fromCatalog("RM-STATE-002", {
          whatHappened:
            `${pendingEffects.length} earlier external effect(s) have an ambiguous outcome; ` +
            `the oldest is ${pendingEffects[0]?.operation ?? "unknown"} → ` +
            `${pendingEffects[0]?.target ?? "unknown"}`,
          runId,
        });
      }

      if (target.repo.toLowerCase() !== this.#d.sourceRepository.toLowerCase()) {
        throw RunmillError.fromCatalog("RM-WORKSPACE-003", {
          whatHappened:
            `issue ${issue.identifier} maps to ${target.repo}, but this daemon is attached to ` +
            `${this.#d.sourceRepository}; refusing to push one repository's tree to another`,
          runId,
        });
      }

      // Counted BEFORE this run is recorded, so the first attempt is 1.
      // github.branch_template is validated to contain {attempt} precisely so a
      // retry does not reuse a branch; hardcoding it to "1" meant every retry
      // pushed to the branch its own previous attempt had already created and
      // quarantined on a rejected push.
      const attempt = this.#d.store.attemptsFor(issue.identifier) + 1;
      this.#d.store.createRun({
        runId,
        issueId: issue.identifier,
        repo: target.repo,
        provider: cfg.providers.implementer.implementation,
        attempt,
      });
      runCreated = true;
      const issueSnapshot = createIssueAuthoritySnapshot(issue);
      this.#d.store.recordStandaloneIssueSnapshot({
        runId,
        issueId: issue.identifier,
        fingerprint: issueSnapshot.fingerprint,
        body: issueSnapshot.body,
      });
      this.#advance(runId, "ELIGIBILITY_CHECKED");

      // -- claim ---------------------------------------------------------
      // observe performs no remote mutation at all, and acquiring the lease is
      // a `git push` of a new ref. Bail before it rather than after.
      if (cfg.autonomy === "observe") {
        this.#log("observe mode: selection only, no lease and no repository mutation");
        return finish("COMPLETED", { reason: "observe mode" });
      }

      budget.assertActive("claiming the issue");
      held = await this.#acquireLease({
        lease: input.lease,
        issueId: issue.identifier,
        runId,
        repo: target.repo,
        priorStateId: issue.state,
        ...(issue.assigneeId === undefined ? {} : { priorAssigneeId: issue.assigneeId }),
      });
      this.#advance(runId, "CLAIMED");

      await this.#withOutbox(runId, "backlog", "transition-claim", issue.identifier, assertLease, () =>
        this.#d.backlog.transitionState({
          identifier: issue.identifier,
          toState: cfg.backlog.claimState,
        }),
      );
      claimTransitioned = true;

      const claimAssignee = cfg.backlog.claimAssignee;
      if (claimAssignee !== undefined && issue.assigneeId !== claimAssignee) {
        await this.#withOutbox(
          runId,
          "backlog",
          "assign-claim",
          `${issue.identifier}#${claimAssignee}`,
          assertLease,
          () =>
            this.#d.backlog.assign({
              identifier: issue.identifier,
              assignee: claimAssignee,
            }),
        );
        assignmentChanged = true;
      }

      // -- workspace -----------------------------------------------------
      branch = cfg.github.branchTemplate
        .replace("{issue_identifier}", issue.identifier)
        .replace("{slug}", slugify(issue.title))
        .replace("{attempt}", String(attempt));

      workspace = await this.#workspaces.create({
        runId,
        sourceRepo: this.#d.sourceRepoPath,
        branch,
        baseBranch: target.baseBranch,
        ...(this.#d.sourceBaseRef === undefined
          ? {}
          : { sourceRef: this.#d.sourceBaseRef }),
        root: this.#d.workspaceRoot,
        isolation: cfg.workspace.gitIsolation,
      });
      this.#d.store.bindStandaloneWorkspace({
        runId,
        path: workspace.path,
        branch,
        baseCommit: workspace.baseCommit,
      });
      workspaceBound = true;
      this.#advance(runId, "WORKSPACE_READY");

      // These files are repository-controlled prompt input. Capture their
      // base-commit contents before implementation begins, then append them as
      // untrusted, narrowing-only guidance after the immutable rubric.
      const localReviewGuidance = await this.#reviewGuidance(
        cfg.review.localReviewSkill,
        workspace,
      );
      const prReviewGuidance = await this.#reviewGuidance(cfg.review.prReviewSkill, workspace);

      // -- task packet ---------------------------------------------------
      const packet = buildTaskPacket({
        runId,
        issue,
        target,
        baseCommit: workspace.baseCommit,
        branch,
        snapshotHash: issueSnapshot.fingerprint,
        requiredChecks: initialManifest.map((c) => c.id),
        network: cfg.workspace.network,
      });
      const packetPath = this.#workspaces.writeTaskPacket(workspace, packet);
      this.#workspaces.writeIssueDocument(workspace, renderIssueDocument(issue));
      this.#advance(runId, "TASK_PACKET_READY");

      // -- implement / verify / review loop -------------------------------
      let review: Review | undefined;
      let candidateSha = workspace.baseCommit;
      let prChecks: readonly { id: string; status: string }[] = [];

      for (let iteration = 0; iteration <= cfg.review.maxFixIterations; iteration += 1) {
        const role = iteration === 0 ? "implementer" : "fixer";
        this.#advance(runId, iteration === 0 ? "IMPLEMENTING" : "FIXING");

        const session = await this.#d.provider.start({
          runId,
          issueId: issue.identifier,
          role,
          attempt: iteration + 1,
          workingDirectory: workspace.path,
          taskPacketPath: packetPath,
          allowedPaths: packet.constraints.allowed_paths,
          forbiddenPaths: packet.constraints.forbidden_paths,
          allowedCommands: this.#codingToolInventory(),
          preparedDependencyPaths: this.#preparedDependencyPaths(workspace.path),
          network: cfg.workspace.network,
          maxTurns: cfg.providers.maxTurns,
          timeoutMs: providerTimeout(role),
        });
        const agentResult = await session.result;
        accountUsage(agentResult.events);

        if (agentResult.status !== "success") {
          // Carry the provider's own words. "returned failure" alone is true of
          // a bad credential, a sandbox that denied the binary, and a model that
          // gave up, and it sends the operator to read logs runmill already has.
          const failure = agentResult.error;
          const detail =
            failure === undefined
              ? ""
              : `: ${failure.class}${failure.detail === undefined ? "" : ` — ${failure.detail}`}`;
          return finish("NEEDS_HUMAN", {
            reason: `agent ${role} returned ${agentResult.status}${detail}`,
          });
        }

        // The orchestrator owns the commit. The agent never stages or commits.
        const sha = await this.#workspaces.checkpoint(
          workspace,
          `${issue.identifier}: ${role} iteration ${iteration + 1}`,
          {
            allowedPaths: packet.constraints.allowed_paths,
            forbiddenPaths: packet.constraints.forbidden_paths,
          },
        );
        if (sha !== undefined) {
          this.#d.store.setStandaloneCandidate({
            runId,
            expectedCandidateSha: candidateSha,
            candidateSha: sha,
          });
          candidateSha = sha;
        }

        // -- verify ------------------------------------------------------
        this.#advance(runId, "LOCAL_VERIFY");
        const changed = await this.#workspaces.changedFiles(workspace);
        let verification: Awaited<ReturnType<VerificationEngine["run"]>>;
        try {
          verification = await this.#verification.run({
            workspace,
            workspaces: this.#workspaces,
            manifest: resolveManifest({ configured: this.#d.checks, changedPaths: changed }),
            candidateSha,
            failOnMissingCheck: cfg.verification.failOnMissingCheck,
            failOnSkippedCheck: cfg.verification.failOnSkippedCheck,
          });
        } catch (cause) {
          this.#d.store.recordStandaloneVerification({
            runId,
            candidateSha,
            mergeReady: false,
            failures: [`verification execution failed: ${errorMessage(cause)}`],
            results: [],
          });
          throw cause;
        }
        this.#d.store.recordStandaloneVerification({
          runId,
          candidateSha,
          mergeReady: verification.mergeReady,
          failures: verification.failures,
          results: verification.results,
        });

        prChecks = verification.results.map((r) => ({
          id: r.checkId,
          status: `${r.status} (${r.coverage})`,
        }));
        for (const result of verification.results) {
          this.#log(`  check ${result.checkId}: ${result.status} (${result.coverage})`);
        }

        if (!verification.mergeReady) {
          if (iteration === cfg.review.maxFixIterations) {
            return finish("NEEDS_HUMAN", {
              reason:
                `verification failed after ${iteration + 1} attempts: ` +
                describeVerificationFailure(verification),
            });
          }
          continue;
        }

        // -- review ------------------------------------------------------
        this.#advance(runId, "LOCAL_REVIEW");
        const reviewSession = await this.#reviewer.start({
          runId,
          issueId: issue.identifier,
          role: "local-reviewer",
          attempt: iteration + 1,
          workingDirectory: workspace.path,
          taskPacketPath: packetPath,
          allowedPaths: [],
          forbiddenPaths: packet.constraints.forbidden_paths,
          allowedCommands: this.#codingToolInventory(),
          preparedDependencyPaths: this.#preparedDependencyPaths(workspace.path),
          network: cfg.workspace.network,
          maxTurns: cfg.providers.maxTurns,
          timeoutMs: providerTimeout("localReview"),
          ...(localReviewGuidance === undefined
            ? {}
            : { supplementalReviewGuidance: localReviewGuidance }),
        });
        const reviewResult = await reviewSession.result;
        accountUsage(reviewResult.events);

        if (reviewResult.status !== "success") {
          const detail = reviewResult.error?.detail;
          const explanation =
            `local reviewer returned ${reviewResult.status}` +
            (detail === undefined ? "" : `: ${detail}`);
          this.#d.store.recordStandaloneReview({
            runId,
            candidateSha,
            role: "local-reviewer",
            iteration: iteration + 1,
            status: "provider-failed",
            explanation,
          });
          return finish("NEEDS_HUMAN", {
            reason: explanation,
          });
        }
        const expectedLocalReviewOutput = outputPathFor(workspace.path, "local-reviewer");
        if (
          reviewResult.outputRef === undefined ||
          reviewResult.outputRef === "" ||
          reviewResult.outputRef !== expectedLocalReviewOutput
        ) {
          this.#d.store.recordStandaloneReview({
            runId,
            candidateSha,
            role: "local-reviewer",
            iteration: iteration + 1,
            status: "missing-output",
            explanation: "reviewer produced no structured output at the bound output path",
          });
          throw RunmillError.fromCatalog("RM-REVIEW-001", {
            whatHappened: "reviewer produced no structured output at the bound output path",
            runId,
          });
        }
        let reviewOutput: string;
        try {
          reviewOutput = readStructuredOutput(reviewResult.outputRef);
        } catch (cause) {
          this.#d.store.recordStandaloneReview({
            runId,
            candidateSha,
            role: "local-reviewer",
            iteration: iteration + 1,
            status: "invalid-output",
            explanation: `review output could not be read safely: ${errorMessage(cause)}`,
          });
          throw cause;
        }
        try {
          review = parseReviewJson(reviewOutput);
        } catch (cause) {
          this.#d.store.recordStandaloneReview({
            runId,
            candidateSha,
            role: "local-reviewer",
            iteration: iteration + 1,
            status: "invalid-output",
            outputText: reviewOutput,
            explanation: `review output was invalid: ${errorMessage(cause)}`,
          });
          throw cause;
        }

        const cross = crossCheckVerdict(
          review,
          changed,
          cfg.risk.manualApproval.paths,
          packet.acceptance_criteria,
        );
        const blocking = blockingFindings(
          review,
          cfg.review.mergeBlockingSeverities,
          cfg.review.requireAllFindingsResolved,
        );
        const reviewExplanation =
          !cross.accepted
            ? (cross.reason ?? "verdict rejected")
            : blocking.length > 0
              ? `${blocking.length} blocking finding(s) require another iteration`
              : "review and deterministic cross-check accepted the exact candidate";
        this.#d.store.recordStandaloneReview({
          runId,
          candidateSha,
          role: "local-reviewer",
          iteration: iteration + 1,
          status: "completed",
          outputText: reviewOutput,
          verdict: review.verdict,
          scopeAssessment: review.scope_assessment,
          accepted: cross.accepted,
          explanation: reviewExplanation,
          findings: review.findings,
        });
        this.#d.store.recordStandalonePolicyDecision({
          runId,
          candidateSha,
          inputs: {
            kind: "local-review-cross-check",
            role: "local-reviewer",
            iteration: iteration + 1,
            verdict: review.verdict,
            changed_paths: changed,
          },
          matched: {
            blocking_findings: blocking.map((finding) => finding.id),
            scope_assessment: review.scope_assessment,
          },
          outcome: !cross.accepted
            ? "refused"
            : blocking.length > 0
              ? "withheld"
              : "accepted",
          explanation: reviewExplanation,
        });
        if (!cross.accepted) {
          return finish("NEEDS_HUMAN", { reason: cross.reason ?? "verdict rejected" });
        }
        if (blocking.length === 0) break;

        this.#log(`  ${blocking.length} blocking finding(s); dispatching a fix`);
        if (iteration === cfg.review.maxFixIterations) {
          return finish("NEEDS_HUMAN", {
            reason: `${blocking.length} unresolved blocking finding(s) after ${iteration + 1} iterations`,
          });
        }
      }

      // -- pull request ---------------------------------------------------
      const beforeFirstPush = await this.#revalidateIssueAuthority({
        runId,
        stage: "before-first-push",
        initial: issue,
        target,
        candidateSha,
        claimTransitioned,
        assignmentChanged,
      });
      if (beforeFirstPush.blocked !== undefined) {
        return finish("NEEDS_HUMAN", { reason: beforeFirstPush.blocked });
      }
      this.#advance(runId, "PR_READY");
      budget.assertActive("pushing the candidate branch");
      await input.lease.assertHeld(held);

      // Set during workspace creation, long before this point.
      const pushBranch = branch;
      await this.#withOutbox(runId, "forge", "push", `${target.repo}#${pushBranch}`, assertLease, () =>
        this.#d.forge.push({ repo: target.repo, branch: pushBranch, workspacePath: workspace!.path }),
      );
      this.#advance(runId, "PUSHED");

      budget.assertActive("opening the pull request");
      await input.lease.assertHeld(held);
      const pr = await this.#withOutbox(runId, "forge", "open-pr", `${target.repo}#${pushBranch}`, assertLease, () =>
        this.#d.forge.openPullRequest({
          repo: target.repo,
          branch: pushBranch,
          baseBranch: target.baseBranch,
          title: `${issue.identifier}: ${issue.title}`,
          body: renderPullRequestBody({
            issue,
            review,
            runId,
            provider: cfg.providers.implementer.implementation,
            checks: prChecks,
          }),
          draft: cfg.github.draftPr,
        }),
        (opened) =>
          this.#d.store.recordStandalonePullRequest({
            runId,
            repo: target.repo,
            number: opened.number,
            headSha: opened.headSha,
            baseSha: opened.baseSha,
            draft: opened.draft,
            url: opened.url,
          }),
      );
      pullRequestOpened = true;
      this.#advance(runId, "PR_OPEN", `pr #${pr.number}`);

      if (pr.draft) {
        budget.assertActive("marking the pull request ready");
        await this.#withOutbox(
          runId,
          "forge",
          "mark-ready",
          `${target.repo}#${pr.number}`,
          assertLease,
          () => this.#d.forge.markReadyForReview({ repo: target.repo, number: pr.number }),
          () =>
            this.#d.store.recordStandalonePullRequest({
              runId,
              repo: target.repo,
              number: pr.number,
              headSha: pr.headSha,
              baseSha: pr.baseSha,
              draft: false,
              url: pr.url,
            }),
        );
      }

      // The PR API response and the pushed branch are separate observations.
      // Re-read the remote rather than trusting that they still agree.
      const exactBeforeCi = await this.#pullRequestAtCandidate({
        repo: target.repo,
        number: pr.number,
        candidateSha,
      });
      if (exactBeforeCi.blocked !== undefined) {
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason: exactBeforeCi.blocked,
        });
      }
      if (exactBeforeCi.pullRequest !== undefined) {
        this.#d.store.recordStandalonePullRequest({
          runId,
          repo: target.repo,
          number: exactBeforeCi.pullRequest.number,
          headSha: exactBeforeCi.pullRequest.headSha,
          baseSha: exactBeforeCi.pullRequest.baseSha,
          draft: exactBeforeCi.pullRequest.draft,
          url: exactBeforeCi.pullRequest.url,
          ...(exactBeforeCi.pullRequest.mergeSha === undefined
            ? {}
            : { mergeSha: exactBeforeCi.pullRequest.mergeSha }),
        });
      }

      // -- CI --------------------------------------------------------------
      this.#advance(runId, "CI_WAIT");
      const ci = await this.#waitForCi({
        target,
        candidateSha,
        lease: input.lease,
        held,
        budget,
      });
      if ("blocked" in ci) {
        this.#d.store.recordStandalonePolicyDecision({
          runId,
          candidateSha,
          inputs: { kind: "ci-reconciliation", required_contexts: [] },
          matched: { verdicts: [] },
          outcome: "refused",
          explanation: ci.blocked,
        });
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason: ci.blocked,
        });
      }
      let protection = ci.protection;
      const verdicts = ci.verdicts;
      this.#d.store.recordStandalonePolicyDecision({
        runId,
        candidateSha,
        inputs: {
          kind: "ci-reconciliation",
          required_contexts: protection.requiredChecks,
        },
        matched: {
          verdicts: [...verdicts].map(([context, verdict]) => ({
            context,
            state: verdict.state,
            detail: verdict.detail,
          })),
        },
        outcome: "accepted",
        explanation: "every required CI context is satisfied for the exact candidate",
      });

      // -- PR review --------------------------------------------------------
      //
      // A second fresh-context review of the same exact candidate, now with
      // orchestrator-owned PR identity and CI evidence. Runmill does not claim
      // to provide comments, a separate remote checkout, or a speculative
      // merge/rebase result; those absences are explicit in the evidence file.
      let prReviewOutcome: PrReviewOutcome;
      try {
        prReviewOutcome = await this.#runPrReview({
          runId,
          issue,
          target,
          pr,
          cfg,
          workspace,
          packetPath,
          packet,
          lease: input.lease,
          held,
          branch,
          candidateSha,
          protection,
          verdicts,
          budget,
          reviewGuidance: prReviewGuidance,
        });
      } finally {
        costUsd = budget.costUsd;
      }
      if (prReviewOutcome.blocked !== undefined) {
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason: prReviewOutcome.blocked,
        });
      }
      if (prReviewOutcome.review !== undefined) review = prReviewOutcome.review;
      if (prReviewOutcome.candidateSha !== undefined) candidateSha = prReviewOutcome.candidateSha;
      if (prReviewOutcome.protection !== undefined) protection = prReviewOutcome.protection;

      // -- deliver or merge -------------------------------------------------
      if (cfg.autonomy === "pr-only") {
        const beforeDelivery = await this.#revalidateIssueAuthority({
          runId,
          stage: "before-pr-delivery",
          initial: issue,
          target,
          candidateSha,
          claimTransitioned,
          assignmentChanged,
        });
        if (beforeDelivery.blocked !== undefined) {
          return finish("NEEDS_HUMAN", {
            prNumber: pr.number,
            prUrl: pr.url,
            reason: beforeDelivery.blocked,
          });
        }
        budget.assertActive("delivering the pull request");
        if (cfg.backlog.deliveredState !== undefined) {
          await this.#withOutbox(runId, "backlog", "transition-delivered", issue.identifier, assertLease, () =>
            this.#d.backlog.transitionState({
              identifier: issue.identifier,
              toState: cfg.backlog.deliveredState as string,
            }),
          );
        }
        await this.#withOutbox(runId, "backlog", "comment-delivered", issue.identifier, assertLease, () =>
          this.#d.backlog.comment({
            identifier: issue.identifier,
            body: `runmill opened ${pr.url} for this issue.\n\nRun: ${runId}`,
          }),
        );
        leaseReleaseAttempted = true;
        await this.#releaseLease(input.lease, held, issue.identifier, runId);
        held = undefined;
        return finish("PR_DELIVERED", { prNumber: pr.number, prUrl: pr.url });
      }

      // guarded-merge and continuous
      budget.assertActive("checking merge authority");
      // The production capability check attempts a no-op protection write.
      // It is still a remote mutation attempt, so journal and fence it like
      // every other effect instead of hiding it inside an observation path.
      const canWriteProtection = await this.#withOutbox(
        runId,
        "forge",
        "probe-protection-write",
        `${target.repo}#${target.baseBranch}`,
        assertLease,
        () =>
          this.#d.forge.canWriteBranchProtection({
            repo: target.repo,
            branch: target.baseBranch,
          }),
      );
      this.#d.store.recordStandalonePolicyDecision({
        runId,
        candidateSha,
        inputs: {
          kind: "branch-protection-write-capability",
          repo: target.repo,
          branch: target.baseBranch,
        },
        matched: { credential_can_write_protection: canWriteProtection },
        outcome: canWriteProtection ? "refused" : "accepted",
        explanation: canWriteProtection
          ? "merge credential can edit branch protection"
          : "no-op write probe proved the merge credential cannot edit branch protection",
      });
      if (canWriteProtection) {
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason:
            "the merge credential can edit branch protection, so a bypass-free merge is " +
            "unverifiable; merge modes stay locked until it cannot",
        });
      }

      const protectionOutcome: {
        readonly outcome: "accepted" | "withheld" | "refused";
        readonly explanation: string;
      } = protection.requiresApproval
        ? {
            outcome: "withheld",
            explanation: "branch protection requires an approving review",
          }
        : protection.usesMergeQueue
          ? {
              outcome: "refused",
              explanation:
                "branch protection requires a merge queue, but direct queue enrollment is unsupported",
            }
          : {
              outcome: "accepted",
              explanation: "branch protection permits the configured direct merge path",
            };
      this.#d.store.recordStandalonePolicyDecision({
        runId,
        candidateSha,
        inputs: {
          kind: "branch-protection-merge-requirements",
          requires_approval: protection.requiresApproval,
          requires_conversation_resolution: protection.requiresConversationResolution,
          uses_merge_queue: protection.usesMergeQueue,
        },
        matched: { decision: protectionOutcome.outcome },
        outcome: protectionOutcome.outcome,
        explanation: protectionOutcome.explanation,
      });
      if (protection.requiresApproval) {
        return finish("AWAITING_APPROVAL", { prNumber: pr.number, prUrl: pr.url });
      }
      if (protection.usesMergeQueue) {
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason:
            "branch protection requires a merge queue, but queue enrollment is not implemented; " +
            "refusing a direct merge",
        });
      }

      // -- risk policy ----------------------------------------------------
      // Models and reviewers cannot classify their own authority. The final
      // diff is read after PR review/fixing and evaluated against
      // operator-owned policy immediately before MERGE_READY. Every rule can
      // only withhold automatic merge; unknown conditions never disappear
      // into a permissive default.
      const riskChangedPaths = await this.#workspaces.changedFiles(workspace);
      const riskDecision = evaluateAutomaticMergeRisk(cfg.risk, {
        changedPaths: riskChangedPaths,
        issueLabels: issue.labels,
        acceptanceCriteria: packet.acceptance_criteria,
        checkManifestPath: cfg.verification.manifest,
      });
      const riskReasons =
        riskDecision.decision === "allow" ? [] : riskDecision.reasons;
      this.#d.store.recordStandalonePolicyDecision({
        runId,
        candidateSha,
        inputs: {
          kind: "automatic-merge-risk",
          changed_paths: riskChangedPaths,
          issue_labels: issue.labels,
          check_manifest_path: cfg.verification.manifest ?? null,
        },
        matched: { decision: riskDecision.decision, reasons: riskReasons },
        outcome:
          riskDecision.decision === "allow"
            ? "accepted"
            : riskDecision.decision === "manual-approval"
              ? "withheld"
              : "unknown",
        explanation:
          riskReasons.length === 0
            ? `risk policy decided ${riskDecision.decision}`
            : riskReasons.join("; "),
      });
      if (riskDecision.decision === "unknown") {
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason:
            "automatic-merge risk could not be evaluated deterministically — " +
            riskDecision.reasons.join("; "),
        });
      }
      if (riskDecision.decision === "manual-approval") {
        return finish("AWAITING_APPROVAL", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason: `manual approval required by risk policy — ${riskDecision.reasons.join("; ")}`,
        });
      }

      this.#advance(runId, "MERGE_READY");
      budget.assertActive("merging the pull request");
      await input.lease.assertHeld(held);
      const exactBeforeMerge = await this.#pullRequestAtCandidate({
        repo: target.repo,
        number: pr.number,
        candidateSha,
      });
      if (exactBeforeMerge.blocked !== undefined) {
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason: exactBeforeMerge.blocked,
        });
      }
      const mergePullRequest = exactBeforeMerge.pullRequest;
      if (mergePullRequest === undefined) {
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason: "pull request evidence disappeared before merge",
        });
      }
      this.#d.store.recordStandalonePullRequest({
        runId,
        repo: target.repo,
        number: mergePullRequest.number,
        headSha: mergePullRequest.headSha,
        baseSha: mergePullRequest.baseSha,
        draft: mergePullRequest.draft,
        url: mergePullRequest.url,
        ...(mergePullRequest.mergeSha === undefined
          ? {}
          : { mergeSha: mergePullRequest.mergeSha }),
      });
      const mergeability = await this.#d.forge.getMergeability({
        repo: target.repo,
        number: pr.number,
      });
      this.#d.store.recordStandalonePolicyDecision({
        runId,
        candidateSha,
        inputs: {
          kind: "pull-request-mergeability",
          repo: target.repo,
          number: pr.number,
        },
        matched: {
          state: mergeability.state,
          mergeable: mergeability.mergeable,
          requires_conversation_resolution: protection.requiresConversationResolution,
        },
        outcome:
          mergeability.mergeable && mergeability.state === "clean"
            ? "accepted"
            : "refused",
        explanation:
          mergeability.mergeable && mergeability.state === "clean"
            ? "pull request is clean and mergeable"
            : `pull request is ${mergeability.state}, not clean and mergeable`,
      });
      if (!mergeability.mergeable || mergeability.state !== "clean") {
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason:
            `GitHub reports the pull request as ${mergeability.state}, not clean and mergeable` +
            (protection.requiresConversationResolution
              ? "; required conversation resolution could not be proven"
              : ""),
        });
      }
      const beforeMerge = await this.#revalidateIssueAuthority({
        runId,
        stage: "before-merge",
        initial: issue,
        target,
        candidateSha,
        claimTransitioned,
        assignmentChanged,
      });
      if (beforeMerge.blocked !== undefined) {
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason: beforeMerge.blocked,
        });
      }
      const merged = await this.#withOutbox(
        runId,
        "forge",
        "merge",
        `${target.repo}#${pr.number}`,
        assertLease,
        () =>
          this.#d.forge.merge({
            repo: target.repo,
            number: pr.number,
            method: cfg.github.merge.method,
            expectedHeadSha: candidateSha,
          }),
        (result) =>
          this.#d.store.recordStandalonePullRequest({
            runId,
            repo: target.repo,
            number: mergePullRequest.number,
            headSha: mergePullRequest.headSha,
            baseSha: mergePullRequest.baseSha,
            draft: false,
            url: mergePullRequest.url,
            mergeSha: result.mergeSha,
          }),
      );
      this.#advance(runId, "MERGED", merged.mergeSha);

      if (cfg.backlog.completedState !== undefined) {
        await this.#withOutbox(runId, "backlog", "transition-complete", issue.identifier, assertLease, () =>
          this.#d.backlog.transitionState({
            identifier: issue.identifier,
            toState: cfg.backlog.completedState as string,
          }),
        );
      }
      this.#advance(runId, "BACKLOG_UPDATED");

      leaseReleaseAttempted = true;
      await this.#releaseLease(input.lease, held, issue.identifier, runId);
      held = undefined;
      this.#advance(runId, "CLEANUP");
      return finish("COMPLETED", {
        prNumber: pr.number,
        prUrl: pr.url,
        mergeSha: merged.mergeSha,
      });
    } catch (err) {
      if (err instanceof TerminalStatePersistenceError || !runCreated) {
        throw err;
      }
      // RunmillError's message is `CODE Title`, which names the category and
      // not the event. "Review output did not match the schema" is the same
      // sentence whether the reviewer emitted the wrong shape or emitted
      // nothing at all, and those point at completely different causes, so the
      // specific line goes into the reason too.
      const reason =
        err instanceof RunmillError && err.whatHappened !== ""
          ? `${errorMessage(err)}: ${err.whatHappened.trim().split("\n")[0] ?? ""}`
          : errorMessage(err);
      this.#log(`run failed: ${reason}`);
      return finish(
        err instanceof RunmillError &&
          (err.code === "RM-PROVIDER-002" || err.code === "RM-STATE-002")
          ? "NEEDS_HUMAN"
          : "QUARANTINED",
        { reason },
      );
    } finally {
      // The workspace is deliberately preserved on a non-clean exit so a human
      // can inspect it. PR_DELIVERED is a clean exit — it is how every
      // successful run ends in `pr-only`, the default mode — so omitting it
      // meant the default configuration never reclaimed a single workspace.
      if (workspace !== undefined && isCleanExitRunState(this.#state)) {
        await this.#workspaces.destroy(workspace, this.#d.sourceRepoPath);
        if (workspaceBound) {
          this.#d.store.markStandaloneWorkspace(runId, "destroyed");
        }
      } else if (workspace !== undefined && workspaceBound) {
        this.#d.store.markStandaloneWorkspace(runId, "preserved");
      }
      if (held !== undefined && !leaseReleaseAttempted) {
        const heldForRestore = held;
        let unresolvedEffects = this.#d.store
          .pendingSideEffects()
          .some((effect) => effect.runId === runId);
        let releaseSafe = !unresolvedEffects;
        // Before a PR exists, a failed attempt should be selectable again.
        // Restore the workflow ownership while the lease still fences us. If
        // the triggering mutation was ambiguous, retain the distributed fence:
        // a local outbox row cannot stop another host from selecting the issue.
        if (
          !unresolvedEffects &&
          claimTransitioned &&
          !pullRequestOpened &&
          !isCleanExitRunState(this.#state)
        ) {
          try {
            if (assignmentChanged) {
              await this.#withOutbox(
                runId,
                "backlog",
                "restore-assignee",
                `${issue.identifier}#${heldForRestore.priorAssigneeId ?? "unassigned"}`,
                assertLease,
                () =>
                  this.#d.backlog.assign({
                    identifier: issue.identifier,
                    assignee: heldForRestore.priorAssigneeId ?? null,
                  }),
              );
            }
            await this.#withOutbox(
              runId,
              "backlog",
              "restore-state",
              `${issue.identifier}#${heldForRestore.priorStateId ?? issue.state}`,
              assertLease,
              () =>
                this.#d.backlog.transitionState({
                  identifier: issue.identifier,
                  toState: heldForRestore.priorStateId ?? issue.state,
                }),
            );
          } catch (restoreError) {
            releaseSafe = false;
            this.#log(`could not restore backlog ownership: ${errorMessage(restoreError)}`);
          }
        }
        // A restoration request can itself have an ambiguous outcome. Re-read
        // the journal after compensation before deciding whether release is
        // safe; only an exact absence proof may later clear a retained fence.
        unresolvedEffects = this.#d.store
          .pendingSideEffects()
          .some((effect) => effect.runId === runId);
        releaseSafe = releaseSafe && !unresolvedEffects;
        if (!releaseSafe) {
          this.#log(
            `retaining the lease for ${issue.identifier}: an external effect or ownership ` +
              "restoration has not been proven complete",
          );
        } else {
          try {
            leaseReleaseAttempted = true;
            await this.#releaseLease(input.lease, held, issue.identifier, runId);
          } catch (releaseError) {
            this.#log(
              `lease release remains unresolved and continues to fence the issue: ` +
                errorMessage(releaseError),
            );
          }
        }
      }
    }
  }

  /**
   * Review the pull request, and fix what the review blocks on.
   *
   * Bounded by two independent budgets: `pr_review` caps how many times a
   * reviewer runs, `pr_fixer` caps how many times a fix runs. An oscillating
   * pair — reviewer objects, fixer "fixes", reviewer objects again — exhausts
   * the fixer budget and escalates rather than billing indefinitely.
   *
   * Every push inside the loop is fenced. The pull request is a live artifact
   * other people may be looking at, so a run that has lost its lease must not
   * keep amending it.
   */
  async #runPrReview(input: PrReviewInput): Promise<PrReviewOutcome> {
    const { runId, issue, target, pr, cfg, workspace, packetPath, packet } = input;
    const invocationLimits = cfg.budgets.maxAgentInvocations;
    const maxFixes = Math.max(0, invocationLimits.prFixer);
    const maxReviews = Math.max(1, invocationLimits.prReview);

    let review: Review | undefined;
    let candidateSha = input.candidateSha;
    let protection = input.protection;
    let verdicts = input.verdicts;

    for (let attempt = 0; attempt < maxReviews; attempt += 1) {
      input.budget.assertActive("reading pull request evidence");
      const exact = await this.#pullRequestAtCandidate({
        repo: target.repo,
        number: pr.number,
        candidateSha,
      });
      if (exact.blocked !== undefined || exact.pullRequest === undefined) {
        return {
          blocked: exact.blocked ?? "pull request evidence could not be established",
        };
      }
      this.#d.store.recordStandalonePullRequest({
        runId,
        repo: target.repo,
        number: exact.pullRequest.number,
        headSha: exact.pullRequest.headSha,
        baseSha: exact.pullRequest.baseSha,
        draft: exact.pullRequest.draft,
        url: exact.pullRequest.url,
        ...(exact.pullRequest.mergeSha === undefined
          ? {}
          : { mergeSha: exact.pullRequest.mergeSha }),
      });

      const evidenceText = serializePullRequestEvidence(
        buildPullRequestEvidence({
          generatedAt: this.#d.clock.now().toISOString(),
          repository: target.repo,
          candidateSha,
          pullRequest: exact.pullRequest,
          requiredContexts: protection.requiredChecks,
          verdicts,
        }),
      );
      const evidencePath = join(workspace.path, PR_EVIDENCE_PATH);
      writeFileSync(evidencePath, evidenceText);
      this.#advance(runId, "PR_REVIEW");

      const session = await this.#reviewer.start({
        runId,
        issueId: issue.identifier,
        role: "pr-reviewer",
        attempt: attempt + 1,
        workingDirectory: workspace.path,
        taskPacketPath: packetPath,
        // A reviewer reads. Granting write paths to something whose only job is
        // to form an opinion is how a review starts editing the thing it judges.
        allowedPaths: [],
        forbiddenPaths: packet.constraints.forbidden_paths,
        allowedCommands: this.#codingToolInventory(),
        preparedDependencyPaths: this.#preparedDependencyPaths(workspace.path),
        network: cfg.workspace.network,
        maxTurns: cfg.providers.maxTurns,
        timeoutMs: input.budget.beginInvocation(
          "prReview",
          cfg.providers.timeoutMinutes * 60_000,
        ),
        ...(input.reviewGuidance === undefined
          ? {}
          : { supplementalReviewGuidance: input.reviewGuidance }),
      });
      const result = await session.result;
      input.budget.finishInvocation(result.events);

      if (result.status !== "success") {
        const explanation = `PR reviewer returned ${result.status}`;
        this.#d.store.recordStandaloneReview({
          runId,
          candidateSha,
          role: "pr-reviewer",
          iteration: attempt + 1,
          status: "provider-failed",
          explanation,
        });
        return { blocked: explanation };
      }
      const expectedPrReviewOutput = outputPathFor(workspace.path, "pr-reviewer");
      if (
        result.outputRef === undefined ||
        result.outputRef === "" ||
        result.outputRef !== expectedPrReviewOutput
      ) {
        this.#d.store.recordStandaloneReview({
          runId,
          candidateSha,
          role: "pr-reviewer",
          iteration: attempt + 1,
          status: "missing-output",
          explanation: "PR reviewer produced no structured output",
        });
        return { blocked: "PR reviewer produced no structured output" };
      }
      try {
        if (readFileSync(evidencePath, "utf8") !== evidenceText) {
          this.#d.store.recordStandaloneReview({
            runId,
            candidateSha,
            role: "pr-reviewer",
            iteration: attempt + 1,
            status: "invalid-output",
            explanation: "PR reviewer modified its orchestrator-owned evidence",
          });
          return {
            blocked: "PR reviewer modified its orchestrator-owned evidence; refusing the review",
          };
        }
      } catch {
        this.#d.store.recordStandaloneReview({
          runId,
          candidateSha,
          role: "pr-reviewer",
          iteration: attempt + 1,
          status: "invalid-output",
          explanation: "PR reviewer removed its orchestrator-owned evidence",
        });
        return {
          blocked: "PR reviewer removed its orchestrator-owned evidence; refusing the review",
        };
      }

      let reviewOutput: string;
      try {
        reviewOutput = readStructuredOutput(result.outputRef);
      } catch (err) {
        const explanation = `PR review output could not be read safely: ${errorMessage(err)}`;
        this.#d.store.recordStandaloneReview({
          runId,
          candidateSha,
          role: "pr-reviewer",
          iteration: attempt + 1,
          status: "invalid-output",
          explanation,
        });
        return { blocked: explanation };
      }
      try {
        review = parseReviewJson(reviewOutput);
      } catch (err) {
        // An unparseable review is not an absent review: it is a review whose
        // conclusion is unknown, and unknown is not permission to merge.
        const explanation = `PR review output was unparseable: ${errorMessage(err)}`;
        this.#d.store.recordStandaloneReview({
          runId,
          candidateSha,
          role: "pr-reviewer",
          iteration: attempt + 1,
          status: "invalid-output",
          outputText: reviewOutput,
          explanation,
        });
        return { blocked: explanation };
      }

      const changed = await this.#workspaces.changedFiles(workspace);
      const cross = crossCheckVerdict(
        review,
        changed,
        cfg.risk.manualApproval.paths,
        input.packet.acceptance_criteria,
      );
      const blocking = blockingFindings(
        review,
        cfg.review.mergeBlockingSeverities,
        cfg.review.requireAllFindingsResolved,
      );
      const reviewExplanation =
        !cross.accepted
          ? (cross.reason ?? "PR review verdict rejected")
          : blocking.length > 0
            ? `${blocking.length} blocking PR-review finding(s) require a fix`
            : "PR review and deterministic cross-check accepted the exact candidate";
      this.#d.store.recordStandaloneReview({
        runId,
        candidateSha,
        role: "pr-reviewer",
        iteration: attempt + 1,
        status: "completed",
        outputText: reviewOutput,
        verdict: review.verdict,
        scopeAssessment: review.scope_assessment,
        accepted: cross.accepted,
        explanation: reviewExplanation,
        findings: review.findings,
      });
      this.#d.store.recordStandalonePolicyDecision({
        runId,
        candidateSha,
        inputs: {
          kind: "pr-review-cross-check",
          role: "pr-reviewer",
          iteration: attempt + 1,
          verdict: review.verdict,
          changed_paths: changed,
        },
        matched: {
          blocking_findings: blocking.map((finding) => finding.id),
          scope_assessment: review.scope_assessment,
        },
        outcome: !cross.accepted
          ? "refused"
          : blocking.length > 0
            ? "withheld"
            : "accepted",
        explanation: reviewExplanation,
      });
      if (!cross.accepted) {
        return { blocked: cross.reason ?? "PR review verdict rejected" };
      }
      if (blocking.length === 0) return { review, candidateSha, protection };

      this.#log(`  PR review: ${blocking.length} blocking finding(s)`);
      if (attempt >= maxFixes) {
        return {
          blocked:
            `${blocking.length} blocking PR-review finding(s) unresolved after ` +
            `${attempt + 1} review(s): ${blocking.map((f) => f.title).join("; ")}`,
        };
      }

      // -- fix, then amend the pull request -------------------------------
      // Reviewer artifacts are evidence inputs/outputs, not candidate source.
      // Remove them before checkpointing a fix so they cannot enter the diff
      // or trip the task's always-forbidden `.runmill/**` scope rule.
      rmSync(evidencePath, { force: true });
      rmSync(result.outputRef, { force: true });
      this.#advance(runId, "FIXING");
      const fixSession = await this.#d.provider.start({
        runId,
        issueId: issue.identifier,
        role: "fixer",
        attempt: attempt + 1,
        workingDirectory: workspace.path,
        taskPacketPath: packetPath,
        allowedPaths: packet.constraints.allowed_paths,
        forbiddenPaths: packet.constraints.forbidden_paths,
        allowedCommands: this.#codingToolInventory(),
        preparedDependencyPaths: this.#preparedDependencyPaths(workspace.path),
        network: cfg.workspace.network,
        maxTurns: cfg.providers.maxTurns,
        timeoutMs: input.budget.beginInvocation(
          "prFixer",
          cfg.providers.timeoutMinutes * 60_000,
        ),
      });
      const fixResult = await fixSession.result;
      input.budget.finishInvocation(fixResult.events);
      if (fixResult.status !== "success") {
        return { blocked: `PR fixer returned ${fixResult.status}` };
      }

      const sha = await this.#workspaces.checkpoint(
        workspace,
        `${issue.identifier}: pr-review fix ${attempt + 1}`,
        {
          allowedPaths: packet.constraints.allowed_paths,
          forbiddenPaths: packet.constraints.forbidden_paths,
        },
      );
      if (sha === undefined) {
        // Nothing changed, so the next review would reach the same verdict.
        return {
          blocked: "PR fixer produced no change, so the blocking findings still stand",
        };
      }
      this.#d.store.setStandaloneCandidate({
        runId,
        expectedCandidateSha: candidateSha,
        candidateSha: sha,
      });
      candidateSha = sha;

      // The change must be re-verified before it goes back onto the PR: a fix
      // is new code, and new code has not been through the coverage contract.
      this.#advance(runId, "LOCAL_VERIFY");
      let reverified: Awaited<ReturnType<VerificationEngine["run"]>>;
      try {
        reverified = await this.#verification.run({
          workspace,
          workspaces: this.#workspaces,
          manifest: resolveManifest({
            configured: this.#d.checks,
            changedPaths: await this.#workspaces.changedFiles(workspace),
          }),
          candidateSha,
          failOnMissingCheck: cfg.verification.failOnMissingCheck,
          failOnSkippedCheck: cfg.verification.failOnSkippedCheck,
        });
      } catch (cause) {
        this.#d.store.recordStandaloneVerification({
          runId,
          candidateSha,
          mergeReady: false,
          failures: [`verification execution failed after PR fix: ${errorMessage(cause)}`],
          results: [],
        });
        throw cause;
      }
      this.#d.store.recordStandaloneVerification({
        runId,
        candidateSha,
        mergeReady: reverified.mergeReady,
        failures: reverified.failures,
        results: reverified.results,
      });
      if (!reverified.mergeReady) {
        return {
          blocked: `verification failed after a PR-review fix: ${reverified.failures.join("; ")}`,
        };
      }

      await input.lease.assertHeld(input.held);
      input.budget.assertActive("pushing a PR-review fix");
      await this.#withOutbox(
        runId,
        "forge",
        "push-pr-fix",
        `${target.repo}#${input.branch}@${candidateSha}`,
        () => input.lease.assertHeld(input.held),
        () =>
          this.#d.forge.push({
            repo: target.repo,
            branch: input.branch,
            workspacePath: workspace.path,
          }),
      );
      this.#log(`  pushed PR-review fix ${attempt + 1} to #${pr.number}`);

      const exactAfterFix = await this.#pullRequestAtCandidate({
        repo: target.repo,
        number: pr.number,
        candidateSha,
      });
      if (exactAfterFix.blocked !== undefined) {
        return { blocked: exactAfterFix.blocked };
      }
      if (exactAfterFix.pullRequest === undefined) {
        return { blocked: "pull request evidence disappeared after the PR-review fix" };
      }
      this.#d.store.recordStandalonePullRequest({
        runId,
        repo: target.repo,
        number: exactAfterFix.pullRequest.number,
        headSha: exactAfterFix.pullRequest.headSha,
        baseSha: exactAfterFix.pullRequest.baseSha,
        draft: exactAfterFix.pullRequest.draft,
        url: exactAfterFix.pullRequest.url,
        ...(exactAfterFix.pullRequest.mergeSha === undefined
          ? {}
          : { mergeSha: exactAfterFix.pullRequest.mergeSha }),
      });

      // A new commit invalidates the old CI evidence. Wait again and carry
      // only verdicts bound to the fixed candidate into the next review.
      this.#advance(runId, "CI_WAIT");
      const ci = await this.#waitForCi({
        target,
        candidateSha,
        lease: input.lease,
        held: input.held,
        budget: input.budget,
      });
      if ("blocked" in ci) {
        this.#d.store.recordStandalonePolicyDecision({
          runId,
          candidateSha,
          inputs: { kind: "ci-reconciliation-after-pr-fix", required_contexts: [] },
          matched: { verdicts: [] },
          outcome: "refused",
          explanation: ci.blocked,
        });
        return { blocked: ci.blocked };
      }
      protection = ci.protection;
      verdicts = ci.verdicts;
      this.#d.store.recordStandalonePolicyDecision({
        runId,
        candidateSha,
        inputs: {
          kind: "ci-reconciliation-after-pr-fix",
          required_contexts: protection.requiredChecks,
        },
        matched: {
          verdicts: [...verdicts].map(([context, verdict]) => ({
            context,
            state: verdict.state,
            detail: verdict.detail,
          })),
        },
        outcome: "accepted",
        explanation: "every required CI context is satisfied for the fixed exact candidate",
      });
    }

    return {
      blocked: `PR review did not converge within ${maxReviews} review(s)`,
    };
  }
}

interface PrReviewInput {
  readonly runId: string;
  readonly issue: BacklogIssue;
  readonly target: RepositoryTarget;
  readonly pr: PullRequest;
  readonly cfg: RunmillConfig;
  readonly workspace: Workspace;
  readonly packetPath: string;
  readonly packet: {
    acceptance_criteria: readonly string[];
    constraints: { allowed_paths: readonly string[]; forbidden_paths: readonly string[] };
  };
  readonly lease: GitRefLease;
  readonly held: HeldLease;
  readonly branch: string;
  readonly candidateSha: string;
  readonly protection: BranchProtection;
  readonly verdicts: ReadonlyMap<string, ReconcileVerdict>;
  readonly budget: RunBudget;
  readonly reviewGuidance?: { readonly source: string; readonly content: string } | undefined;
}

interface PrReviewOutcome {
  /** Set when the run must escalate; the string is the reason. */
  readonly blocked?: string | undefined;
  readonly review?: Review | undefined;
  readonly candidateSha?: string | undefined;
  readonly protection?: BranchProtection | undefined;
}

/** Bound on how long a required check may go unscheduled before escalating. */
const CI_SCHEDULE_DEADLINE_MS = 10 * 60_000;

/** How often CI_WAIT re-reads the required checks while they are still running. */
const CI_POLL_INTERVAL_MS = 15_000;

/** Repository guidance is copied into a provider command-line prompt. */
const MAX_REVIEW_GUIDANCE_BYTES = 64 * 1024;

/**
 * Terminal states after which the workspace holds nothing a human needs.
 *
 * Everything else — NEEDS_HUMAN, QUARANTINED, AWAITING_APPROVAL — keeps its
 * workspace, because the tree is the evidence for whatever has to be decided.
 */
export const CLEAN_EXIT_RUN_STATES = Object.freeze([
  "COMPLETED",
  "PR_DELIVERED",
] as const);
const CLEAN_EXIT_RUN_STATE_SET: ReadonlySet<string> = new Set(CLEAN_EXIT_RUN_STATES);

export function isCleanExitRunState(state: string): boolean {
  return CLEAN_EXIT_RUN_STATE_SET.has(state);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Why verification refused, in one line.
 *
 * `failures` carries policy violations -- a missing command, a focused subset,
 * an undeclared skip. A check that simply exited non-zero is not one of those,
 * so the most ordinary failure of all produced an empty string and the run
 * reported "verification failed after 4 attempts:" with nothing after the
 * colon. Naming the checks that failed costs one line and is the difference
 * between a run an operator can act on and one they have to re-derive.
 */
function describeVerificationFailure(verification: {
  readonly failures: readonly string[];
  readonly results: readonly { readonly checkId: string; readonly status: string }[];
}): string {
  const failed = verification.results
    .filter((result) => result.status === "failed")
    .map((result) => `check "${result.checkId}" failed`);
  const all = [...failed, ...verification.failures];
  return all.length === 0 ? "no check produced a merge-ready result" : all.join("; ");
}
