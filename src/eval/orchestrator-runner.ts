import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalTask } from "./suite.js";
import type { TaskAttempt } from "./score.js";
import type { TaskRunner } from "./replay.js";
import { makeTaskWorkspace } from "./replay.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { GitRefLease } from "../queue/git-lease.js";
import { StateStore } from "../state/store.js";
import { SystemClock } from "../platform/clock.js";
import { buildAdapters } from "../factory.js";
import { FakeBacklogAdapter } from "../testing/fake-backlog.js";
import { selectNext } from "../queue/selector.js";
import type { RunmillConfig } from "../config/types.js";
import type { CheckSpec } from "../verification/engine.js";
import type { BacklogIssue, RepositoryTarget } from "../domain/types.js";

export interface OrchestratorRunnerOptions {
  readonly config: RunmillConfig;
  /** Repository used when a task declares no fixture of its own. */
  readonly defaultRepoPath?: string | undefined;
  readonly demo?: boolean | undefined;
}

/**
 * Replay a task through the real orchestrator.
 *
 * The point of injecting the runner is that this is the ONLY implementation
 * that decides outcomes — the harness must not grow a second, simplified run
 * loop, because a loop that diverges from production stops measuring what
 * ships.
 *
 * Each task gets its own throwaway git repository and its own state database,
 * so tasks cannot see each other's leases, runs, or workspaces. A suite that
 * leaks state between tasks measures execution order.
 */
export function orchestratorRunner(options: OrchestratorRunnerOptions): TaskRunner {
  return async (task: EvalTask, attempt: number): Promise<TaskAttempt> => {
    const workspace = makeTaskWorkspace(task.id);
    const startedMs = Date.now();

    try {
      const repoPath = prepareRepository(task, workspace.path, options.defaultRepoPath);
      const dataDir = join(workspace.path, "state");
      mkdirSync(dataDir, { recursive: true });

      const issue = toBacklogIssue(task);
      const target: RepositoryTarget = {
        repo: options.config.github.repositories[0]?.repo ?? "acme/eval",
        baseBranch: options.config.github.repositories[0]?.baseBranch ?? "main",
      };

      // The backlog for a replay IS the task: the suite defines the issue, so
      // seeding from a live backlog or the demo fixture would run something
      // else entirely. Provider and forge still come from the factory, so a
      // replay can be pointed at a real coding agent.
      const adapters = await buildAdapters(options.config, {
        demo: options.demo !== false,
        need: ["provider", "forge"],
      });
      const backlog = new FakeBacklogAdapter([issue]);
      const store = StateStore.open(join(dataDir, "runmill.db"), { clock: new SystemClock() });
      const clock = new SystemClock();

      // Selection FIRST, then the run — the order the daemon uses.
      //
      // Eligibility (readiness, labels, dependencies, repository mapping) lives
      // in selectNext, not in Orchestrator.run, which trusts its caller. A
      // harness that called run() directly would bypass every rule that decides
      // whether an issue should be worked on at all, and could never measure
      // the escalations those rules exist to produce.
      const selection = await selectNext({
        backlog,
        config: options.config,
        leasedIssueIds: new Set<string>(),
      });
      if (selection.selected === undefined) {
        const failing = selection.rejected[0]?.decision.rules.filter((r) => !r.passed) ?? [];
        return {
          taskId: task.id,
          finalState: "NEEDS_HUMAN",
          costUsd: 0,
          durationMs: Date.now() - startedMs,
          reason:
            failing.length === 0
              ? "not selected"
              : failing.map((r) => `${r.rule}: ${r.reason}`).join("; "),
        };
      }

      const checks: CheckSpec[] = (task.checks ?? []).map((c) => ({
        id: c.id,
        run: c.run,
        required: true,
        source: "repository-policy" as const,
      }));

      try {
        const orchestrator = new Orchestrator({
          backlog,
          provider: adapters.provider,
          forge: adapters.forge,
          store,
          clock,
          config: options.config,
          sourceRepoPath: repoPath,
          workspaceRoot: join(dataDir, "runs"),
          checks,
          onEvent: () => undefined,
        });

        const runId = `eval_${task.id}_${attempt}`;
        const lease = new GitRefLease({
          cwd: repoPath,
          runId,
          clock,
          ttlMinutes: 20,
          hostId: "eval",
          pid: process.pid,
        });

        const outcome = await orchestrator.run({ runId, issue, target, lease });

        return {
          taskId: task.id,
          finalState: outcome.finalState,
          costUsd: outcome.costUsd,
          durationMs: Date.now() - startedMs,
          // The orchestrator does not surface the diff on its outcome, so the
          // diff-scope evaluator has nothing to judge here yet. Reporting an
          // empty list would silently score every task as in-scope, so it is
          // left undefined and the evaluator is skipped rather than faked.
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        };
      } finally {
        store.close();
      }
    } finally {
      workspace.cleanup();
    }
  };
}

/**
 * Materialize the repository a task runs against.
 *
 * Copied rather than used in place, and committed fresh, so a task cannot
 * mutate the fixture it was given — which would make the second run of the
 * same task a different experiment from the first.
 */
function prepareRepository(
  task: EvalTask,
  workspaceRoot: string,
  defaultRepoPath: string | undefined,
): string {
  const target = join(workspaceRoot, "repo");
  const source = task.repoPath ?? defaultRepoPath;

  if (source !== undefined && existsSync(source)) {
    cpSync(source, target, { recursive: true, filter: (p) => !p.includes(`${"/"}.git${"/"}`) });
  } else {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "README.md"), `# ${task.id}\n`);
  }

  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: target, stdio: "ignore" });
  };
  if (!existsSync(join(target, ".git"))) {
    git("init", "-q", "-b", "main", ".");
    git("config", "user.email", "eval@runmill.local");
    git("config", "user.name", "runmill eval");
  }
  git("add", "-A");
  try {
    git("commit", "-q", "-m", `eval fixture for ${task.id}`);
  } catch {
    // Nothing to commit: the fixture was already a committed repository.
  }

  if (task.baseCommit !== undefined && task.baseCommit !== "") {
    git("checkout", "-q", task.baseCommit);
  }

  // A local bare remote, because the lease is a ref pushed to `origin` and a
  // fixture without one cannot be claimed — every task would quarantine on
  // "'origin' does not appear to be a git repository" and the suite would
  // measure the fixture rather than the harness.
  const origin = join(workspaceRoot, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "ignore" });
  try {
    git("remote", "add", "origin", origin);
  } catch {
    git("remote", "set-url", "origin", origin);
  }
  git("push", "-q", "origin", "HEAD:refs/heads/main");

  return target;
}

function toBacklogIssue(task: EvalTask): BacklogIssue {
  return {
    identifier: task.issue.identifier,
    title: task.issue.title,
    description: task.issue.description,
    priority: 2,
    labels: [...task.issue.labels],
    state: "Todo",
    teamKey: "ENG",
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    assigneeIsHuman: false,
    canceled: false,
    completed: false,
  } as BacklogIssue;
}
