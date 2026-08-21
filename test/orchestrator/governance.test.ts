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
  run: "/bin/cp verification-report-source.tap r.tap",
  required: true,
  source: "repository-policy",
  report: { path: "r.tap", format: "tap" },
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function config(autonomy: string): ReturnType<typeof parseConfig> {
  return parseConfig(`
version: 1
autonomy: ${autonomy}
experimental: { automatic_merge: true }
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
risk: { default: low }
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
  writeFileSync(
    join(source, "verification-report-source.tap"),
    "TAP version 13\n1..1\nok 1 - readme\n",
  );
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

function build(
  autonomy: string,
  forge: FakeForgeAdapter,
  cfg: ReturnType<typeof parseConfig> = config(autonomy),
  checks: readonly CheckSpec[] = [CHECK],
) {
  const backlog = new FakeBacklogAdapter([ISSUE]);
  const provider = new FakeProviderAdapter();
  return {
    backlog,
    provider,
    forge,
    orchestrator: new Orchestrator({
      backlog,
      provider,
      forge,
      store,
      clock,
      config: cfg,
      sourceRepoPath: source,
      sourceRepository: "acme/platform",
      workspaceRoot: join(root, "runs"),
      checks,
    }),
  };
}

function withRisk(
  overrides: Partial<ReturnType<typeof parseConfig>["risk"]>,
): ReturnType<typeof parseConfig> {
  const cfg = config("guarded-merge");
  return {
    ...cfg,
    risk: {
      ...cfg.risk,
      ...overrides,
      manualApproval: {
        ...cfg.risk.manualApproval,
        ...overrides.manualApproval,
      },
    },
  };
}

function lease(runId: string): GitRefLease {
  return new GitRefLease({ cwd: source, runId, clock, ttlMinutes: 20, hostId: "h", pid: 1 });
}

const TARGET = { repo: "acme/platform", baseBranch: "main" };

describe("verification policy runtime guard", () => {
  it("refuses an empty effective union before claiming or invoking an agent", async () => {
    const forge = new FakeForgeAdapter();
    const { orchestrator, backlog, provider } = build(
      "pr-only",
      forge,
      config("pr-only"),
      [],
    );

    const outcome = await orchestrator.run({
      runId: "run_empty_checks",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_empty_checks"),
    });

    expect(outcome).toMatchObject({ finalState: "QUARANTINED" });
    expect(outcome.reason).toMatch(/RM-VERIFY-001.*union is empty/i);
    expect(backlog.calls).toHaveLength(0);
    expect(provider.startedRequests).toHaveLength(0);
    expect(forge.calls).toHaveLength(0);
    expect(store.getRun("run_empty_checks")).toBeUndefined();
    expect(await lease("observer").read(ISSUE.identifier)).toBeUndefined();
  });
});

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
        { name: "build", conclusion: "success", headSha: "$ref", completedAt: "2026-08-06T10:00:00Z" },
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
        { name: "build", conclusion: "failure", headSha: "$ref", completedAt: "2026-08-06T10:00:00Z" },
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
        { name: "build", conclusion: "skipped", headSha: "$ref", completedAt: "2026-08-06T10:00:00Z" },
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

describe("automatic-merge risk policy", () => {
  it("stops at manual approval when a changed path matches policy", async () => {
    const forge = new FakeForgeAdapter({ credentialCanWriteProtection: false });
    const cfg = withRisk({
      manualApproval: { paths: ["RUNMILL_DEMO.md"], labels: [], conditions: [] },
    });
    const { orchestrator } = build("guarded-merge", forge, cfg);

    const outcome = await orchestrator.run({
      runId: "run_risk_path",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_risk_path"),
    });

    expect(outcome.finalState).toBe("AWAITING_APPROVAL");
    expect(outcome.reason).toMatch(/RUNMILL_DEMO\.md/);
    expect(forge.calls.some((call) => call.op === "merge")).toBe(false);
  }, 90_000);

  it("stops at manual approval when the issue has a configured label", async () => {
    const forge = new FakeForgeAdapter({ credentialCanWriteProtection: false });
    const cfg = withRisk({
      manualApproval: { paths: [], labels: ["agent-ready"], conditions: [] },
    });
    const { orchestrator } = build("guarded-merge", forge, cfg);

    const outcome = await orchestrator.run({
      runId: "run_risk_label",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_risk_label"),
    });

    expect(outcome.finalState).toBe("AWAITING_APPROVAL");
    expect(outcome.reason).toMatch(/agent-ready/);
    expect(forge.calls.some((call) => call.op === "merge")).toBe(false);
  }, 90_000);

  it("requires approval when the default risk tier is not low", async () => {
    const forge = new FakeForgeAdapter({ credentialCanWriteProtection: false });
    const { orchestrator } = build("guarded-merge", forge, withRisk({ default: "medium" }));

    const outcome = await orchestrator.run({
      runId: "run_risk_default",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_risk_default"),
    });

    expect(outcome.finalState).toBe("AWAITING_APPROVAL");
    expect(outcome.reason).toMatch(/risk\.default is medium/);
    expect(forge.calls.some((call) => call.op === "merge")).toBe(false);
  }, 90_000);

  it("fails closed when a configured condition cannot be evaluated", async () => {
    const forge = new FakeForgeAdapter({ credentialCanWriteProtection: false });
    const cfg = withRisk({
      manualApproval: { paths: [], labels: [], conditions: ["public_api_change"] },
    });
    const { orchestrator } = build("guarded-merge", forge, cfg);

    const outcome = await orchestrator.run({
      runId: "run_risk_unknown",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_risk_unknown"),
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toMatch(/could not be evaluated.*public_api_change/i);
    expect(forge.calls.some((call) => call.op === "merge")).toBe(false);
  }, 90_000);

  it("still delivers pr-only work when a manual-approval rule matches", async () => {
    const forge = new FakeForgeAdapter();
    const cfg = {
      ...withRisk({
        default: "critical",
        manualApproval: { paths: ["**"], labels: ["agent-ready"], conditions: [] },
      }),
      autonomy: "pr-only" as const,
    };
    const { orchestrator } = build("pr-only", forge, cfg);

    const outcome = await orchestrator.run({
      runId: "run_risk_pr_only",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_risk_pr_only"),
    });

    expect(outcome.finalState).toBe("PR_DELIVERED");
    expect(forge.calls.some((call) => call.op === "merge")).toBe(false);
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

describe("repository identity", () => {
  it("refuses a cross-repository route before any backlog, lease, or forge mutation", async () => {
    const forge = new FakeForgeAdapter();
    const { orchestrator, backlog } = build("pr-only", forge);
    const mismatched = { repo: "acme/other", baseBranch: "main" };

    const outcome = await orchestrator.run({
      runId: "run_wrong_repo",
      issue: ISSUE,
      target: mismatched,
      lease: lease("run_wrong_repo"),
    });

    expect(outcome.finalState).toBe("QUARANTINED");
    expect(outcome.reason).toMatch(/attached to acme\/platform/i);
    expect(backlog.calls).toHaveLength(0);
    expect(forge.calls).toHaveLength(0);
    expect(await lease("run_wrong_repo_probe").read(ISSUE.identifier)).toBeUndefined();
  });
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
