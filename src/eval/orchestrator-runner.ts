import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
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
import { WorkspaceManager, type Workspace } from "../workspace/manager.js";

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
      const target: RepositoryTarget = {
        repo: options.config.github.repositories[0]?.repo ?? "acme/eval",
        baseBranch: options.config.github.repositories[0]?.baseBranch ?? "main",
      };
      const repoPath = prepareRepository(
        task,
        workspace.path,
        options.defaultRepoPath,
        target.baseBranch,
      );
      const dataDir = join(workspace.path, "state");
      mkdirSync(dataDir, { recursive: true });

      const issue = toBacklogIssue(task);

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
          changedPaths: [],
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
        const workspaces = new EvaluationWorkspaceManager();
        const orchestrator = new Orchestrator({
          backlog,
          provider: adapters.provider,
          reviewProvider: adapters.reviewProvider,
          forge: adapters.forge,
          store,
          clock,
          config: options.config,
          sourceRepoPath: repoPath,
          workspaceRoot: join(dataDir, "runs"),
          workspaces,
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
        const changedPaths = await workspaces.collectChangedPaths();

        return {
          taskId: task.id,
          finalState: outcome.finalState,
          costUsd: outcome.costUsd,
          durationMs: Date.now() - startedMs,
          changedPaths,
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
 * Cloned (or copied for a non-Git fixture) rather than used in place, so a task
 * cannot mutate the fixture it was given. Git history is retained because a
 * historical base commit is part of the experiment, not incidental metadata.
 */
export function prepareRepository(
  task: EvalTask,
  workspaceRoot: string,
  defaultRepoPath: string | undefined,
  baseBranch = "main",
): string {
  const target = join(workspaceRoot, "repo");
  const source = task.repoPath ?? defaultRepoPath;

  let cloned = false;
  if (source !== undefined && existsSync(source)) {
    const sourceRepoRoot = gitRepositoryRoot(source);
    if (sourceRepoRoot !== undefined) {
      execFileSync(
        "git",
        ["clone", "--no-hardlinks", "--quiet", sourceRepoRoot, target],
        { stdio: "ignore" },
      );
      cloned = true;
    } else {
      cpSync(source, target, {
        recursive: true,
        filter: (path) => !relative(source, path).split(sep).includes(".git"),
      });
    }
  } else {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "README.md"), `# ${task.id}\n`);
  }

  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: target, stdio: "ignore" });
  };
  if (!cloned) {
    git("init", "-q", "-b", "main", ".");
  }
  git("config", "user.email", "eval@runmill.local");
  git("config", "user.name", "runmill eval");
  if (!cloned) {
    git("add", "-A");
    try {
      git("commit", "-q", "-m", `eval fixture for ${task.id}`);
    } catch {
      // An empty fixture already has all of its contents represented by HEAD.
    }
  }

  if (task.baseCommit !== undefined && task.baseCommit !== "") {
    git("checkout", "-q", "--detach", task.baseCommit);
  }

  // A local bare remote, because the lease is a ref pushed to `origin` and a
  // fixture without one cannot be claimed — every task would quarantine on
  // "'origin' does not appear to be a git repository" and the suite would
  // measure the fixture rather than the harness.
  const origin = join(workspaceRoot, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", baseBranch, origin], { stdio: "ignore" });
  try {
    git("remote", "add", "origin", origin);
  } catch {
    git("remote", "set-url", "origin", origin);
  }
  git("push", "-q", "origin", `HEAD:refs/heads/${baseBranch}`);

  return target;
}

function gitRepositoryRoot(path: string): string | undefined {
  try {
    return execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Keep the throwaway run workspace until its diff has been scored. */
class EvaluationWorkspaceManager extends WorkspaceManager {
  #workspace: Workspace | undefined;

  override async create(input: Parameters<WorkspaceManager["create"]>[0]): Promise<Workspace> {
    const workspace = await super.create(input);
    this.#workspace = workspace;
    return workspace;
  }

  override async destroy(_workspace: Workspace, _sourceRepo?: string): Promise<void> {
    // The outer evaluation workspace owns cleanup after collectChangedPaths().
  }

  async collectChangedPaths(): Promise<string[]> {
    if (this.#workspace === undefined) return [];
    const committed = await this.changedFiles(this.#workspace);
    const untracked = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: this.#workspace.path, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter((path) => path !== "" && !path.startsWith(".runmill/run/"));
    return [...new Set([...committed, ...untracked])].sort();
  }
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
