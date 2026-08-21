import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
import type { CheckSpec } from "../../src/verification/engine.js";
import type { BacklogIssue } from "../../src/domain/types.js";

let root: string;
let origin: string;
let source: string;
let clock: FakeClock;
let store: StateStore;

const ISSUE: BacklogIssue = {
  identifier: "ENG-101",
  title: "Add a greeting helper",
  description:
    "We need a greeting helper.\n\nAcceptance criteria:\n- greet returns a greeting\n- it is covered by a test",
  priority: 2,
  labels: ["agent-ready"],
  state: "Todo",
  teamKey: "ENG",
  createdAt: "2026-07-01T00:00:00Z",
  canceled: false,
  completed: false,
  blockedBy: [],
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function config(overrides = ""): ReturnType<typeof parseConfig> {
  return parseConfig(`
version: 1
autonomy: pr-only
providers:
  implementer:
    implementation: codex
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
workspace:
  git_isolation: clone
${overrides}
`);
}

/** A check that genuinely runs in the sandbox and inspects the tree. */
const PASSING_CHECK: CheckSpec = {
  id: "unit",
  run: "/bin/cat greeting.ts",
  required: true,
  source: "repository-policy",
  report: { path: "report.json", format: "json" },
};

const GOOD_REVIEW = {
  verdict: "approved",
  scope_assessment: "within_scope",
  acceptance_criteria_met: [
    { criterion: "greet returns a greeting", met: true },
    { criterion: "it is covered by a test", met: true },
  ],
  findings: [],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runmill-e2e-"));
  origin = join(root, "origin.git");
  source = join(root, "source");

  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, source]);
  git(source, "config", "user.email", "s@test");
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

/** The happy-path provider script, shared so tests can hold a reference to it. */
function defaultProvider(): FakeProviderAdapter {
  return new FakeProviderAdapter({
    byRole: {
      implementer: [
        { kind: "say", text: "implementing" },
        { kind: "write", path: "greeting.ts", content: "export const greet = () => 'hi';\n" },
      ],
      "local-reviewer": [{ kind: "say", text: "reviewing" }],
    },
    outputByRole: { "local-reviewer": GOOD_REVIEW },
    costUsdPerCall: 0.25,
  });
}

function makeOrchestrator(opts: {
  provider?: FakeProviderAdapter;
  forge?: FakeForgeAdapter;
  backlog?: FakeBacklogAdapter;
  checks?: CheckSpec[];
  cfg?: ReturnType<typeof parseConfig>;
  log?: string[];
}) {
  const backlog = opts.backlog ?? new FakeBacklogAdapter([ISSUE]);
  const provider = opts.provider ?? defaultProvider();
  const forge = opts.forge ?? new FakeForgeAdapter();

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
      config: opts.cfg ?? config(),
      sourceRepoPath: source,
      workspaceRoot: join(root, "runs"),
      checks: opts.checks ?? [PASSING_CHECK],
      onEvent: (m) => opts.log?.push(m),
      ciPollIntervalMs: 1,
      sleep: async () => undefined,
    }),
  };
}

function lease(runId: string): GitRefLease {
  return new GitRefLease({
    cwd: source,
    runId,
    clock,
    ttlMinutes: 20,
    hostId: "host-1",
    pid: 1,
  });
}

const TARGET = { repo: "acme/platform", baseBranch: "main" };

