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
import { FakeForgeAdapter } from "../testing/fake-forge.js";
import { selectNext } from "../queue/selector.js";
import type { RunmillConfig } from "../config/types.js";
import type { CheckSpec } from "../verification/engine.js";
import type { BacklogIssue } from "../domain/types.js";
import { WorkspaceManager, type Workspace } from "../workspace/manager.js";
import { validateInstalledDependencies } from "../workspace/dependencies.js";
import { errorMessage, RunmillError } from "../errors/runmill-error.js";

export interface OrchestratorRunnerOptions {
  readonly config: RunmillConfig;
  /** Repository used when a task declares no fixture of its own. */
  readonly defaultRepoPath?: string | undefined;
  readonly demo?: boolean | undefined;
  /** Test seam: live-provider tests inject a fake without contacting a CLI. */
  readonly adapterBuilder?: typeof buildAdapters | undefined;
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
      const issue = toBacklogIssue(task, options.config);

      // The backlog for a replay IS the task: the suite defines the issue, so
      // seeding from a live backlog or the demo fixture would run something
      // else entirely. Only the provider may be live. Every forge observation
      // and mutation is simulated, even under guarded-merge/continuous, while
      // pushes made by the fake stay inside the throwaway local bare origin.
      const backlog = new FakeBacklogAdapter([issue]);

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

      // Repository routing belongs to selection. Preparing the first configured
      // repository before selection silently replays valid project/label routes
      // against the wrong base branch.
      const target = selection.selected.target;
      const repoPath = prepareRepository(
        task,
        workspace.path,
        options.defaultRepoPath,
        target.baseBranch,
      );
      const sourceBaseRef = repositoryHead(repoPath);
      const dependencySource = resolveEvaluationDependencySource(
        task,
        repoPath,
        options.defaultRepoPath,
        sourceBaseRef,
      );

      const dataDir = join(workspace.path, "state");
      mkdirSync(dataDir, { recursive: true });
      const adapterBuilder = options.adapterBuilder ?? buildAdapters;
      const adapters = await adapterBuilder(options.config, {
        demo: options.demo !== false,
        need: ["provider"],
        externalEffects: "deny",
      });
      const forge = new FakeForgeAdapter({ credentialCanWriteProtection: false });
      const clock = new SystemClock();
      const store = StateStore.open(join(dataDir, "runmill.db"), { clock });

      const checks: CheckSpec[] = (task.checks ?? []).map((c) => ({
        id: c.id,
        run: c.run,
        required: true,
        source: "repository-policy" as const,
      }));

      try {
        const workspaces = new EvaluationWorkspaceManager(dependencySource);
        const orchestrator = new Orchestrator({
          backlog,
          provider: adapters.provider,
          reviewProvider: adapters.reviewProvider,
          forge,
          store,
          clock,
          config: options.config,
          sourceRepoPath: repoPath,
          sourceRepository: target.repo,
          // Always bind the run to the commit prepared above. A historical SHA
          // or routed base branch is an explicit experiment input, not a hint
          // to fall back from when cloning the workspace.
          sourceBaseRef,
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

  const gitOutput = (...args: string[]): string => {
    return execFileSync("git", args, {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  };
  const git = (...args: string[]): void => {
    gitOutput(...args);
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
    let baseCommit: string;
    try {
      baseCommit = gitOutput("rev-parse", "--verify", `${task.baseCommit}^{commit}`);
    } catch {
      throw new Error(
        `evaluation task ${JSON.stringify(task.id)} base_commit ` +
          `${JSON.stringify(task.baseCommit)} is not present in the fixture history`,
      );
    }
    git("checkout", "-q", "--detach", baseCommit);
  } else if (cloned) {
    const remoteBase = `refs/remotes/origin/${baseBranch}`;
    let baseCommit: string;
    try {
      baseCommit = gitOutput("rev-parse", "--verify", `${remoteBase}^{commit}`);
    } catch {
      throw new Error(
        `evaluation repository does not contain configured base branch ` +
          `${JSON.stringify(baseBranch)}`,
      );
    }
    git("checkout", "-q", "--detach", baseCommit);
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

function repositoryHead(path: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * Select dependency bytes only after proving they describe the exact replay
 * base. In particular, a historical task never inherits the current
 * checkout's node_modules merely because that directory happens to exist.
 */
export function resolveEvaluationDependencySource(
  task: EvalTask,
  preparedRepo: string,
  defaultRepoPath: string | undefined,
  exactBase = repositoryHead(preparedRepo),
): string | undefined {
  // Repositories without an npm lock need no imported dependency tree.
  if (!existsSync(join(preparedRepo, "package-lock.json"))) return undefined;

  const requested = task.dependencyPath ?? task.repoPath ?? defaultRepoPath;
  if (requested === undefined || !existsSync(requested)) {
    throw RunmillError.fromCatalog("RM-VERIFY-005", {
      whatHappened:
        `Evaluation task ${JSON.stringify(task.id)} base ${exactBase} uses package-lock.json, ` +
        "but no installed dependency checkout is available. Create a checkout at that exact " +
        "base, run npm ci there, and set dependency_path for this task.",
    });
  }

  // WorkspaceManager canonicalizes Git paths to their repository root before
  // importing dependencies. Validate that same path here so a subdirectory
  // cannot pass preflight and later resolve to different manifests.
  const installedSource = gitRepositoryRoot(requested) ?? requested;
  try {
    validateInstalledDependencies({ trustedCheckout: preparedRepo, installedSource });
  } catch (cause) {
    const detail = cause instanceof RunmillError ? cause.whatHappened : errorMessage(cause);
    throw RunmillError.fromCatalog("RM-VERIFY-005", {
      whatHappened:
        `Evaluation task ${JSON.stringify(task.id)} cannot reuse dependencies for exact base ` +
        `${exactBase}. ${detail}\n  Current-checkout dependencies are never ` +
        "substituted for a mismatched historical base. Create a checkout at the exact base, " +
        "run npm ci there, and set dependency_path for this task.",
    });
  }
  return installedSource;
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

  constructor(readonly dependencySourceRepo?: string | undefined) {
    super();
  }

  override async create(input: Parameters<WorkspaceManager["create"]>[0]): Promise<Workspace> {
    const workspace = await super.create({
      ...input,
      ...(this.dependencySourceRepo === undefined
        ? {}
        : { dependencySourceRepo: this.dependencySourceRepo }),
    });
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

export function toBacklogIssue(task: EvalTask, config: RunmillConfig): BacklogIssue {
  const state = task.issue.state ?? config.backlog.eligibleStates[0];
  if (state === undefined || state === "") {
    throw new Error(
      `evaluation task ${JSON.stringify(task.id)} has no issue.state and the configured backlog ` +
        "has no eligible state",
    );
  }
  return {
    identifier: task.issue.identifier,
    title: task.issue.title,
    description: task.issue.description,
    priority: 2,
    labels: [...task.issue.labels],
    state,
    teamKey: task.issue.team ?? config.backlog.team,
    ...(task.issue.project === undefined ? {} : { projectName: task.issue.project }),
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    assigneeIsHuman: false,
    canceled: false,
    completed: false,
  };
}
