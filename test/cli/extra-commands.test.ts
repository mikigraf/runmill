/**
 * The commands the error catalog sends developers to.
 *
 * These are covered end to end by subprocess tests, which proves they work but
 * exercises none of this code in-process. Driving them through the injected
 * context tests the branches a happy-path subprocess run never reaches: an
 * existing file, an unknown run id, a malformed skill.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExtraCommands, type CommandContext } from "../../src/cli/extra-commands.js";
import { StateStore } from "../../src/state/store.js";
import { SystemClock } from "../../src/platform/clock.js";
import { renderCreatedConfig } from "../../src/config/create.js";
import { writeSchemaBeside } from "../../src/config/schema-asset.js";
import { parseConfig } from "../../src/config/load.js";
import { loadChecksManifest } from "../../src/verification/manifest.js";
import { VerificationEngine } from "../../src/verification/engine.js";
import type { Sandbox } from "../../src/workspace/sandbox.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import type { CheckResult } from "../../src/doctor/checks.js";
import { leaseRefName } from "../../src/queue/git-lease.js";
import { run as runProcess } from "../../src/platform/process.js";

/** Thrown in place of process.exit so a command's exit is observable. */
class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

interface Harness {
  readonly emitted: { human: string; data: unknown }[];
  readonly failures: unknown[];
  readonly doctorCalls: { repoRoot: string; configPath: string }[];
  readonly storedCredentials: { name: string; value: string }[];
  run(argv: string[]): Promise<number>;
}

let repo: string;
let data: string;
let policy: string;
let originalExit: typeof process.exit;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "runmill-cmd-repo-"));
  data = mkdtempSync(join(tmpdir(), "runmill-cmd-data-"));
  policy = join(data, "config", "policy.yaml");
  originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Exited(code ?? 0);
  });
});

afterEach(() => {
  process.exit = originalExit;
  makeRemovable(data);
  rmSync(repo, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

const READY_CHECK: CheckResult = {
  id: "provider:codex:request",
  status: "pass",
  observed: "one-turn provider request completed inside sandbox",
  expected: "one minimal provider request completes inside the actual Runmill sandbox",
};

function harness(options: {
  doctorResults?: readonly CheckResult[];
  onDoctor?: (() => void) | undefined;
  credentialInput?: string | undefined;
  stdinTTY?: boolean | undefined;
} = {}): Harness {
  const emitted: { human: string; data: unknown }[] = [];
  const failures: unknown[] = [];
  const doctorCalls: { repoRoot: string; configPath: string }[] = [];
  const storedCredentials: { name: string; value: string }[] = [];

  const ctx: CommandContext = {
    emit: (human, payload) => emitted.push({ human, data: payload }),
    fail: (err) => {
      // A command's own process.exit is stubbed to throw, and several actions
      // call it inside a try whose catch funnels into fail(). Let the sentinel
      // through, or a successful exit would be reported as a failure.
      if (err instanceof Exited) throw err;
      failures.push(err);
      throw new Exited(1);
    },
    dataDir: () => data,
    configPath: () => policy,
    repoRoot: () => repo,
    exitCodes: { ok: 0, failed: 1, configInvalid: 2, blocked: 3 },
    credentialStore: {
      get: async () => undefined,
      set: async (name, value) => {
        storedCredentials.push({ name, value });
      },
      remove: async () => undefined,
    },
    readStdin: () => options.credentialInput ?? "",
    stdinIsTTY: () => options.stdinTTY === true,
    createConfiguration: async ({ path }) => {
      const config = renderCreatedConfig({
        autonomy: "pr-only",
        implementer: "codex",
        reviewer: "inherit",
        team: "ENG",
        eligibleStates: ["Todo", "Ready"],
        claimState: "In Progress",
        deliveredState: "In Review",
        completedState: "Done",
        repository: "acme/widget",
        baseBranch: "main",
        includeLabels: ["agent-ready"],
        excludeLabels: ["needs-design", "no-agent"],
        mergeMethod: "squash",
        maxWallMinutes: 240,
      });
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, config);
      writeSchemaBeside(path);
      return {
        path,
        config,
        discovered: {
          repository: "acme/widget",
          baseBranch: "main",
          repositories: [{ repo: "acme/widget", baseBranch: "main" }],
          providers: [
            { implementation: "codex" as const, installed: true, authenticated: true },
            { implementation: "claude" as const, installed: false, authenticated: false },
          ],
          linearTeams: [],
          linearCredential: false,
          githubAuthenticated: false,
        },
      };
    },
    runDoctor: async (input) => {
      doctorCalls.push(input);
      options.onDoctor?.();
      return options.doctorResults ?? [READY_CHECK];
    },
  };
  return {
    emitted,
    failures,
    doctorCalls,
    storedCredentials,
    async run(argv) {
      // A fresh Command per invocation: commander instances carry parse state,
      // so reusing one across two parseAsync calls is not supported.
      const program = new Command();
      program.exitOverride();
      registerExtraCommands(program, ctx);
      try {
        await program.parseAsync(["node", "runmill", ...argv]);
        return 0;
      } catch (err) {
        if (err instanceof Exited) return err.code;
        throw err;
      }
    },
  };
}

function initGitRepo(remote = "git@github.com:acme/widget.git"): void {
  execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
}

function makeRemovable(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, stat.mode | 0o700);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) makeRemovable(join(path, name));
  }
}

