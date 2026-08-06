import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
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
import { reconcileChecks, summarize, type CheckMapping } from "../pr/reconcile.js";
import { GitRefLease, type HeldLease } from "../queue/git-lease.js";
import { accumulateUsage } from "../agent/events.js";
import { RunmillError } from "../errors/runmill-error.js";
import { renderPullRequestBody } from "./pr-body.js";

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
  #state: RunState = "DISCOVERED";
  #version = 1;

  constructor(deps: OrchestratorDeps) {
    this.#d = deps;
    this.#workspaces = deps.workspaces ?? new WorkspaceManager();
    this.#verification = deps.verification ?? new VerificationEngine();
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
      this.#d.store.failSideEffect(key, String(err instanceof Error ? err.message : err));
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
    let costUsd = 0;

    const finish = (state: RunState, extra: Partial<RunOutcome> = {}): RunOutcome => ({
      runId,
      issueId: issue.identifier,
      finalState: state,
      costUsd,
      ...extra,
    });

    try {
      this.#d.store.createRun({
        runId,
        issueId: issue.identifier,
        repo: target.repo,
        provider: cfg.provider.implementation,
      });
      this.#advance(runId, "ELIGIBILITY_CHECKED");

      // -- claim ---------------------------------------------------------
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

      if (cfg.autonomy !== "observe") {
        await this.#withOutbox(runId, "backlog", "transition-claim", issue.identifier, () =>
          this.#d.backlog.transitionState({
            identifier: issue.identifier,
            toState: cfg.backlog.claimState,
          }),
        );
      }

      // -- workspace -----------------------------------------------------
      const branch = cfg.github.branchTemplate
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
      const snapshotHash = this.#d.backlog.snapshotHash(issue);
      this.#d.store.appendEvent({
        runId,
        seq: 1,
        type: "issue.snapshot",
        payload: { identifier: issue.identifier, snapshotHash },
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
        snapshotHash,
        requiredChecks: manifest.map((c) => c.id),
        network: cfg.workspace.network,
      });
      const packetPath = this.#workspaces.writeTaskPacket(workspace, packet);
      mkdirSync(join(workspace.path, ".runmill", "run"), { recursive: true });
      writeFileSync(join(workspace.path, ".runmill", "run", "issue.md"), renderIssueDocument(issue));
      this.#advance(runId, "TASK_PACKET_READY");

      if (cfg.autonomy === "observe") {
        this.#log("observe mode: planning only, no repository mutation");
        return finish("COMPLETED", { reason: "observe mode" });
      }

      // -- implement / verify / review loop -------------------------------
      let review: Review | undefined;
      let candidateSha = workspace.baseCommit;

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
          maxTurns: cfg.provider.maxTurns,
          timeoutMs: cfg.provider.timeoutMinutes * 60_000,
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
        const iterationManifest = resolveManifest({
          configured: this.#d.checks,
          changedPaths: changed,
        });
        const verification = await this.#verification.run({
          workspace,
          workspaces: this.#workspaces,
          manifest: iterationManifest,
          candidateSha,
        });

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
        const reviewSession = await this.#d.provider.start({
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
          maxTurns: cfg.provider.maxTurns,
          timeoutMs: cfg.provider.timeoutMinutes * 60_000,
        });
        const reviewResult = await reviewSession.result;
        costUsd += accumulateUsage(reviewResult.events).costUsd;

        if (reviewResult.outputRef === undefined || reviewResult.outputRef === "") {
          throw RunmillError.fromCatalog("RM-REVIEW-001", {
            whatHappened: "reviewer produced no structured output",
            runId,
          });
        }
        review = parseReviewJson(
          await import("node:fs").then((fs) => fs.readFileSync(reviewResult.outputRef as string, "utf8")),
        );

        const cross = crossCheckVerdict(review, changed, cfg.risk.manualApproval.paths);
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

      await this.#withOutbox(runId, "forge", "push", `${target.repo}#${branch}`, () =>
        this.#d.forge.push({ repo: target.repo, branch, workspacePath: workspace!.path }),
      );
      this.#advance(runId, "PUSHED");

      await input.lease.assertHeld(held);
      const pr = await this.#withOutbox(runId, "forge", "open-pr", `${target.repo}#${branch}`, () =>
        this.#d.forge.openPullRequest({
          repo: target.repo,
          branch,
          baseBranch: target.baseBranch,
          title: `${issue.identifier}: ${issue.title}`,
          body: renderPullRequestBody({
            issue,
            review: review as Review,
            runId,
            provider: cfg.provider.implementation,
            checks: [],
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
      const protection = await this.#d.forge.getBranchProtection({
        repo: target.repo,
        branch: target.baseBranch,
      });
      const observed = await this.#d.forge.listChecks({ repo: target.repo, ref: pr.headSha });
      const verdicts = reconcileChecks({
        requiredContexts: protection.requiredChecks,
        mappings: this.#d.checkMappings ?? [],
        observed,
        headSha: pr.headSha,
        waitedMs: 0,
        scheduleDeadlineMs: 0,
      });
      const ci = summarize(verdicts);

      if (!ci.allSatisfied) {
        const detail = [...verdicts.entries()]
          .filter(([, v]) => v.state !== "satisfied")
          .map(([name, v]) => `${name}: ${v.detail}`)
          .join("; ");
        return finish("NEEDS_HUMAN", {
          prNumber: pr.number,
          prUrl: pr.url,
          reason: `CI not satisfied — ${detail}`,
        });
      }

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
        this.#advance(runId, "PR_DELIVERED");
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
        this.#advance(runId, "AWAITING_APPROVAL");
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
      this.#advance(runId, "COMPLETED");
      return finish("COMPLETED", {
        prNumber: pr.number,
        prUrl: pr.url,
        mergeSha: merged.mergeSha,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.#log(`run failed: ${reason}`);
      return finish("QUARANTINED", { reason });
    } finally {
      // The workspace is deliberately preserved on a non-clean exit so a human
      // can inspect it; only a fully completed run cleans up eagerly.
      if (workspace !== undefined && this.#state === "COMPLETED") {
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
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
