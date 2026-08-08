import { join } from "node:path";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import type { BacklogAdapter } from "../backlog/adapter.js";
import type { CodingAgentAdapter } from "../agent/adapter.js";
import type { ForgeAdapter } from "../pr/adapter.js";
import type { RunmillConfig } from "../config/types.js";
import type { StateStore } from "../state/store.js";
import type { Clock } from "../platform/clock.js";
import type { BacklogIssue, RepositoryTarget } from "../domain/types.js";
import { WorkspaceManager, type Workspace } from "../workspace/manager.js";
import { VerificationEngine, resolveManifest, type CheckSpec } from "../verification/engine.js";
import { buildTaskPacket, renderIssueDocument } from "../agent/task-packet.js";
import { parseReviewJson, blockingFindings, crossCheckVerdict, type Review } from "../review/schema.js";
import { reconcileChecks, type CheckMapping } from "../pr/reconcile.js";
import { GitRefLease, type HeldLease } from "../queue/git-lease.js";
import { accumulateUsage } from "../agent/events.js";
import { RunmillError , errorMessage } from "../errors/runmill-error.js";
import { renderPullRequestBody } from "./pr-body.js";
import { outputContractFor } from "../agent/output-contract.js";
import { snapshotHash } from "../domain/snapshot.js";
import { RunLog } from "../state/run-log.js";

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
  readonly verification?: VerificationEngine | undefined;
  readonly sourceRepoPath: string;
  readonly workspaceRoot: string;
  readonly checks: readonly CheckSpec[];
  readonly checkMappings?: readonly CheckMapping[] | undefined;
  readonly onEvent?: ((message: string) => void) | undefined;
}