function addInstalledNodeProject(): void {
  execFileSync("git", ["config", "user.name", "Verified Test Operator"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "operator@example.com"], { cwd: repo });
  const manifest = {
    name: "init-fixture",
    scripts: { typecheck: "tiny-check", test: "tiny-check" },
    dependencies: { tiny: "1.0.0" },
  };
  const lock = {
    name: "init-fixture",
    lockfileVersion: 3,
    packages: {
      "": { name: "init-fixture", dependencies: { tiny: "1.0.0" } },
      "node_modules/tiny": { version: "1.0.0", integrity: "sha512-fixture" },
    },
  };
  const hidden = {
    name: "init-fixture",
    lockfileVersion: 3,
    packages: {
      "node_modules/tiny": { version: "1.0.0", integrity: "sha512-fixture" },
    },
  };
  writeFileSync(join(repo, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(repo, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  mkdirSync(join(repo, "node_modules/tiny"), { recursive: true });
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  writeFileSync(
    join(repo, "node_modules/tiny/package.json"),
    '{"name":"tiny","version":"1.0.0","bin":{"tiny-check":"check.js"}}\n',
  );
  writeFileSync(join(repo, "node_modules/tiny/check.js"), "#!/usr/bin/env node\nconsole.log('2 passed')\n");
  chmodSync(join(repo, "node_modules/tiny/check.js"), 0o755);
  symlinkSync("../tiny/check.js", join(repo, "node_modules/.bin/tiny-check"));
  writeFileSync(
    join(repo, "node_modules/.package-lock.json"),
    `${JSON.stringify(hidden, null, 2)}\n`,
  );
  execFileSync("git", ["add", "package.json", "package-lock.json", ".gitignore"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "node project"], { cwd: repo });
}

describe("init", () => {
  it("does not require ASF or ctxlane configuration for standalone setup", async () => {
    initGitRepo();
    addInstalledNodeProject();
    const h = harness();
    const poison = {
      RUNMILL_ASF_CONTROL_CONTROLLER_ID: "invalid standalone poison",
      RUNMILL_ASF_CONTROL_KEY_ID: "invalid standalone poison",
      RUNMILL_ASF_CONTROL_KEY_FILE: join(data, "must-not-be-read.key"),
      RUNMILL_ASF_RUNTIME_MODULE: join(data, "must-not-be-read.mjs"),
      RUNMILL_ASF_DAEMON_REGISTRY: join(data, "must-not-be-read.json"),
      RUNMILL_CTXLANE_ENDPOINT: "unix:///must/not/be-contacted.sock",
    } as const;
    const previous = new Map(
      Object.keys(poison).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, poison);

    try {
      expect(await h.run(["init"])).toBe(0);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(existsSync(policy)).toBe(true);
    expect(h.failures).toEqual([]);
  });

  it("writes the operator policy, manifest, and both review skills", async () => {
    initGitRepo();
    addInstalledNodeProject();
    const h = harness();
    expect(await h.run(["init"])).toBe(0);

    expect(existsSync(policy), "operator policy was not written").toBe(true);
    for (const file of [".runmill/checks.yaml", ".runmill/skills/code-review.md", ".runmill/skills/pr-review.md"]) {
      expect(existsSync(join(repo, file)), `${file} was not written`).toBe(true);
    }
  });

  it("writes the schema the generated config points at", async () => {
    // policy.yaml opens with `# yaml-language-server: $schema=./runmill.schema.json`.
    // Without the file beside it every editor with the YAML extension opens the
    // config on a "cannot load schema" error and none of the completion the
    // header advertises works — on the first file runmill ever shows a user.
    initGitRepo();
    const h = harness();
    await h.run(["init"]);

    const config = readFileSync(policy, "utf8");
    const referenced = config.match(/\$schema=\.\/(\S+)/)?.[1];
    expect(referenced).toBe("runmill.schema.json");
    expect(existsSync(join(policy, "..", referenced as string))).toBe(true);
  });

  it("writes a schema that is valid JSON describing runmill.yaml", async () => {
    initGitRepo();
    const h = harness();
    await h.run(["init"]);

    const schema = JSON.parse(readFileSync(join(policy, "..", "runmill.schema.json"), "utf8")) as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties).toHaveProperty("autonomy");
    expect(schema.properties).toHaveProperty("backlog");
  });

  it("keeps its own runtime state out of the repository it manages", async () => {
    // runmill runs inside the repository it works on, and writes a SQLite
    // database and WAL beside the config it just told the operator to commit.
    // Without this, `git status` is dirty from the first run onward and the
    // obvious `git add .` puts a binary database into the history.
    initGitRepo();
    const h = harness();
    await h.run(["init"]);

    const ignore = readFileSync(join(repo, ".runmill/.gitignore"), "utf8");
    expect(ignore).toContain("state/");
  });

  it("still tracks the repository-owned files init tells the team to edit", async () => {
    // The manifest and the review skills are project configuration and belong
    // in version control. Ignoring the whole .runmill directory would take
    // them out with the database.
    initGitRepo();
    const h = harness();
    await h.run(["init"]);

    const ignore = readFileSync(join(repo, ".runmill/.gitignore"), "utf8");
    expect(ignore).not.toMatch(/^\*\s*$/m);
    expect(ignore).not.toContain("checks.yaml");
    expect(ignore).not.toContain("skills");
  });

  it("actually causes git to ignore the state directory", async () => {
    // Asserting on the file's text proves what was written, not what git does
    // with it. This is the property that matters.
    initGitRepo();
    const h = harness();
    await h.run(["init"]);
    mkdirSync(join(repo, ".runmill/state"), { recursive: true });
    writeFileSync(join(repo, ".runmill/state/runmill.db"), "binary");

    // -uall so git lists each untracked file rather than collapsing the
    // directory, which would hide whether the database was excluded.
    const status = execFileSync("git", ["status", "--porcelain", "-uall"], {
      cwd: repo,
    }).toString();

    expect(status).not.toContain("runmill.db");
    expect(status).toContain(".runmill/checks.yaml");
  });

  it("uses discovered repository and branch values in the operator policy", async () => {
    initGitRepo("git@github.com:acme/widget.git");
    const h = harness();
    await h.run(["init"]);
    const config = readFileSync(policy, "utf8");
    expect(config).toContain("acme/widget");
    expect(config).toContain("base_branch: main");
  });

  it("preserves an existing operator policy while creating every missing project asset", async () => {
    // Clobbering a tuned merge policy because someone re-ran init would be
    // unrecoverable without version control.
    initGitRepo();
    mkdirSync(join(policy, ".."), { recursive: true });
    writeFileSync(policy, "version: 1 # hand-tuned\n");
    const h = harness();
    await h.run(["init"]);
    expect(readFileSync(policy, "utf8")).toContain("hand-tuned");
    expect(existsSync(join(repo, ".runmill/checks.yaml"))).toBe(true);
    expect(existsSync(join(repo, ".runmill/skills/code-review.md"))).toBe(true);
  });

  it("writes a config that is defaults-only where it cannot infer", async () => {
    // A guessed merge policy is not a guess worth making.
    initGitRepo();
    const h = harness();
    await h.run(["init"]);
    const config = readFileSync(policy, "utf8");
    expect(config).toContain("autonomy: pr-only");
  });

  it("produces a pr-only policy whose bundled checks can record honest unproven results", async () => {
    initGitRepo();
    addInstalledNodeProject();
    const h = harness();
    expect(await h.run(["init"])).toBe(0);

    const config = parseConfig(readFileSync(policy, "utf8"));
    const manifest = loadChecksManifest({
      repoRoot: repo,
      manifestPath: config.verification.manifest,
    });
    expect(manifest).toBeDefined();
    expect(config.verification.failOnSkippedCheck).toBe(false);

    const workspaces = new WorkspaceManager();
    const workspace = await workspaces.create({
      runId: "init-verification",
      branch: "runmill/init-verification",
      sourceRepo: repo,
      baseBranch: "main",
      root: join(data, "runs"),
      isolation: "clone",
    });
    const sandbox = {
      run: async (input: Parameters<Sandbox["run"]>[0]) => {
        const started = Date.now();
        const result = await runProcess(input.command, input.args, {
          cwd: input.cwd,
          ...(input.env === undefined ? {} : { env: { ...process.env, ...input.env } }),
          timeoutMs: input.timeoutMs,
        });
        return {
          outcome: "exited" as const,
          exitCode: result.code,
          signal: null,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: Date.now() - started,
        };
      },
    } as unknown as Sandbox;

    const outcome = await new VerificationEngine(sandbox).run({
      workspace,
      workspaces,
      manifest: manifest?.checks ?? [],
      candidateSha: await workspaces.headSha(workspace),
      failOnMissingCheck: config.verification.failOnMissingCheck,
      failOnSkippedCheck: config.verification.failOnSkippedCheck,
    });

    expect(outcome.mergeReady).toBe(true);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.every((result) => result.coverage === "unproven")).toBe(true);
    expect(outcome.results.every((result) => result.status === "passed")).toBe(true);
    await workspaces.destroy(workspace, repo);
  });

  it("blocks setup rather than guessing checks for a repository it cannot identify", async () => {
    initGitRepo();
    const h = harness();

    expect(await h.run(["init"])).toBe(3);
    expect(readFileSync(join(repo, ".runmill/checks.yaml"), "utf8")).toContain("checks: []");
    expect(h.emitted[0]?.human).toContain("verification");
    expect(h.emitted[0]?.human).toContain("declares no checks");
    expect(h.emitted[0]?.human).not.toContain("runmill start");
  });

  it("is idempotent per file and never overwrites customized project assets", async () => {
    initGitRepo();
    const h = harness();
    await h.run(["init"]);
    writeFileSync(join(repo, ".runmill/checks.yaml"), "# team-owned checks\n");
    const originalPolicy = readFileSync(policy, "utf8");

    await h.run(["init"]);

    expect(readFileSync(policy, "utf8")).toBe(originalPolicy);
    expect(readFileSync(join(repo, ".runmill/checks.yaml"), "utf8")).toBe("# team-owned checks\n");
    expect(h.emitted.at(-1)?.human).toContain("Preserved:");
  });

  it("runs doctor after writing the setup, then gives the preview and start commands", async () => {
    initGitRepo();
    addInstalledNodeProject();
    const h = harness({
      onDoctor: () => {
        expect(existsSync(policy)).toBe(true);
        expect(existsSync(join(repo, ".runmill/checks.yaml"))).toBe(true);
      },
    });
    await h.run(["init"]);
    expect(h.doctorCalls).toEqual([{ repoRoot: repo, configPath: policy }]);
    expect(h.emitted[0]?.human).toContain("provider:codex:request");
    expect(h.emitted[0]?.human).toContain("overall: PASS");
    expect(h.emitted[0]?.human).not.toContain("runmill doctor");
    expect(h.emitted[0]?.human).toContain("runmill next");
    expect(h.emitted[0]?.human).toContain("runmill start");
  });

  it("withholds start commands when locked npm dependencies are not installed", async () => {
    initGitRepo();
    addInstalledNodeProject();
    rmSync(join(repo, "node_modules"), { recursive: true, force: true });
    const h = harness();

    expect(await h.run(["init"])).toBe(3);

    expect(h.emitted[0]?.human).toContain("verification:dependencies");
    expect(h.emitted[0]?.human).toContain("npm ci");
    expect(h.emitted[0]?.human).not.toContain("runmill next");
    expect(h.emitted[0]?.human).not.toContain("runmill start");
  });

  it("fails visibly and withholds run commands when doctor cannot prove readiness", async () => {
    initGitRepo();
    const h = harness({
      doctorResults: [
        {
          id: "provider:codex:request",
          status: "fail",
          observed: "provider exited successfully but did not return the readiness marker",
          expected: "one minimal provider request completes inside the actual Runmill sandbox",
          remediation: "Check provider access, then rerun doctor",
        },
      ],
    });

    expect(await h.run(["init"])).toBe(3);
    expect(existsSync(policy), "init must preserve the useful files it wrote").toBe(true);
    expect(h.emitted[0]?.human).toContain("overall: FAIL");
    expect(h.emitted[0]?.human).toContain("cannot start yet");
    expect(h.emitted[0]?.human).not.toContain("runmill next");
    expect(h.emitted[0]?.human).not.toContain("runmill start");
  });

  it("withholds first-run commands when candidate commit provenance is not ready", async () => {
    initGitRepo();
    const h = harness({
      doctorResults: [
        {
          id: "git:provenance",
          status: "fail",
          code: "RM-WORKSPACE-004",
          observed: "source Git identity still uses the runmill@localhost placeholder",
          expected: "an explicit non-placeholder identity and a usable configured signer",
          remediation:
            "Configure a verified identity, then run `runmill doctor --check git:provenance`",
        },
      ],
    });

    expect(await h.run(["init"])).toBe(3);
    expect(h.emitted[0]?.human).toContain("git:provenance");
    expect(h.emitted[0]?.human).toContain("runmill@localhost");
    expect(h.emitted[0]?.human).not.toContain("runmill next");
    expect(h.emitted[0]?.human).not.toContain("runmill start");
  });
});

describe("skills", () => {
  it("ejects the built-in rubrics so they can be edited", async () => {
    const h = harness();
    await h.run(["skills", "eject"]);
    expect(existsSync(join(repo, ".runmill/skills/code-review.md"))).toBe(true);
    expect(existsSync(join(repo, ".runmill/skills/pr-review.md"))).toBe(true);
  });

  it("validates the skills it just ejected", async () => {
    const h = harness();
    await h.run(["skills", "eject"]);
    expect(await h.run(["skills", "validate"])).toBe(0);
  });

  it("rejects a skill with no frontmatter rather than failing at review time", async () => {
    // FR-22: a malformed skill must fail before a run spends money, not after.
    mkdirSync(join(repo, ".runmill", "skills"), { recursive: true });
    writeFileSync(join(repo, ".runmill/skills/code-review.md"), "no frontmatter here\n");
    writeFileSync(join(repo, ".runmill/skills/pr-review.md"), "also broken\n");
    const h = harness();
    expect(await h.run(["skills", "validate"])).not.toBe(0);
  });
});

describe("gc", () => {
  function seedRun(runId: string, state: string): void {
    const store = StateStore.open(join(data, "runmill.db"), { clock: new SystemClock() });
    store.createRun({
      runId,
      issueId: "ENG-1",
      repo: "acme/widget",
      provider: "codex",
    });
    store.transitionRun(runId, { from: "DISCOVERED", to: state, expectedVersion: 1 });
    store.close();
    mkdirSync(join(data, "runs", runId), { recursive: true });
  }

  it("removes workspaces for runs that reached a terminal state", async () => {
    seedRun("run_done", "PR_DELIVERED");
    const h = harness();
    expect(await h.run(["gc"])).toBe(0);
    expect(existsSync(join(data, "runs", "run_done"))).toBe(false);
  });

  it("KEEPS the workspace of a run still in flight", async () => {
    // A live run's working tree is the only copy of that work; deleting it to
    // tidy up is not a trade worth making.
    seedRun("run_live", "IMPLEMENTING");
    const h = harness();
    await h.run(["gc"]);
    expect(existsSync(join(data, "runs", "run_live"))).toBe(true);
    const payload = h.emitted[0]?.data as { kept: unknown[] };
    expect(payload.kept).toHaveLength(1);
  });

  it("removes a workspace with no run record at all", async () => {
    // The database was reset, or the run never got far enough to be recorded.
    // Nothing can resume it.
    mkdirSync(join(data, "runs", "run_orphan"), { recursive: true });
    const h = harness();
    await h.run(["gc"]);
    expect(existsSync(join(data, "runs", "run_orphan"))).toBe(false);
  });

  it("--dry-run reports without removing anything", async () => {
    seedRun("run_done", "COMPLETED");
    const h = harness();
    await h.run(["gc", "--dry-run"]);
    expect(existsSync(join(data, "runs", "run_done"))).toBe(true);
    expect(h.emitted[0]?.human).toMatch(/Would remove/);
  });

  it("succeeds when there is nothing to reconcile", async () => {
    const h = harness();
    expect(await h.run(["gc"])).toBe(0);
    expect(h.emitted[0]?.human).toContain("(none)");
  });
});

describe("inspect", () => {
  it("reports that a run does not exist rather than throwing", async () => {
    const h = harness();
    await h.run(["inspect", "run_nope"]);
    expect(JSON.stringify(h.emitted[0]?.data)).toContain("false");
  });

  it("renders state and transitions for a real run", async () => {
    const store = StateStore.open(join(data, "runmill.db"), { clock: new SystemClock() });
    store.createRun({
      runId: "run_x",
      issueId: "ENG-7",
      repo: "acme/widget",
      provider: "codex",
    });
    store.transitionRun("run_x", { from: "DISCOVERED", to: "CLAIMED", expectedVersion: 1 });
    store.close();

    const h = harness();
    await h.run(["inspect", "run_x"]);
    expect(h.emitted[0]?.human).toContain("run_x");
    expect(h.emitted[0]?.human).toContain("CLAIMED");
  });
});

describe("effects", () => {
  function seedPendingEffect(): string {
    const store = StateStore.open(join(data, "runmill.db"), { clock: new SystemClock() });
    store.createRun({
      runId: "run_effect",
      issueId: "ENG-9",
      repo: "acme/widget",
      provider: "codex",
    });
    const key = store.intendSideEffect({
      runId: "run_effect",
      system: "github",
      operation: "merge",
      target: "acme/widget#17",
    });
    store.markSideEffectInFlight(key);
    store.failSideEffect(key, "connection closed after request");
    store.close();
    return key;
  }

  it("lists the exact ambiguous effect", async () => {
    const key = seedPendingEffect();
    const h = harness();

    expect(await h.run(["effects", "list"])).toBe(0);
    expect(h.emitted[0]?.human).toContain(key);
    expect(h.emitted[0]?.human).toContain("acme/widget#17");
  });

  it("requires a valid observed outcome", async () => {
    const key = seedPendingEffect();
    const h = harness();

    expect(await h.run(["effects", "resolve", key, "--outcome", "maybe"])).toBe(1);
    expect(String(h.failures[0])).toMatch(/applied or not-applied/);
  });

  it("records explicit reconciliation and unblocks the outbox", async () => {
    const key = seedPendingEffect();
    const h = harness();

    expect(
      await h.run(["effects", "resolve", key, "--outcome", "not-applied"]),
    ).toBe(0);

    const store = StateStore.open(join(data, "runmill.db"), { clock: new SystemClock() });
    expect(store.pendingSideEffects()).toHaveLength(0);
    expect(store.getSideEffect(key)).toMatchObject({
      status: "confirmed",
      remoteId: "operator:not-applied",
    });
    store.close();
  });
});

describe("leases", () => {
  function seedLease(issueId: string): string {
    const origin = join(data, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    initGitRepo(origin);
    execFileSync("git", ["config", "user.name", "Test Operator"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "operator@example.test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "seed\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });

    const store = StateStore.open(join(data, "runmill.db"), { clock: new SystemClock() });
    const runId = `run_${issueId}`;
    store.createRun({ runId, issueId, repo: "acme/widget", provider: "codex" });
    store.recordLease({
      issueId,
      runId,
      repo: "acme/widget",
      generation: 1,
      expiresAt: "2026-08-21T10:00:00.000Z",
      refName: leaseRefName(issueId),
    });
    store.close();
    return origin;
  }

  it("refuses to clear local ownership while the remote lease ref exists", async () => {
    seedLease("ENG-12");
    execFileSync(
      "git",
      ["push", "-q", "origin", `HEAD:${leaseRefName("ENG-12")}`],
      { cwd: repo },
    );
    const h = harness();

    expect(
      await h.run(["leases", "resolve", "ENG-12", "--confirm-remote-cleared"]),
    ).toBe(1);
    const store = StateStore.open(join(data, "runmill.db"), { clock: new SystemClock() });
    expect(store.getLease("ENG-12")).toBeDefined();
    store.close();
  });

  it("clears only the local row after the exact remote ref is absent", async () => {
    seedLease("ENG-13");
    const h = harness();

    expect(await h.run(["leases", "list"])).toBe(0);
    expect(h.emitted[0]?.human).toContain("ENG-13");
    expect(
      await h.run(["leases", "resolve", "ENG-13", "--confirm-remote-cleared"]),
    ).toBe(0);

    const store = StateStore.open(join(data, "runmill.db"), { clock: new SystemClock() });
    expect(store.getLease("ENG-13")).toBeUndefined();
    store.close();
  });
});

describe("resume", () => {
  it("refuses checkpoint continuation without recording a misleading decision", async () => {
    const store = StateStore.open(join(data, "runmill.db"), { clock: new SystemClock() });
    store.createRun({
      runId: "run_stopped",
      issueId: "ENG-10",
      repo: "acme/widget",
      provider: "codex",
    });
    store.transitionRun("run_stopped", {
      from: "DISCOVERED",
      to: "NEEDS_HUMAN",
      expectedVersion: 1,
    });
    store.close();

    const h = harness();
    expect(
      await h.run(["resume", "run_stopped", "--answer", "approve"]),
    ).toBe(3);
    expect(h.emitted[0]?.human).toContain("checkpoint continuation is not implemented");

    const reopened = StateStore.open(join(data, "runmill.db"), { clock: new SystemClock() });
    expect(reopened.eventsFor("run_stopped")).toHaveLength(0);
    expect(reopened.getRun("run_stopped")?.state).toBe("NEEDS_HUMAN");
    reopened.close();
  });
});

describe("policy explain", () => {
  it("lists the gates in evaluation order", async () => {
    const store = StateStore.open(join(data, "runmill.db"), { clock: new SystemClock() });
    store.createRun({
      runId: "run_p",
      issueId: "ENG-7",
      repo: "acme/widget",
      provider: "codex",
    });
    store.transitionRun("run_p", { from: "DISCOVERED", to: "PR_DELIVERED", expectedVersion: 1 });
    store.close();

    const h = harness();
    await h.run(["policy", "explain", "run_p"]);
    const out = h.emitted[0]?.human ?? "";
    expect(out).toMatch(/lease held/);
    expect(out).toMatch(/branch protection/);
    // The gate that distinguishes guarded-merge from pr-only.
    expect(out).toMatch(/cannot edit branch protection/);
    expect(out).toMatch(/never merges by design/);
  });

  it("says so when the run does not exist", async () => {
    const h = harness();
    await h.run(["policy", "explain", "run_missing"]);
    expect(h.emitted[0]?.human).toContain("No run");
  });
});

describe("auth login", () => {
  it("rejects the legacy token option before reading or storing its value", async () => {
    const secret = "github_pat_legacy_argv";
    const h = harness({ credentialInput: "must-not-be-read" });

    expect(await h.run(["auth", "login", "github", `--token=${secret}`])).toBe(1);

    expect(h.storedCredentials).toEqual([]);
    const message = (h.failures[0] as { whatHappened: string }).whatHappened;
    expect(message).toMatch(/process arguments are public/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain("must-not-be-read");
  });

  it("accepts a credential only from stdin and never echoes it", async () => {
    const secret = "lin_api_private_input";
    const h = harness({ credentialInput: `${secret}\n` });

    expect(await h.run(["auth", "login", "linear"])).toBe(0);

    expect(h.storedCredentials).toEqual([{ name: "linear", value: secret }]);
    const rendered = `${h.emitted.map((entry) => entry.human).join("\n")}${JSON.stringify(h.emitted)}`;
    expect(rendered).not.toContain(secret);
  });

  it("refuses a TTY without attempting to read or store a secret", async () => {
    const h = harness({ credentialInput: "must-not-be-read", stdinTTY: true });

    expect(await h.run(["auth", "login", "linear"])).toBe(1);

    expect(h.storedCredentials).toEqual([]);
    const message = (h.failures[0] as { whatHappened: string }).whatHappened;
    expect(message).toContain("printenv LINEAR_API_KEY | runmill auth login linear");
    expect(message).not.toContain("must-not-be-read");
  });

  it("refuses empty stdin with guidance that contains no placeholder secret", async () => {
    const h = harness({ credentialInput: "" });

    expect(await h.run(["auth", "login", "github"])).toBe(1);

    expect(h.storedCredentials).toEqual([]);
    const message = (h.failures[0] as { whatHappened: string }).whatHappened;
    expect(message).toContain("printenv GITHUB_TOKEN | runmill auth login github");
    expect(message).not.toMatch(/ghp_|github_pat_/u);
  });
});

describe("auth status", () => {
  it("reports where each credential resolves from, without printing values", async () => {
    const saved = process.env["LINEAR_API_KEY"];
    process.env["LINEAR_API_KEY"] = "lin_api_supersecret";
    try {
      const h = harness();
      await h.run(["auth", "status"]);
      const rendered = `${h.emitted[0]?.human}${JSON.stringify(h.emitted[0]?.data)}`;
      expect(rendered).toContain("linear");
      // The whole point of a status command is that it is safe to paste.
      expect(rendered).not.toContain("lin_api_supersecret");
    } finally {
      if (saved === undefined) delete process.env["LINEAR_API_KEY"];
      else process.env["LINEAR_API_KEY"] = saved;
    }
  });
});