describe("end-to-end: issue to governed pull request", () => {
  it("completes the whole loop and delivers a pull request", async () => {
    const log: string[] = [];
    const { orchestrator, forge, backlog } = makeOrchestrator({ log });

    const outcome = await orchestrator.run({
      runId: "run_1",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_1"),
    });

    expect(outcome.finalState).toBe("PR_DELIVERED");
    expect(outcome.prNumber).toBe(1);
    expect(outcome.costUsd).toBeGreaterThan(0);
    expect(forge.wasPushed("acme/platform", "runmill/ENG-101-add-a-greeting-helper-1")).toBe(true);
    expect(backlog.peek("ENG-101")?.state).toBe("In Review");
  }, 60_000);

  it("walks the specified state machine in order", async () => {
    const log: string[] = [];
    const { orchestrator } = makeOrchestrator({ log });
    await orchestrator.run({ runId: "run_1", issue: ISSUE, target: TARGET, lease: lease("run_1") });

    const states = store.transitionHistory("run_1").map((t) => t.to);
    expect(states).toEqual([
      "ELIGIBILITY_CHECKED",
      "CLAIMED",
      "WORKSPACE_READY",
      "TASK_PACKET_READY",
      "IMPLEMENTING",
      "LOCAL_VERIFY",
      "LOCAL_REVIEW",
      "PR_READY",
      "PUSHED",
      "PR_OPEN",
      "CI_WAIT",
      "PR_REVIEW",
      "PR_DELIVERED",
    ]);
  }, 60_000);

  it("records an outbox intent BEFORE every external mutation", async () => {
    const { orchestrator } = makeOrchestrator({});
    await orchestrator.run({ runId: "run_1", issue: ISSUE, target: TARGET, lease: lease("run_1") });

    // All confirmed by the end of a clean run, so nothing is left pending.
    expect(store.pendingSideEffects()).toHaveLength(0);
    const key = StateStore.sideEffectKey("run_1", "open-pr", "acme/platform#runmill/ENG-101-add-a-greeting-helper-1");
    expect(store.getSideEffect(key)?.status).toBe("confirmed");
  }, 60_000);

  it("leaves a failed external mutation PENDING for the recovery sweep", async () => {
    // Failure does not prove the effect did not land.
    const forge = new FakeForgeAdapter({
      applyThenTimeout: new Set(["merge"]),
      credentialCanWriteProtection: false,
    });
    const { orchestrator } = makeOrchestrator({
      forge,
      cfg: config("  merge:\n    method: squash\n"),
    });
    const cfg = config();
    const guarded = { ...cfg, autonomy: "guarded-merge" as const };
    const { orchestrator: guardedOrch } = makeOrchestrator({ forge, cfg: guarded });
    void orchestrator;

    const outcome = await guardedOrch.run({
      runId: "run_m",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_m"),
    });

    expect(outcome.finalState).toBe("QUARANTINED");
    const pending = store.pendingSideEffects();
    expect(pending.some((p) => p.operation === "merge" && p.status === "failed")).toBe(true);
  }, 60_000);

  it("releases the lease so the issue can be claimed again", async () => {
    const { orchestrator } = makeOrchestrator({});
    await orchestrator.run({ runId: "run_1", issue: ISSUE, target: TARGET, lease: lease("run_1") });
    const after = await lease("run_2").read("ENG-101");
    expect(after).toBeUndefined();
  }, 60_000);

  it("writes the task packet with acceptance criteria and forbidden paths", async () => {
    // Asserted against what the agent was actually handed, not against the
    // workspace afterwards: a successful run cleans its workspace up, so
    // reading the file later would only prove cleanup had not run yet.
    const provider = defaultProvider();
    const { orchestrator } = makeOrchestrator({ provider });
    await orchestrator.run({ runId: "run_1", issue: ISSUE, target: TARGET, lease: lease("run_1") });

    const packet = provider.capturedPackets[0] as {
      acceptance_criteria: string[];
      constraints: { forbidden_paths: string[] };
    };
    expect(packet.acceptance_criteria).toEqual([
      "greet returns a greeting",
      "it is covered by a test",
    ]);
    expect(packet.constraints.forbidden_paths).toContain(".runmill/**");
    expect(packet.constraints.forbidden_paths).toContain(".github/**");
  }, 60_000);

  it("records a delivered issue once in the markdown activity log", async () => {
    const { orchestrator } = makeOrchestrator({});
    await orchestrator.run({ runId: "run_log", issue: ISSUE, target: TARGET, lease: lease("run_log") });
    const body = readFileSync(join(source, ".runmill", "log.md"), "utf8");
    expect(body).toMatch(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
    expect(body).toContain("**ENG-101** Add a greeting helper");
    expect(body.match(/run `run_log`/g)).toHaveLength(1);
  }, 60_000);

  it("fences the issue body as untrusted data", async () => {
    const provider = defaultProvider();
    const { orchestrator } = makeOrchestrator({ provider });
    await orchestrator.run({ runId: "run_1", issue: ISSUE, target: TARGET, lease: lease("run_1") });
    const doc = provider.capturedIssueDocs[0] ?? "";
    expect(doc).toContain("UNTRUSTED DATA");
    expect(doc).toContain("```untrusted");
  }, 60_000);
});

describe("end-to-end: the loop refuses to proceed when it should", () => {
  it("escalates rather than delivering when a check fails", async () => {
    const failing: CheckSpec = {
      id: "unit",
      run: "/bin/cat does-not-exist.ts",
      required: true,
      source: "repository-policy",
    };
    const { orchestrator } = makeOrchestrator({ checks: [failing] });
    const outcome = await orchestrator.run({
      runId: "run_f",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_f"),
    });
    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    // The reason has to name the check. `failures` only carries policy
    // violations, so an ordinary non-zero exit used to leave the message
    // ending in a bare colon and the operator with nothing to go on.
    expect(outcome.reason).toMatch(/check "unit" failed/);
    expect(outcome.reason).toMatch(/verification failed/i);
  }, 90_000);

  it("escalates on a blocking review finding rather than opening a PR", async () => {
    const provider = new FakeProviderAdapter({
      byRole: {
        implementer: [
          { kind: "write", path: "greeting.ts", content: "export const greet = () => 'hi';\n" },
        ],
        fixer: [{ kind: "say", text: "cannot fix" }],
        "local-reviewer": [{ kind: "say", text: "reviewing" }],
      },
      outputByRole: {
        "local-reviewer": {
          verdict: "changes_required",
          scope_assessment: "within_scope",
          acceptance_criteria_met: GOOD_REVIEW.acceptance_criteria_met,
          findings: [
            {
              id: "REV-001",
              severity: "critical",
              category: "correctness",
              title: "greeting is not atomic",
              evidence: { path: "greeting.ts", start_line: 1, end_line: 1 },
              claim: "two callers observe different greetings",
              required_resolution: "make it deterministic",
              confidence: 0.9,
            },
          ],
        },
      },
    });
    const { orchestrator, forge } = makeOrchestrator({ provider });
    const outcome = await orchestrator.run({
      runId: "run_r",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_r"),
    });
    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toMatch(/blocking finding/i);
    expect(forge.openPullRequests()).toHaveLength(0);
  }, 90_000);

  it("says what was actually wrong with the review, not just the category", async () => {
    // "Review output did not match the schema" is the same sentence whether
    // the reviewer emitted the wrong shape or emitted nothing at all, and a
    // provider the sandbox killed produces the second. The specific line is
    // the difference between suspecting the prompt and suspecting the sandbox.
    // A reviewer that runs, succeeds, and writes nothing -- what a provider
    // killed by the sandbox actually looks like from here.
    const provider = new FakeProviderAdapter({
      byRole: {
        implementer: [
          { kind: "say", text: "implementing" },
          { kind: "write", path: "greeting.ts", content: "export const greet = () => 'hi';\n" },
        ],
        "local-reviewer": [{ kind: "say", text: "reviewing" }],
      },
      silentRoles: ["local-reviewer"],
      costUsdPerCall: 0.25,
    });
    const { orchestrator } = makeOrchestrator({ provider });

    const outcome = await orchestrator.run({
      runId: "run_norev",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_norev"),
    });

    expect(outcome.finalState).toBe("QUARANTINED");
    expect(outcome.reason).toMatch(/no structured output/i);
  }, 90_000);

  it("quarantines on a malformed review rather than treating it as a pass", async () => {
    const provider = new FakeProviderAdapter({
      byRole: {
        implementer: [
          { kind: "write", path: "greeting.ts", content: "export const greet = () => 'hi';\n" },
        ],
        "local-reviewer": [{ kind: "say", text: "reviewing" }],
      },
      outputByRole: { "local-reviewer": { verdict: "totally-fine" } },
    });
    const { orchestrator, forge } = makeOrchestrator({ provider });
    const outcome = await orchestrator.run({
      runId: "run_bad",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_bad"),
    });
    expect(outcome.finalState).toBe("QUARANTINED");
    expect(forge.openPullRequests()).toHaveLength(0);
  }, 90_000);

  it("refuses to merge when the credential can rewrite branch protection", async () => {
    const forge = new FakeForgeAdapter({ credentialCanWriteProtection: true });
    const cfg = { ...config(), autonomy: "guarded-merge" as const };
    const { orchestrator } = makeOrchestrator({ forge, cfg });
    const outcome = await orchestrator.run({
      runId: "run_p",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_p"),
    });
    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toMatch(/branch protection/i);
  }, 90_000);

  it("does not mutate the repository in observe mode", async () => {
    const cfg = { ...config(), autonomy: "observe" as const };
    const { orchestrator, forge, backlog } = makeOrchestrator({ cfg });
    const outcome = await orchestrator.run({
      runId: "run_o",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_o"),
    });
    expect(outcome.finalState).toBe("COMPLETED");
    expect(forge.calls).toHaveLength(0);
    expect(backlog.peek("ENG-101")?.state).toBe("Todo");
  }, 60_000);

  it("blocks a second run from claiming the same issue while one is live", async () => {
    const { orchestrator } = makeOrchestrator({});
    const first = orchestrator.run({
      runId: "run_1",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_1"),
    });
    await first;

    // Re-acquire to simulate a live holder, then race a second run.
    const held = await lease("run_hold").acquire("ENG-101");
    expect(held.generation).toBe(1);

    const { orchestrator: second } = makeOrchestrator({});
    const outcome = await second.run({
      runId: "run_2",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_2"),
    });
    expect(outcome.finalState).toBe("QUARANTINED");
    expect(outcome.reason).toMatch(/already leased/i);
  }, 90_000);
});

describe("guarded merge", () => {
  it("merges when every gate passes and records the merge sha", async () => {
    // credentialCanWriteProtection: false is the properly-scoped App token.
    // The fake defaults to true, mirroring the real adapter's fail-closed
    // answer when it cannot determine the credential's power.
    const forge = new FakeForgeAdapter({ credentialCanWriteProtection: false });
    const cfg = { ...config(), autonomy: "guarded-merge" as const };
    const { orchestrator, backlog } = makeOrchestrator({ forge, cfg });

    const outcome = await orchestrator.run({
      runId: "run_g",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_g"),
    });

    expect(outcome.finalState).toBe("COMPLETED");
    expect(outcome.mergeSha).toBe("merge-1");
    expect(backlog.peek("ENG-101")?.state).toBe("Done");
  }, 90_000);

  it("waits for approval when branch protection requires it", async () => {
    const forge = new FakeForgeAdapter({
      requiresApproval: true,
      credentialCanWriteProtection: false,
    });
    const cfg = { ...config(), autonomy: "guarded-merge" as const };
    const { orchestrator } = makeOrchestrator({ forge, cfg });
    const outcome = await orchestrator.run({
      runId: "run_a",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_a"),
    });
    expect(outcome.finalState).toBe("AWAITING_APPROVAL");
    expect(outcome.mergeSha).toBeUndefined();
  }, 90_000);

  it("cleans up the workspace only after a fully completed run", async () => {
    const forge = new FakeForgeAdapter({ credentialCanWriteProtection: false });
    const cfg = { ...config(), autonomy: "guarded-merge" as const };
    const { orchestrator } = makeOrchestrator({ forge, cfg });
    await orchestrator.run({ runId: "run_c", issue: ISSUE, target: TARGET, lease: lease("run_c") });
    expect(existsSync(join(root, "runs", "run_c"))).toBe(false);
  }, 90_000);
});

/**
 * The PR-review stage.
 *
 * It shipped as scaffolding for a long time: `runmill init` wrote
 * `.runmill/skills/pr-review.md`, config exposed `review.pr_review_skill`,
 * budgets reserved `pr_review` and `pr_fixer` invocations, and the PR_REVIEW
 * state existed — while nothing ran. A developer editing that skill file saw no
 * effect whatsoever.
 */
describe("PR review", () => {
  const BLOCKING_PR_REVIEW = {
    verdict: "changes_required",
    scope_assessment: "within_scope",
    acceptance_criteria_met: GOOD_REVIEW.acceptance_criteria_met,
    findings: [
      {
        id: "PR-001",
        severity: "critical",
        category: "correctness",
        title: "off-by-one in the greeting index",
        evidence: { path: "greeting.ts", start_line: 1, end_line: 1 },
        claim: "the last caller reads past the end",
        required_resolution: "bound the index",
        confidence: 0.95,
      },
    ],
  };

  it("runs after CI and before the merge decision", async () => {
    const provider = defaultProvider();
    const { orchestrator } = makeOrchestrator({ provider });
    await orchestrator.run({ runId: "run_p", issue: ISSUE, target: TARGET, lease: lease("run_p") });

    const roles = provider.startedRequests.map((r) => r.role);
    expect(roles).toContain("pr-reviewer");
    // The point of a second review is that it sees the change as a reviewer
    // does — after CI, not in the implementer's working tree.
    expect(roles.indexOf("pr-reviewer")).toBeGreaterThan(roles.indexOf("local-reviewer"));
  }, 90_000);

  it("never grants the reviewer a writable path", async () => {
    // Something whose only job is to form an opinion has no business editing
    // the thing it judges.
    const provider = defaultProvider();
    const { orchestrator } = makeOrchestrator({ provider });
    await orchestrator.run({ runId: "run_p2", issue: ISSUE, target: TARGET, lease: lease("run_p2") });

    for (const req of provider.startedRequests.filter((r) => r.role === "pr-reviewer")) {
      expect(req.allowedPaths).toEqual([]);
    }
  }, 90_000);

  it("dispatches a fixer for a blocking finding and re-pushes the branch", async () => {
    let reviews = 0;
    const provider = new FakeProviderAdapter({
      byRole: {
        implementer: [
          { kind: "write", path: "greeting.ts", content: "export const greet = () => 'hi';\n" },
        ],
        // The fix must change the tree, or the loop correctly refuses to
        // re-review something identical.
        fixer: [{ kind: "write", path: "greeting.ts", content: "export const greet = () => 'hey';\n" }],
        "local-reviewer": [{ kind: "say", text: "reviewing" }],
        "pr-reviewer": [{ kind: "say", text: "reviewing the pr" }],
      },
      outputByRole: {
        "local-reviewer": GOOD_REVIEW,
        // Objects once, then accepts the fix.
        get "pr-reviewer"() {
          reviews += 1;
          return reviews === 1 ? BLOCKING_PR_REVIEW : GOOD_REVIEW;
        },
      },
      costUsdPerCall: 0.1,
    });
    const forge = new FakeForgeAdapter();
    const { orchestrator } = makeOrchestrator({ provider, forge });
    const outcome = await orchestrator.run({
      runId: "run_pf",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_pf"),
    });

    expect(outcome.finalState).toBe("PR_DELIVERED");
    expect(provider.startedRequests.filter((r) => r.role === "pr-reviewer").length).toBe(2);
    // Once for the original branch, once for the fix.
    const pushCalls = forge.calls.filter((c) => c.op === "push");
    expect(pushCalls.length).toBeGreaterThan(1);
  }, 120_000);

  it("escalates rather than delivering when the fixer cannot satisfy the review", async () => {
    const provider = new FakeProviderAdapter({
      byRole: {
        implementer: [
          { kind: "write", path: "greeting.ts", content: "export const greet = () => 'hi';\n" },
        ],
        fixer: [{ kind: "say", text: "cannot fix" }],
        "local-reviewer": [{ kind: "say", text: "reviewing" }],
        "pr-reviewer": [{ kind: "say", text: "still bad" }],
      },
      outputByRole: { "local-reviewer": GOOD_REVIEW, "pr-reviewer": BLOCKING_PR_REVIEW },
    });
    const { orchestrator } = makeOrchestrator({ provider });
    const outcome = await orchestrator.run({
      runId: "run_pu",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_pu"),
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    // A fixer that changes nothing means the next review reaches the same
    // verdict, so looping again would only spend money.
    expect(outcome.reason).toMatch(/no change|unresolved/i);
  }, 120_000);

  it("refuses to merge on an unparseable PR review", async () => {
    // An unparseable review is not an absent review. Its conclusion is
    // unknown, and unknown is not permission to merge.
    const provider = new FakeProviderAdapter({
      byRole: {
        implementer: [
          { kind: "write", path: "greeting.ts", content: "export const greet = () => 'hi';\n" },
        ],
        "local-reviewer": [{ kind: "say", text: "reviewing" }],
        "pr-reviewer": [{ kind: "say", text: "reviewing" }],
      },
      outputByRole: {
        "local-reviewer": GOOD_REVIEW,
        "pr-reviewer": { verdict: "approved" }, // schema-invalid: no scope_assessment
      },
    });
    const cfg = { ...config(), autonomy: "guarded-merge" as const };
    const forge = new FakeForgeAdapter();
    const { orchestrator } = makeOrchestrator({ provider, forge, cfg });
    const outcome = await orchestrator.run({
      runId: "run_pm",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_pm"),
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(forge.calls.filter((c) => c.op === "merge")).toEqual([]);
  }, 120_000);
});

describe("CI_WAIT", () => {
  /**
   * A required check does not exist the instant a pull request opens. Reading
   * the checks once meant every protected repository escalated on every run
   * with `"ci" has not reported yet`, and made the schedule deadline
   * unreachable, because the elapsed time could never grow past one glance.
   */
  class SlowCiForge extends FakeForgeAdapter {
    reads = 0;
    constructor(private readonly readsBeforeSuccess: number) {
      super({ requiredChecks: ["ci"] });
    }
    override async listChecks(input: {
      repo: string;
      ref: string;
    }): Promise<{ name: string; headSha: string; conclusion: "pending" | "success" }[]> {
      this.reads += 1;
      const headSha = (await super.listChecks(input), input.ref);
      return [
        {
          name: "ci",
          headSha,
          conclusion: this.reads >= this.readsBeforeSuccess ? "success" : "pending",
        },
      ];
    }
  }

  it("waits for a required check that has not reported yet", async () => {
    const forge = new SlowCiForge(3);
    const { orchestrator } = makeOrchestrator({ forge });

    const outcome = await orchestrator.run({
      runId: "run_ciwait",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_ciwait"),
    });

    expect(outcome.finalState).toBe("PR_DELIVERED");
    expect(forge.reads).toBeGreaterThanOrEqual(3);
  }, 90_000);

  it("stops on a failing check instead of waiting out the deadline", async () => {
    // A conclusion is an answer. Only "still running" is worth waiting on.
    class FailingCiForge extends FakeForgeAdapter {
      constructor() {
        super({ requiredChecks: ["ci"] });
      }
      override async listChecks(input: { repo: string; ref: string }): Promise<
        { name: string; headSha: string; conclusion: "failure" }[]
      > {
        return [{ name: "ci", headSha: input.ref, conclusion: "failure" }];
      }
    }
    const forge = new FailingCiForge();
    const { orchestrator } = makeOrchestrator({ forge });

    const outcome = await orchestrator.run({
      runId: "run_cifail",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_cifail"),
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toMatch(/CI not satisfied/);
  }, 90_000);
});