export interface RunOutcome {
  readonly runId: string;
  readonly issueId: string;
  readonly finalState: RunState;
  /** Branch this run pushed, and the base a stacked layer builds on. */
  readonly branch?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly prUrl?: string | undefined;
  readonly mergeSha?: string | undefined;
  readonly costUsd: number;
  readonly reason?: string | undefined;
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
    this.#verification = deps.verification ?? new VerificationEngine();
    this.#runLog = new RunLog(join(deps.sourceRepoPath, ".runmill", "log.md"));
  }

  /** The adapter that runs review roles. Falls back to the implementer's. */
  get #reviewer(): CodingAgentAdapter {
    return this.#d.reviewProvider ?? this.#d.provider;
  }

  #log(message: string): void {
    this.#d.onEvent?.(message);
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

  /** Intent, then act, then confirm. Never act first. */
  async #withOutbox<T>(
    runId: string,
    system: string,
    operation: string,
    target: string,
    act: () => Promise<T>,
  ): Promise<T> {
    const key = this.#d.store.intendSideEffect({ runId, system, operation, target });
    this.#d.store.markSideEffectInFlight(key);
    try {
      const result = await act();
      this.#d.store.confirmSideEffect(key);
      return result;
    } catch (err) {
      // Failure does not prove the effect did not land; the row stays pending
      // so the recovery sweep reconciles it against the remote.
      this.#d.store.failSideEffect(key, errorMessage(err));
      throw err;
    }
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
    let branch: string | undefined;
    let costUsd = 0;
    let logged = false;

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
        } catch {
          // The run row may not exist yet (failure during createRun). The
          // outcome is still returned truthfully.
        }
      }
      const outcome: RunOutcome = {
        runId,
        issueId: issue.identifier,
        finalState: state,
        costUsd,
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
          this.#log(`could not append .runmill/log.md: ${errorMessage(err)}`);
        }
      }
      return outcome;
    };

    try {
      this.#d.store.createRun({
        runId,
        issueId: issue.identifier,
        repo: target.repo,
        provider: cfg.providers.implementer.implementation,
      });
      this.#advance(runId, "ELIGIBILITY_CHECKED");

      // -- claim ---------------------------------------------------------
      // observe performs no remote mutation at all, and acquiring the lease is
      // a `git push` of a new ref. Bail before it rather than after.
      if (cfg.autonomy === "observe") {
        this.#log("observe mode: selection only, no lease and no repository mutation");
        return finish("COMPLETED", { reason: "observe mode" });
      }

      held = await input.lease.acquire(issue.identifier, {
        priorStateId: issue.state,
        ...(issue.assigneeId === undefined ? {} : { priorAssigneeId: issue.assigneeId }),
      });
      this.#d.store.recordLease({
        issueId: issue.identifier,
        runId,
        repo: target.repo,
        generation: held.generation,
        expiresAt: held.expiresAt,
        refName: held.refName,
      });
      this.#advance(runId, "CLAIMED");

      await this.#withOutbox(runId, "backlog", "transition-claim", issue.identifier, () =>
        this.#d.backlog.transitionState({
          identifier: issue.identifier,
          toState: cfg.backlog.claimState,
        }),
      );

      // -- workspace -----------------------------------------------------
      branch = cfg.github.branchTemplate
        .replace("{issue_identifier}", issue.identifier)
        .replace("{slug}", slugify(issue.title))
        .replace("{attempt}", "1");

      workspace = await this.#workspaces.create({
        runId,
        sourceRepo: this.#d.sourceRepoPath,
        branch,
        baseBranch: target.baseBranch,
        root: this.#d.workspaceRoot,
        isolation: cfg.workspace.gitIsolation === "clone" ? "clone" : "separate-git-dir",
      });
      this.#advance(runId, "WORKSPACE_READY");

      // -- task packet ---------------------------------------------------
      const snapshot = snapshotHash(issue);
      this.#d.store.appendEvent({
        runId,
        seq: 1,
        type: "issue.snapshot",
        payload: { identifier: issue.identifier, snapshotHash: snapshot },
      });

      const manifest = resolveManifest({
        configured: this.#d.checks,
        changedPaths: [],
      });
      const packet = buildTaskPacket({
        runId,
        issue,
        target,
        baseCommit: workspace.baseCommit,
        branch,
        snapshotHash: snapshot,
        requiredChecks: manifest.map((c) => c.id),
        network: cfg.workspace.network,
      });
      const packetPath = this.#workspaces.writeTaskPacket(workspace, packet);
      mkdirSync(join(workspace.path, ".runmill", "run"), { recursive: true });
      writeFileSync(join(workspace.path, ".runmill", "run", "issue.md"), renderIssueDocument(issue));
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
          allowedCommands: [],
          network: cfg.workspace.network,
          maxTurns: cfg.providers.maxTurns,
          timeoutMs: cfg.providers.timeoutMinutes * 60_000,
        });
        const agentResult = await session.result;
        costUsd += accumulateUsage(agentResult.events).costUsd;

        if (agentResult.status !== "success") {
          return finish("NEEDS_HUMAN", {
            reason: `agent ${role} returned ${agentResult.status}`,
          });
        }

        // The orchestrator owns the commit. The agent never stages or commits.
        const sha = await this.#workspaces.checkpoint(
          workspace,
          `${issue.identifier}: ${role} iteration ${iteration + 1}`,
        );
        if (sha !== undefined) candidateSha = sha;

        // -- verify ------------------------------------------------------
        this.#advance(runId, "LOCAL_VERIFY");
        const changed = await this.#workspaces.changedFiles(workspace);
        const verification = await this.#verification.run({
          workspace,
          workspaces: this.#workspaces,
          manifest: resolveManifest({ configured: this.#d.checks, changedPaths: changed }),
          candidateSha,
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
              reason: `verification failed after ${iteration + 1} attempts: ${verification.failures.join("; ")}`,
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
          allowedCommands: [],
          network: cfg.workspace.network,
          maxTurns: cfg.providers.maxTurns,
          timeoutMs: cfg.providers.timeoutMinutes * 60_000,
        });
        const reviewResult = await reviewSession.result;
        costUsd += accumulateUsage(reviewResult.events).costUsd;

        if (reviewResult.outputRef === undefined || reviewResult.outputRef === "") {
          throw RunmillError.fromCatalog("RM-REVIEW-001", {
            whatHappened: "reviewer produced no structured output",
            runId,
          });
        }
        review = parseReviewJson(readFileSync(reviewResult.outputRef, "utf8"));

        const cross = crossCheckVerdict(
          review,
          changed,
          cfg.risk.manualApproval.paths,
          packet.acceptance_criteria,
        );
        if (!cross.accepted) {
          return finish("NEEDS_HUMAN", { reason: cross.reason ?? "verdict rejected" });
        }

        const blocking = blockingFindings(review, cfg.review.mergeBlockingSeverities);
        if (blocking.length === 0) break;

        this.#log(`  ${blocking.length} blocking finding(s); dispatching a fix`);
        if (iteration === cfg.review.maxFixIterations) {
          return finish("NEEDS_HUMAN", {
            reason: `${blocking.length} unresolved blocking finding(s) after ${iteration + 1} iterations`,
          });
        }
      }

      // -- pull request ---------------------------------------------------
      this.#advance(runId, "PR_READY");
      await input.lease.assertHeld(held);

      // Set during workspace creation, long before this point.
      const pushBranch = branch as string;
      await this.#withOutbox(runId, "forge", "push", `${target.repo}#${pushBranch}`, () =>
        this.#d.forge.push({ repo: target.repo, branch: pushBranch, workspacePath: workspace!.path }),
      );
      this.#advance(runId, "PUSHED");

      await input.lease.assertHeld(held);
      const pr = await this.#withOutbox(runId, "forge", "open-pr", `${target.repo}#${pushBranch}`, () =>
        this.#d.forge.openPullRequest({
          repo: target.repo,
          branch: pushBranch,
          baseBranch: target.baseBranch,
          title: `${issue.identifier}: ${issue.title}`,
          body: renderPullRequestBody({
            issue,
            review: review as Review,
            runId,
            provider: cfg.providers.implementer.implementation,
            checks: prChecks,
          }),
          draft: cfg.github.draftPr,
        }),
      );
      this.#advance(runId, "PR_OPEN", `pr #${pr.number}`);

      if (pr.draft) {
        await this.#d.forge.markReadyForReview({ repo: target.repo, number: pr.number });
      }

      // -- CI --------------------------------------------------------------
      this.#advance(runId, "CI_WAIT");
      const ciWaitStartedMs = this.#d.clock.now().getTime();
      const protection = await this.#d.forge.getBranchProtection({
        repo: target.repo,
        branch: target.baseBranch,
      });

      // Unreadable rules are not absent rules. A 403 on the protection
      // endpoint is common (it needs admin), and treating the empty result as
      // "nothing is required" would let a run sail through the merge gate on
      // the strength of a permission error.
      if (protection.unreadable) {
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason:
            "branch protection could not be read, so required checks and approvals are " +
            "unknown; refusing to treat unreadable rules as absent rules",
        });
      }
      const observed = await this.#d.forge.listChecks({ repo: target.repo, ref: pr.headSha });
      const verdicts = reconcileChecks({
        requiredContexts: protection.requiredChecks,
        // Identity by default: the context name IS the check name until an
        // explicit mapping says otherwise. Without this every context is
        // `unmapped` and any protected repository escalates on every run.
        mappings:
          this.#d.checkMappings ??
          protection.requiredChecks.map((c) => ({ localId: c, contextName: c })),
        observed,
        headSha: pr.headSha,
        waitedMs: this.#d.clock.now().getTime() - ciWaitStartedMs,
        scheduleDeadlineMs: CI_SCHEDULE_DEADLINE_MS,
        ...(protection.usesMergeQueue ? { event: "merge_group" as const } : {}),
      });
      const unsatisfied = [...verdicts].filter(([, v]) => v.state !== "satisfied");
      if (unsatisfied.length > 0) {
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason: `CI not satisfied — ${unsatisfied.map(([n, v]) => `${n}: ${v.detail}`).join("; ")}`,
        });
      }

      // -- PR review --------------------------------------------------------
      //
      // A second review, against the pull request as a reviewer sees it rather
      // than the workspace as the implementer left it. It runs AFTER CI so it
      // can read what CI actually reported, and BEFORE the merge gate so a
      // blocking finding stops a merge rather than annotating one.
      //
      // Distinct from the local review, not a repeat of it: the local pass sees
      // a working tree, this one sees the squashed, rebased, CI-checked change
      // in its final form. Findings that only exist in that form — an
      // interaction with something that landed on the base branch meanwhile —
      // are invisible to the earlier pass.
      const prReviewOutcome = await this.#runPrReview({
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
      });
      costUsd += prReviewOutcome.costUsd;
      if (prReviewOutcome.blocked !== undefined) {
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason: prReviewOutcome.blocked,
        });
      }
      if (prReviewOutcome.review !== undefined) review = prReviewOutcome.review;

      // -- deliver or merge -------------------------------------------------
      if (cfg.autonomy === "pr-only") {
        if (cfg.backlog.deliveredState !== undefined) {
          await this.#withOutbox(runId, "backlog", "transition-delivered", issue.identifier, () =>
            this.#d.backlog.transitionState({
              identifier: issue.identifier,
              toState: cfg.backlog.deliveredState as string,
            }),
          );
        }
        await this.#withOutbox(runId, "backlog", "comment-delivered", issue.identifier, () =>
          this.#d.backlog.comment({
            identifier: issue.identifier,
            body: `runmill opened ${pr.url} for this issue.\n\nRun: ${runId}`,
          }),
        );
        await input.lease.release(held);
        held = undefined;
        return finish("PR_DELIVERED", { prNumber: pr.number, prUrl: pr.url });
      }

      // guarded-merge and continuous
      const canWriteProtection = await this.#d.forge.canWriteBranchProtection({ repo: target.repo });
      if (canWriteProtection) {
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason:
            "the merge credential can edit branch protection, so a bypass-free merge is " +
            "unverifiable; merge modes stay locked until it cannot",
        });
      }

      if (protection.requiresApproval) {
        return finish("AWAITING_APPROVAL", { prNumber: pr.number, prUrl: pr.url });
      }

      this.#advance(runId, "MERGE_READY");
      await input.lease.assertHeld(held);
      const merged = await this.#withOutbox(
        runId,
        "forge",
        "merge",
        `${target.repo}#${pr.number}`,
        () =>
          this.#d.forge.merge({
            repo: target.repo,
            number: pr.number,
            method: cfg.github.merge.method,
          }),
      );
      this.#advance(runId, "MERGED", merged.mergeSha);

      if (cfg.backlog.completedState !== undefined) {
        await this.#withOutbox(runId, "backlog", "transition-complete", issue.identifier, () =>
          this.#d.backlog.transitionState({
            identifier: issue.identifier,
            toState: cfg.backlog.completedState as string,
          }),
        );
      }
      this.#advance(runId, "BACKLOG_UPDATED");

      await input.lease.release(held);
      held = undefined;
      this.#advance(runId, "CLEANUP");
      return finish("COMPLETED", {
        prNumber: pr.number,
        prUrl: pr.url,
        mergeSha: merged.mergeSha,
      });
    } catch (err) {
      const reason = errorMessage(err);
      this.#log(`run failed: ${reason}`);
      return finish("QUARANTINED", { reason });
    } finally {
      // The workspace is deliberately preserved on a non-clean exit so a human
      // can inspect it. PR_DELIVERED is a clean exit — it is how every
      // successful run ends in `pr-only`, the default mode — so omitting it
      // meant the default configuration never reclaimed a single workspace.
      if (workspace !== undefined && CLEAN_EXITS.has(this.#state)) {
        await this.#workspaces.destroy(workspace, this.#d.sourceRepoPath);
      }
      if (held !== undefined) {
        try {
          await input.lease.release(held);
        } catch {
          // A lost lease is already someone else's; nothing to release.
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
    const budget = cfg.budgets.maxAgentInvocations;
    const maxFixes = Math.max(0, budget.prFixer);
    const maxReviews = Math.max(1, budget.prReview);

    let costUsd = 0;
    let review: Review | undefined;

    for (let attempt = 0; attempt < maxReviews; attempt += 1) {
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
        allowedCommands: [],
        network: cfg.workspace.network,
        maxTurns: cfg.providers.maxTurns,
        timeoutMs: cfg.providers.timeoutMinutes * 60_000,
      });
      const result = await session.result;
      costUsd += accumulateUsage(result.events).costUsd;

      if (result.status !== "success") {
        return { costUsd, blocked: `PR reviewer returned ${result.status}` };
      }
      if (result.outputRef === undefined || result.outputRef === "") {
        return { costUsd, blocked: "PR reviewer produced no structured output" };
      }

      try {
        review = parseReviewJson(readFileSync(result.outputRef, "utf8"));
      } catch (err) {
        // An unparseable review is not an absent review: it is a review whose
        // conclusion is unknown, and unknown is not permission to merge.
        return { costUsd, blocked: `PR review output was unparseable: ${errorMessage(err)}` };
      }

      const changed = await this.#workspaces.changedFiles(workspace);
      const cross = crossCheckVerdict(
        review,
        changed,
        cfg.risk.manualApproval.paths,
        input.packet.acceptance_criteria,
      );
      if (!cross.accepted) {
        return { costUsd, blocked: cross.reason ?? "PR review verdict rejected" };
      }

      const blocking = blockingFindings(review, cfg.review.mergeBlockingSeverities);
      if (blocking.length === 0) return { costUsd, review };

      this.#log(`  PR review: ${blocking.length} blocking finding(s)`);
      if (attempt >= maxFixes) {
        return {
          costUsd,
          blocked:
            `${blocking.length} blocking PR-review finding(s) unresolved after ` +
            `${attempt + 1} review(s): ${blocking.map((f) => f.title).join("; ")}`,
        };
      }

      // -- fix, then amend the pull request -------------------------------
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
        allowedCommands: [],
        network: cfg.workspace.network,
        maxTurns: cfg.providers.maxTurns,
        timeoutMs: cfg.providers.timeoutMinutes * 60_000,
      });
      const fixResult = await fixSession.result;
      costUsd += accumulateUsage(fixResult.events).costUsd;
      if (fixResult.status !== "success") {
        return { costUsd, blocked: `PR fixer returned ${fixResult.status}` };
      }

      const sha = await this.#workspaces.checkpoint(
        workspace,
        `${issue.identifier}: pr-review fix ${attempt + 1}`,
      );
      if (sha === undefined) {
        // Nothing changed, so the next review would reach the same verdict.
        return {
          costUsd,
          blocked: "PR fixer produced no change, so the blocking findings still stand",
        };
      }

      // The change must be re-verified before it goes back onto the PR: a fix
      // is new code, and new code has not been through the coverage contract.
      this.#advance(runId, "LOCAL_VERIFY");
      const reverified = await this.#verification.run({
        workspace,
        workspaces: this.#workspaces,
        manifest: resolveManifest({
          configured: this.#d.checks,
          changedPaths: await this.#workspaces.changedFiles(workspace),
        }),
        candidateSha: sha,
      });
      if (!reverified.mergeReady) {
        return {
          costUsd,
          blocked: `verification failed after a PR-review fix: ${reverified.failures.join("; ")}`,
        };
      }

      await input.lease.assertHeld(input.held);
      await this.#withOutbox(
        runId,
        "forge",
        "push-pr-fix",
        `${target.repo}#${input.branch}@${sha}`,
        () =>
          this.#d.forge.push({
            repo: target.repo,
            branch: input.branch,
            workspacePath: workspace.path,
          }),
      );
      this.#log(`  pushed PR-review fix ${attempt + 1} to #${pr.number}`);
    }

    return {
      costUsd,
      blocked: `PR review did not converge within ${maxReviews} review(s)`,
    };
  }
}

interface PrReviewInput {
  readonly runId: string;
  readonly issue: BacklogIssue;
  readonly target: RepositoryTarget;
  readonly pr: { number: number; url: string; headSha: string };
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
}

interface PrReviewOutcome {
  readonly costUsd: number;
  /** Set when the run must escalate; the string is the reason. */
  readonly blocked?: string | undefined;
  readonly review?: Review | undefined;
}

/** Bound on how long a required check may go unscheduled before escalating. */
const CI_SCHEDULE_DEADLINE_MS = 10 * 60_000;

/**
 * Terminal states after which the workspace holds nothing a human needs.
 *
 * Everything else — NEEDS_HUMAN, QUARANTINED, AWAITING_APPROVAL — keeps its
 * workspace, because the tree is the evidence for whatever has to be decided.
 */
const CLEAN_EXITS: ReadonlySet<string> = new Set(["COMPLETED", "PR_DELIVERED"]);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
