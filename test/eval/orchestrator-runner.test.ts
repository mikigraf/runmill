import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../src/config/load.js";
import {
  orchestratorRunner,
  prepareRepository,
  resolveEvaluationDependencySource,
  toBacklogIssue,
} from "../../src/eval/orchestrator-runner.js";
import type { EvalTask } from "../../src/eval/suite.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import type { ForgeAdapter } from "../../src/pr/adapter.js";
import { FakeBacklogAdapter } from "../../src/testing/fake-backlog.js";
import { FakeProviderAdapter } from "../../src/testing/fake-provider.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runmill-eval-runner-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function task(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: "history-replay",
    kind: "bug-fix",
    split: "development",
    issue: {
      identifier: "ENG-1",
      title: "Fix the fixture",
      description:
        "The current fixture demonstrates the historical behavior and needs a bounded correction.\n\n" +
        "Acceptance criteria:\n- the fixture is fixed",
      labels: [],
    },
    expected: "deliver",
    ...overrides,
  };
}

function makeRepository(): { source: string; first: string } {
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main", ".");
  git(source, "config", "user.email", "test@runmill.local");
  git(source, "config", "user.name", "runmill test");
  writeFileSync(join(source, "version.txt"), "one\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "first");
  const first = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "version.txt"), "two\n");
  git(source, "commit", "-q", "-am", "second");
  return { source, first };
}

function writeInstalledNpmProject(path: string, version: string): void {
  mkdirSync(join(path, "node_modules"), { recursive: true });
  const rootPackage = { name: "fixture", version };
  writeFileSync(join(path, "package.json"), `${JSON.stringify(rootPackage)}\n`);
  writeFileSync(
    join(path, "package-lock.json"),
    `${JSON.stringify({
      ...rootPackage,
      lockfileVersion: 3,
      requires: true,
      packages: { "": rootPackage },
    })}\n`,
  );
  writeFileSync(
    join(path, "node_modules", ".package-lock.json"),
    `${JSON.stringify({
      ...rootPackage,
      lockfileVersion: 3,
      requires: true,
      packages: {},
    })}\n`,
  );
}

function makeNpmHistory(): { source: string; first: string } {
  const source = join(root, "npm-source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main", ".");
  git(source, "config", "user.email", "test@runmill.local");
  git(source, "config", "user.name", "runmill test");
  writeFileSync(join(source, ".gitignore"), "node_modules/\n");
  writeInstalledNpmProject(source, "1.0.0");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "version one dependencies");
  const first = git(source, "rev-parse", "HEAD");
  writeInstalledNpmProject(source, "2.0.0");
  git(source, "commit", "-q", "-am", "version two dependencies");
  return { source, first };
}

function makeRoutedRepository(): string {
  const { source, first } = makeRepository();
  const check = join(source, "route-check.sh");
  writeFileSync(check, "#!/bin/sh\nexit 0\n");
  chmodSync(check, 0o755);
  git(source, "add", "route-check.sh");
  git(source, "commit", "-q", "-m", "main route check passes");

  git(source, "checkout", "-q", "-b", "release", first);
  writeFileSync(check, "#!/bin/sh\nexit 1\n");
  chmodSync(check, 0o755);
  git(source, "add", "route-check.sh");
  git(source, "commit", "-q", "-m", "release route check fails");
  git(source, "checkout", "-q", "main");
  return source;
}

function replayConfig(autonomy: "pr-only" | "continuous" = "pr-only") {
  return parseConfig(`
version: 1
autonomy: ${autonomy}
${autonomy === "continuous" ? "experimental: { automatic_merge: true }" : ""}
providers:
  implementer: { implementation: codex }
backlog:
  provider: linear
  team: ENG
  eligible_states: [Todo]
  claim_state: In Progress
github:
  draft_pr: false
  repositories:
    - match: { team: ENG }
      repo: acme/eval
      base_branch: main
workspace:
  git_isolation: clone
verification:
  fail_on_missing_check: false
  fail_on_skipped_check: false
risk:
  default: low
`);
}

