/**
 * Regression tests for governance gates that failed OPEN.
 *
 * Each of these guards a path where the system would have proceeded toward a
 * merge on the strength of missing information rather than refusing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { StateStore } from "../../src/state/store.js";
import { FakeBacklogAdapter } from "../../src/testing/fake-backlog.js";
import { FakeProviderAdapter } from "../../src/testing/fake-provider.js";
import { FakeForgeAdapter } from "../../src/testing/fake-forge.js";
import { FakeClock } from "../../src/testing/fake-clock.js";
import { GitRefLease } from "../../src/queue/git-lease.js";
import { parseConfig } from "../../src/config/load.js";
import type { BacklogIssue } from "../../src/domain/types.js";
import type { CheckSpec } from "../../src/verification/engine.js";

let root: string;
let source: string;
let clock: FakeClock;
let store: StateStore;

const ISSUE: BacklogIssue = {
  identifier: "ENG-1",
  title: "Add a helper",
  description:
    "We need a helper.\n\nAcceptance criteria:\n- it exists\n- it is tested and covered properly",
  priority: 2,
  labels: ["agent-ready"],
  state: "Todo",
  teamKey: "ENG",
  createdAt: "2026-07-01T00:00:00Z",
  canceled: false,
  completed: false,
  blockedBy: [],
};

const CHECK: CheckSpec = {
  id: "readme",
  run: "/bin/cat README.md",
  required: true,
  source: "repository-policy",
  report: { path: "r.json", format: "json" },
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function config(autonomy: string): ReturnType<typeof parseConfig> {
  return parseConfig(`
version: 1
autonomy: ${autonomy}
providers: { implementer: { implementation: codex } }
backlog:
  provider: linear
  team: ENG
  eligible_states: [Todo]
  claim_state: In Progress
  delivered_state: In Review
  completed_state: Done
github:
  repositories:
    - match: { team: ENG }
      repo: acme/platform
      base_branch: main
workspace: { git_isolation: clone }
`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runmill-gov-"));
  const origin = join(root, "origin.git");
  source = join(root, "source");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, source]);
  git(source, "config", "user.email", "s@t");
  git(source, "config", "user.name", "S");
  writeFileSync(join(source, "README.md"), "seed\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "seed");
  git(source, "push", "-q", "origin", "main");
  clock = new FakeClock("2026-08-06T10:00:00Z");
  store = StateStore.open(join(root, "state", "runmill.db"), { clock });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function build(autonomy: string, forge: FakeForgeAdapter) {
  const backlog = new FakeBacklogAdapter([ISSUE]);
  return {
    backlog,
    forge,
    orchestrator: new Orchestrator({
      backlog,
      provider: new FakeProviderAdapter(),
      forge,
      store,
      clock,
      config: config(autonomy),
      sourceRepoPath: source,
      workspaceRoot: join(root, "runs"),
      checks: [CHECK],
    }),
  };
}

function lease(runId: string): GitRefLease {
  return new GitRefLease({ cwd: source, runId, clock, ttlMinutes: 20, hostId: "h", pid: 1 });
}

const TARGET = { repo: "acme/platform", baseBranch: "main" };

describe("unreadable branch protection", () => {
  it("refuses rather than treating unknown rules as no rules", async () => {
    // The protection endpoint needs admin and commonly 403s. Returning an
    // empty required-check list made CI vacuously satisfied and approval
    // vacuously unnecessary — a fail-open in the middle of the merge gate.
    const forge = new FakeForgeAdapter({
      protectionUnreadable: true,
      credentialCanWriteProtection: false,
    });
    const { orchestrator } = build("guarded-merge", forge);
    const outcome = await orchestrator.run({
      runId: "run_u",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_u"),
    });
    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toMatch(/could not be read/i);
    expect(outcome.mergeSha).toBeUndefined();
  }, 90_000);

  it("does not merge on unreadable protection even when everything else passes", async () => {
    const forge = new FakeForgeAdapter({
      protectionUnreadable: true,
      credentialCanWriteProtection: false,
    });
    const { orchestrator } = build("guarded-merge", forge);
    await orchestrator.run({ runId: "run_u2", issue: ISSUE, target: TARGET, lease: lease("run_u2") });
    expect(forge.calls.some((c) => c.op === "merge")).toBe(false);
  }, 90_000);
});

describe("required check reconciliation", () => {
  it("satisfies a required context that reported success", async () => {
    // With no explicit mapping every context used to be `unmapped`, so any
    // protected repository escalated on every single run.
    const forge = new FakeForgeAdapter({
      requiredChecks: ["build"],
      checks: [
        { name: "build", conclusion: "success", headSha: "head-1", completedAt: "2026-08-06T10:00:00Z" },
      ],
    });
    const { orchestrator } = build("pr-only", forge);
    const outcome = await orchestrator.run({
      runId: "run_c",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_c"),
    });
    expect(outcome.finalState).toBe("PR_DELIVERED");
  }, 90_000);

  it("blocks on a required context that failed", async () => {
    const forge = new FakeForgeAdapter({
      requiredChecks: ["build"],
      checks: [
        { name: "build", conclusion: "failure", headSha: "head-1", completedAt: "2026-08-06T10:00:00Z" },
      ],
    });
    const { orchestrator } = build("pr-only", forge);
    const outcome = await orchestrator.run({
      runId: "run_cf",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_cf"),
    });
    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toMatch(/build/);
  }, 90_000);

  it("does not accept a skipped conclusion as coverage", async () => {
    // GitHub treats skipped as satisfying protection. runmill does not: a
    // check that did not run proves nothing.
    const forge = new FakeForgeAdapter({
      requiredChecks: ["build"],
      checks: [
        { name: "build", conclusion: "skipped", headSha: "head-1", completedAt: "2026-08-06T10:00:00Z" },
      ],
    });
    const { orchestrator } = build("pr-only", forge);
    const outcome = await orchestrator.run({
      runId: "run_cs",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_cs"),
    });
    expect(outcome.finalState).toBe("NEEDS_HUMAN");
  }, 90_000);
});

describe("observe mode", () => {
  it("acquires no lease, because acquiring one is a remote git push", async () => {
    const forge = new FakeForgeAdapter();
    const { orchestrator } = build("observe", forge);
    const outcome = await orchestrator.run({
      runId: "run_o",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_o"),
    });
    expect(outcome.finalState).toBe("COMPLETED");

    // The claim previously happened before the observe bail-out, so the log
    // line "no repository mutation" was false.
    const held = await lease("run_probe").read("ENG-1");
    expect(held).toBeUndefined();
  }, 60_000);

  it("touches neither the forge nor the backlog", async () => {
    const forge = new FakeForgeAdapter();
    const { orchestrator, backlog } = build("observe", forge);
    await orchestrator.run({ runId: "run_o2", issue: ISSUE, target: TARGET, lease: lease("run_o2") });
    expect(forge.calls).toHaveLength(0);
    expect(backlog.peek("ENG-1")?.state).toBe("Todo");
  }, 60_000);
});

describe("pull request evidence", () => {
  it("renders the real check results rather than claiming none were configured", async () => {
    const forge = new FakeForgeAdapter();
    const { orchestrator } = build("pr-only", forge);
    await orchestrator.run({ runId: "run_b", issue: ISSUE, target: TARGET, lease: lease("run_b") });

    const opened = forge.calls.find((c) => c.op === "openPullRequest");
    const body = (opened?.args as { body: string }).body;
    expect(body).toContain("readme");
    expect(body).not.toContain("no local checks configured");
  }, 90_000);
});
