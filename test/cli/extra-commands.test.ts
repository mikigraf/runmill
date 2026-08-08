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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExtraCommands, type CommandContext } from "../../src/cli/extra-commands.js";
import { StateStore } from "../../src/state/store.js";
import { SystemClock } from "../../src/platform/clock.js";

/** Thrown in place of process.exit so a command's exit is observable. */
class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

interface Harness {
  readonly emitted: { human: string; data: unknown }[];
  readonly failures: unknown[];
  run(argv: string[]): Promise<number>;
}

let repo: string;
let data: string;
let originalExit: typeof process.exit;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "runmill-cmd-repo-"));
  data = mkdtempSync(join(tmpdir(), "runmill-cmd-data-"));
  originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Exited(code ?? 0);
  }) as typeof process.exit;
});

afterEach(() => {
  process.exit = originalExit;
  rmSync(repo, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

function harness(): Harness {
  const emitted: { human: string; data: unknown }[] = [];
  const failures: unknown[] = [];

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
    configPath: () => join(repo, "runmill.yaml"),
    repoRoot: () => repo,
    exitCodes: { ok: 0, failed: 1, configInvalid: 2, blocked: 3 },
  };
  return {
    emitted,
    failures,
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

describe("init", () => {
  it("writes the config, manifest, and both review skills", async () => {
    initGitRepo();
    const h = harness();
    expect(await h.run(["init"])).toBe(0);

    for (const file of [
      "runmill.yaml",
      ".runmill/checks.yaml",
      ".runmill/skills/code-review.md",
      ".runmill/skills/pr-review.md",
    ]) {
      expect(existsSync(join(repo, file)), `${file} was not written`).toBe(true);
    }
  });

  it("infers the repository and base branch from git", async () => {
    initGitRepo("git@github.com:acme/widget.git");
    const h = harness();
    await h.run(["init"]);
    const config = readFileSync(join(repo, "runmill.yaml"), "utf8");
    expect(config).toContain("acme/widget");
    expect(config).toContain("base_branch: main");
  });

  it("parses an https remote as well as ssh", async () => {
    initGitRepo("https://github.com/acme/other.git");
    const h = harness();
    await h.run(["init"]);
    expect(readFileSync(join(repo, "runmill.yaml"), "utf8")).toContain("acme/other");
  });

  it("refuses to overwrite an existing config", async () => {
    // Clobbering a tuned merge policy because someone re-ran init would be
    // unrecoverable without version control.
    initGitRepo();
    writeFileSync(join(repo, "runmill.yaml"), "version: 1 # hand-tuned\n");
    const h = harness();
    await h.run(["init"]);
    expect(readFileSync(join(repo, "runmill.yaml"), "utf8")).toContain("hand-tuned");
  });

  it("overwrites when --force is given", async () => {
    initGitRepo();
    writeFileSync(join(repo, "runmill.yaml"), "version: 1 # hand-tuned\n");
    const h = harness();
    await h.run(["init", "--force"]);
    expect(readFileSync(join(repo, "runmill.yaml"), "utf8")).not.toContain("hand-tuned");
  });

  it("writes a config that is defaults-only where it cannot infer", async () => {
    // A guessed merge policy is not a guess worth making.
    initGitRepo();
    const h = harness();
    await h.run(["init"]);
    const config = readFileSync(join(repo, "runmill.yaml"), "utf8");
    expect(config).toContain("autonomy: pr-only");
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