function routedReplayConfig() {
  return parseConfig(`
version: 1
autonomy: pr-only
providers:
  implementer: { implementation: codex }
backlog:
  provider: linear
  team: PLAT
  eligible_states: [Ready]
  claim_state: Building
github:
  draft_pr: false
  repositories:
    - match: { label: release-only }
      repo: acme/release
      base_branch: release
    - match: { team: PLAT }
      repo: acme/platform
      base_branch: main
workspace:
  git_isolation: clone
verification:
  fail_on_missing_check: false
  fail_on_skipped_check: false
risk:
  default: low
`);
}

describe("evaluation repository preparation", () => {
  it("clones a normal Git repository without copying a broken root .git directory", () => {
    const { source } = makeRepository();
    const prepared = prepareRepository(task({ repoPath: source }), join(root, "work"), undefined);
    expect(git(prepared, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(readFileSync(join(prepared, "version.txt"), "utf8")).toBe("two\n");
  });

  it("preserves source history and checks out the requested base commit", () => {
    const { source, first } = makeRepository();
    const prepared = prepareRepository(
      task({ repoPath: source, baseCommit: first }),
      join(root, "work"),
      undefined,
    );
    expect(git(prepared, "rev-parse", "HEAD")).toBe(first);
    expect(readFileSync(join(prepared, "version.txt"), "utf8")).toBe("one\n");
  });

  it("checks out the repository route's configured base branch", () => {
    const { source, first } = makeRepository();
    git(source, "branch", "release", first);
    const prepared = prepareRepository(
      task({ repoPath: source }),
      join(root, "work"),
      undefined,
      "release",
    );
    expect(git(prepared, "rev-parse", "HEAD")).toBe(first);
    expect(readFileSync(join(prepared, "version.txt"), "utf8")).toBe("one\n");
  });

  it("makes the production workspace clone start from the requested historical base", async () => {
    const { source, first } = makeRepository();
    const prepared = prepareRepository(
      task({ repoPath: source, baseCommit: first }),
      join(root, "work"),
      undefined,
    );
    const manager = new WorkspaceManager();
    const workspace = await manager.create({
      runId: "historical-workspace",
      sourceRepo: prepared,
      branch: "runmill/history-1",
      baseBranch: "main",
      sourceRef: first,
      root: join(root, "runs"),
      isolation: "clone",
    });

    expect(git(prepared, "rev-parse", "refs/heads/main")).not.toBe(first);
    expect(workspace.baseCommit).toBe(first);
    expect(readFileSync(join(workspace.path, "version.txt"), "utf8")).toBe("one\n");
  });

  it("excludes a root .git entry when copying a non-repository fixture", () => {
    const source = join(root, "plain-fixture");
    mkdirSync(join(source, ".git"), { recursive: true });
    writeFileSync(join(source, ".git", "incomplete"), "not metadata\n");
    writeFileSync(join(source, "README.md"), "fixture\n");
    const prepared = prepareRepository(task({ repoPath: source }), join(root, "work"), undefined);
    expect(git(prepared, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(existsSync(join(prepared, ".git", "incomplete"))).toBe(false);
  });
});

describe("evaluation dependency fidelity", () => {
  it("rejects current dependencies when historical package inputs differ", async () => {
    const { source, first } = makeNpmHistory();
    const adapterBuilder = vi.fn(async () => {
      throw new Error("provider construction must not run before dependency preflight");
    });

    let thrown: unknown;
    try {
      await orchestratorRunner({
        config: replayConfig(),
        demo: false,
        adapterBuilder,
      })(task({ repoPath: source, baseCommit: first }), 1);
    } catch (error) {
      thrown = error;
    }

    expect(adapterBuilder).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(RunmillError);
    expect(thrown).toMatchObject({ code: "RM-VERIFY-005" });
    expect((thrown as RunmillError).whatHappened).toContain(
      "package.json/package-lock.json differ from the exact base commit",
    );
    expect((thrown as RunmillError).whatHappened).toContain("dependency_path");
  });

  it("accepts an installed checkout whose dependency inputs match the exact base", () => {
    const { source, first } = makeNpmHistory();
    const prepared = prepareRepository(
      task({ repoPath: source, baseCommit: first }),
      join(root, "prepared"),
      undefined,
    );
    const exactDependencies = join(root, "dependencies-at-first");
    mkdirSync(exactDependencies);
    writeInstalledNpmProject(exactDependencies, "1.0.0");

    expect(
      resolveEvaluationDependencySource(
        task({ repoPath: source, baseCommit: first, dependencyPath: exactDependencies }),
        prepared,
        undefined,
        first,
      ),
    ).toBe(exactDependencies);
  });
});

describe("live replay evidence", () => {
  it("uses configured issue defaults and the route selected for that task", async () => {
    const source = makeRoutedRepository();
    const config = routedReplayConfig();
    const issue = toBacklogIssue(task(), config);
    expect(issue.teamKey).toBe("PLAT");
    expect(issue.state).toBe("Ready");

    const attempt = await orchestratorRunner({ config, defaultRepoPath: source, demo: true })(
      task({ checks: [{ id: "route", run: "./route-check.sh" }], allowedPaths: ["**"] }),
      1,
    );

    // The first configured route points at a branch whose check fails. Only
    // the second, team-matched route points at the passing main branch.
    expect(attempt.finalState, attempt.reason).toBe("PR_DELIVERED");
  }, 60_000);

  it("preserves explicit issue routing fields from the task", () => {
    const config = routedReplayConfig();
    const issue = toBacklogIssue(
      task({
        issue: {
          identifier: "OPS-9",
          title: "Route this task",
          description: "Acceptance criteria:\n- route it",
          labels: ["release-only"],
          team: "OPS",
          state: "Queued",
          project: "Release train",
        },
      }),
      config,
    );
    expect(issue).toMatchObject({
      teamKey: "OPS",
      state: "Queued",
      projectName: "Release train",
      labels: ["release-only"],
    });
  });

  it("reports the paths the agent actually changed", async () => {
    const { source } = makeRepository();
    const config = replayConfig();
    const attempt = await orchestratorRunner({ config, defaultRepoPath: source, demo: true })(
      task({ allowedPaths: ["src/"], checks: [{ id: "smoke", run: "true" }] }),
      1,
    );
    expect(attempt.changedPaths, JSON.stringify(attempt)).toBeDefined();
    expect(attempt.changedPaths).toContain("RUNMILL_DEMO.md");
    expect(attempt.changedPaths?.some((path) => path.startsWith(".runmill/run/"))).toBe(false);
  }, 60_000);

  it("never invokes a live forge in continuous mode", async () => {
    const { source } = makeRepository();
    const provider = new FakeProviderAdapter();
    const liveForgeCalls: string[] = [];
    const forbiddenLiveForge = new Proxy(
      { name: "github" } as ForgeAdapter,
      {
        get(target, property, receiver) {
          if (property === "name") return Reflect.get(target, property, receiver);
          return async () => {
            liveForgeCalls.push(String(property));
            throw new Error(`live forge method ${String(property)} must not run during eval`);
          };
        },
      },
    );
    const adapterBuilder = vi.fn(async () => ({
      backlog: new FakeBacklogAdapter(),
      provider,
      reviewProvider: provider,
      forge: forbiddenLiveForge,
      live: { backlog: true, provider: true, reviewProvider: true, forge: true },
    }));

    const attempt = await orchestratorRunner({
      config: replayConfig("continuous"),
      defaultRepoPath: source,
      demo: false,
      adapterBuilder,
    })(
      task({
        expected: "merge",
        allowedPaths: ["**"],
        checks: [{ id: "smoke", run: "true" }],
      }),
      1,
    );

    expect(adapterBuilder).toHaveBeenCalledWith(
      expect.objectContaining({ autonomy: "continuous" }),
      expect.objectContaining({ need: ["provider"], externalEffects: "deny" }),
    );
    expect(liveForgeCalls).toEqual([]);
    // The configured merge policy is still measured, but only against the
    // runner-owned in-memory forge and its throwaway local origin.
    expect(attempt.finalState, attempt.reason).toBe("COMPLETED");
  }, 60_000);
});
