import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { BacklogMutationNotStartedError } from "../../src/backlog/adapter.js";
import { selectNext } from "../../src/queue/selector.js";

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
experimental: { automatic_merge: true }
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
risk:
  default: low
${overrides}
`);
}

/** A check that genuinely runs in the sandbox and inspects the tree. */
const PASSING_CHECK: CheckSpec = {
  id: "unit",
  run: "/bin/cp verification-report-source.tap report.tap",
  required: true,
  source: "repository-policy",
  report: { path: "report.tap", format: "tap" },
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
  writeFileSync(
    join(source, "verification-report-source.tap"),
    "TAP version 13\n1..1\nok 1 - unit\n",
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
      sourceRepository: "acme/platform",
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
  it("delivers once and cannot reselect the issue on the next poll", async () => {
    const log: string[] = [];
    const { orchestrator, forge, backlog } = makeOrchestrator({ log });
    const cfg = config();

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
    const nextPoll = await selectNext({
      backlog,
      config: cfg,
      leasedIssueIds: store.activeLeaseIssueIds(),
    });
    expect(nextPoll.selected).toBeUndefined();
    expect(forge.calls.filter((call) => call.op === "openPullRequest")).toHaveLength(1);
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

  it("closes an outbox intent when a Linear lookup proves no mutation started", async () => {
    class MissingWorkflowStateBacklog extends FakeBacklogAdapter {
      override async transitionState(input: { identifier: string; toState: string }): Promise<void> {
        this.calls.push({ op: "transitionState", args: input });
        throw new BacklogMutationNotStartedError(
          "transitionState",
          `workflow state "${input.toState}" does not exist`,
        );
      }
    }
    const backlog = new MissingWorkflowStateBacklog([ISSUE]);
    const { orchestrator } = makeOrchestrator({ backlog });

    const outcome = await orchestrator.run({
      runId: "run_missing_state",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_missing_state"),
    });

    expect(outcome.finalState).toBe("QUARANTINED");
    expect(store.pendingSideEffects()).toHaveLength(0);
    const key = StateStore.sideEffectKey(
      "run_missing_state",
      "transition-claim",
      ISSUE.identifier,
    );
    expect(store.getSideEffect(key)).toMatchObject({
      status: "confirmed",
      remoteId: "orchestrator:not-applied",
    });
  });

  it("leaves a failed external mutation PENDING for the recovery sweep", async () => {
    // Failure does not prove the effect did not land.
    const forge = new FakeForgeAdapter({
      applyThenTimeout: new Set(["merge"]),
      credentialCanWriteProtection: false,
    });
    const cfg = config();
    const guarded = { ...cfg, autonomy: "guarded-merge" as const };
    const { orchestrator: guardedOrch } = makeOrchestrator({ forge, cfg: guarded });

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

  it("refuses all new work until an ambiguous external effect is reconciled", async () => {
    store.createRun({
      runId: "run_ambiguous",
      issueId: "ENG-9",
      repo: "acme/platform",
      provider: "codex",
    });
    const key = store.intendSideEffect({
      runId: "run_ambiguous",
      system: "github",
      operation: "merge",
      target: "acme/platform#9",
    });
    store.markSideEffectInFlight(key);
    store.failSideEffect(key, "response lost");

    const { orchestrator, forge, backlog } = makeOrchestrator({});
    const outcome = await orchestrator.run({
      runId: "run_blocked",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_blocked"),
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toContain("RM-STATE-002");
    expect(store.getRun("run_blocked")).toBeUndefined();
    expect(forge.calls).toHaveLength(0);
    expect(backlog.calls).toHaveLength(0);
    expect(await lease("observer").read(ISSUE.identifier)).toBeUndefined();
  });

  it("fences a stale worker before its next external mutation", async () => {
    class LeaseStealingForge extends FakeForgeAdapter {
      override async openPullRequest(
        input: Parameters<FakeForgeAdapter["openPullRequest"]>[0],
      ): ReturnType<FakeForgeAdapter["openPullRequest"]> {
        const pr = await super.openPullRequest(input);
        clock.advanceMinutes(31);
        await lease("run_takeover").takeover(ISSUE.identifier);
        return pr;
      }
    }

    const forge = new LeaseStealingForge();
    const { orchestrator } = makeOrchestrator({ forge });
    const outcome = await orchestrator.run({
      runId: "run_stale",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_stale"),
    });

    expect(outcome.finalState).toBe("QUARANTINED");
    expect(outcome.reason).toMatch(/fenced out|lease.*moved/i);
    expect(forge.calls.some((call) => call.op === "markReadyForReview")).toBe(false);
    const markReadyKey = StateStore.sideEffectKey(
      "run_stale",
      "mark-ready",
      "acme/platform#1",
    );
    expect(store.getSideEffect(markReadyKey)).toMatchObject({
      status: "confirmed",
      remoteId: "orchestrator:not-applied",
    });
  }, 60_000);

  it("gives a retry its own branch instead of the one it already pushed", async () => {
    // The branch template is validated to contain {attempt} for exactly this
    // reason, and the attempt was hardcoded to 1. A retry of an escalated issue
    // pushed to its own previous branch and quarantined: "! [rejected] ...
    // (fetch first)".
    const { orchestrator: first, forge } = makeOrchestrator({});
    await first.run({ runId: "run_a1", issue: ISSUE, target: TARGET, lease: lease("run_a1") });

    const { orchestrator: second } = makeOrchestrator({ forge });
    await second.run({ runId: "run_a2", issue: ISSUE, target: TARGET, lease: lease("run_a2") });

    const pushed = forge.calls
      .filter((c) => c.op === "push")
      .map((c) => (c.args as { branch: string }).branch);
    expect(pushed.length).toBeGreaterThanOrEqual(2);
    expect(new Set(pushed).size).toBe(pushed.length);
  }, 120_000);

  it("clears the lease in the state store, not only the git ref", async () => {
    // The ref and the store are two records of the same fact, and selection
    // reads the store. recordLease was called on claim and releaseLease was
    // called nowhere, so every issue that was ever claimed stayed "actively
    // leased" forever: a run that escalated could never be retried, and
    // `runmill resume` reported success while the next run answered
    // "not-leased: issue is actively leased by another run".
    const { orchestrator: o1 } = makeOrchestrator({});
    await o1.run({
      runId: "run_store_lease",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_store_lease"),
    });

    expect(store.activeLeaseIssueIds().has(ISSUE.identifier)).toBe(false);
  }, 90_000);

  it("clears the lease in the store even when the run escalates", async () => {
    // The case that matters: a clean delivery is not the one that needs
    // retrying. NEEDS_HUMAN keeps the workspace for inspection, and it must
    // still hand the issue back.
    const failing: CheckSpec = {
      id: "unit",
      run: "/bin/cat does-not-exist.ts",
      required: true,
      source: "repository-policy",
    };
    const { orchestrator: o, backlog } = makeOrchestrator({ checks: [failing] });
    const outcome = await o.run({
      runId: "run_store_lease_fail",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_store_lease_fail"),
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(store.activeLeaseIssueIds().has(ISSUE.identifier)).toBe(false);
    expect(backlog.peek(ISSUE.identifier)?.state).toBe("Todo");
  }, 90_000);

  it("claims with the configured automation assignee and restores ownership on failure", async () => {
    const failing: CheckSpec = {
      id: "unit",
      run: "/bin/false",
      required: true,
      source: "repository-policy",
    };
    const base = config();
    const cfg = {
      ...base,
      backlog: { ...base.backlog, claimAssignee: "runmill-bot" },
    };
    const { orchestrator, backlog } = makeOrchestrator({ checks: [failing], cfg });

    const outcome = await orchestrator.run({
      runId: "run_assignment_restore",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_assignment_restore"),
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(backlog.peek(ISSUE.identifier)).toMatchObject({ state: "Todo" });
    expect(backlog.peek(ISSUE.identifier)?.assigneeId).toBeUndefined();
    const assignments = backlog.calls
      .filter((call) => call.op === "assign")
      .map((call) => (call.args as { assignee: string | null }).assignee);
    expect(assignments).toEqual(["runmill-bot", null]);
  }, 90_000);

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
    const body = readFileSync(join(root, "log.md"), "utf8");
    expect(body).toMatch(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
    expect(body).toContain("**ENG-101** Add a greeting helper");
    expect(body.match(/run `run_log`/g)).toHaveLength(1);
    expect(existsSync(join(source, ".runmill", "log.md"))).toBe(false);
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
  it("quarantines an always-forbidden diff before checkpointing or calling the forge", async () => {
    const provider = new FakeProviderAdapter({
      byRole: {
        implementer: [
          {
            kind: "write",
            path: ".github/workflows/agent.yml",
            content: "permissions: write-all\n",
          },
        ],
      },
    });
    const { orchestrator, forge } = makeOrchestrator({ provider });
    const outcome = await orchestrator.run({
      runId: "run_forbidden_diff",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_forbidden_diff"),
    });

    expect(outcome.finalState).toBe("QUARANTINED");
    expect(outcome.reason).toMatch(/forbidden_paths.*\.github/i);
    expect(forge.calls).toHaveLength(0);
  }, 60_000);

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

  it("stops before delivery when the whole-run invocation budget is exhausted", async () => {
    const base = config();
    const cfg = {
      ...base,
      budgets: {
        ...base.budgets,
        maxAgentInvocations: { ...base.budgets.maxAgentInvocations, total: 2 },
      },
    };
    const { orchestrator, provider, forge } = makeOrchestrator({ cfg });

    const outcome = await orchestrator.run({
      runId: "run_invocation_budget",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_invocation_budget"),
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toMatch(/invocation total exhausted/i);
    expect(provider.startedRequests.map((request) => request.role)).toEqual([
      "implementer",
      "local-reviewer",
    ]);
    expect(forge.calls.some((call) => call.op === "merge")).toBe(false);
  }, 90_000);

  it("records spend and stops when a provider call crosses the issue cost cap", async () => {
    const base = config();
    const cfg = {
      ...base,
      budgets: {
        ...base.budgets,
        maxCostUsdPerIssue: 0.2,
        costEnforcement: "auto" as const,
      },
    };
    const { orchestrator, forge } = makeOrchestrator({ cfg });

    const outcome = await orchestrator.run({
      runId: "run_cost_budget",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_cost_budget"),
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toMatch(/cost cap exceeded/i);
    expect(outcome.costUsd).toBe(0.25);
    expect(forge.calls).toHaveLength(0);
  }, 60_000);

  it("clamps provider timeouts and stops when the issue wall-time cap expires", async () => {
    class SlowProvider extends FakeProviderAdapter {
      override async start(request: Parameters<FakeProviderAdapter["start"]>[0]) {
        const session = await super.start(request);
        clock.advanceMinutes(1);
        return session;
      }
    }
    const base = config();
    const cfg = {
      ...base,
      budgets: { ...base.budgets, maxWallMinutesPerIssue: 1 },
    };
    const provider = new SlowProvider({
      byRole: {
        implementer: [
          { kind: "write", path: "greeting.ts", content: "export const greet = () => 'hi';\n" },
        ],
      },
      costUsdPerCall: 0.25,
    });
    const { orchestrator, forge } = makeOrchestrator({ cfg, provider });

    const outcome = await orchestrator.run({
      runId: "run_wall_budget",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_wall_budget"),
    });

    expect(provider.startedRequests[0]?.timeoutMs).toBe(60_000);
    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toMatch(/wall-time cap reached/i);
    expect(forge.calls).toHaveLength(0);
  }, 60_000);
});

describe("guarded merge", () => {
  it("merges when every gate passes and records the merge sha", async () => {
    // credentialCanWriteProtection: false is the properly-scoped App token.
    // The fake defaults to true, mirroring the real adapter's fail-closed
    // answer when it cannot determine the credential's power.
    const forge = new FakeForgeAdapter({ credentialCanWriteProtection: false });
    const cfg = { ...config(), autonomy: "guarded-merge" as const };
    const { orchestrator, backlog, provider } = makeOrchestrator({ forge, cfg });

    const outcome = await orchestrator.run({
      runId: "run_g",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_g"),
    });

    expect(outcome.finalState).toBe("COMPLETED");
    expect(outcome.mergeSha).toBe("merge-1");
    expect(backlog.peek("ENG-101")?.state).toBe("Done");
    const evidence = provider.capturedPrEvidence[0] as { candidate: { sha: string } };
    const merge = forge.calls.find((call) => call.op === "merge")?.args as {
      expectedHeadSha: string;
    };
    expect(merge.expectedHeadSha).toBe(evidence.candidate.sha);
  }, 90_000);

  it("refuses GitHub's blocked mergeability verdict, including unresolved conversations", async () => {
    const forge = new FakeForgeAdapter({
      credentialCanWriteProtection: false,
      requiresConversationResolution: true,
      mergeability: { state: "blocked", mergeable: false },
    });
    const cfg = { ...config(), autonomy: "guarded-merge" as const };
    const { orchestrator } = makeOrchestrator({ forge, cfg });

    const outcome = await orchestrator.run({
      runId: "run_blocked_mergeability",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_blocked_mergeability"),
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toMatch(/blocked.*conversation resolution/i);
    expect(forge.calls.some((call) => call.op === "merge")).toBe(false);
  }, 90_000);

  it("refuses a direct merge when branch protection requires a merge queue", async () => {
    const forge = new FakeForgeAdapter({
      credentialCanWriteProtection: false,
      usesMergeQueue: true,
    });
    const cfg = { ...config(), autonomy: "guarded-merge" as const };
    const { orchestrator } = makeOrchestrator({ forge, cfg });

    const outcome = await orchestrator.run({
      runId: "run_merge_queue",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_merge_queue"),
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toMatch(/merge queue.*not implemented/i);
    expect(forge.calls.some((call) => call.op === "merge")).toBe(false);
  }, 90_000);

  it("refuses to merge if the remote PR head changes after review", async () => {
    class ChangedAfterReviewForge extends FakeForgeAdapter {
      reads = 0;
      override async getPullRequest(input: { repo: string; number: number }) {
        this.reads += 1;
        const current = await super.getPullRequest(input);
        return current === undefined || this.reads < 3
          ? current
          : { ...current, headSha: "unreviewed-external-commit" };
      }
    }

    const forge = new ChangedAfterReviewForge({ credentialCanWriteProtection: false });
    const cfg = { ...config(), autonomy: "guarded-merge" as const };
    const { orchestrator } = makeOrchestrator({ forge, cfg });
    const outcome = await orchestrator.run({
      runId: "run_head_changed",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_head_changed"),
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toMatch(/does not match the exact candidate/i);
    expect(forge.calls.some((call) => call.op === "merge")).toBe(false);
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

  it("hands PR reviewers orchestrator-owned evidence for the exact candidate", async () => {
    const provider = defaultProvider();
    const forge = new FakeForgeAdapter({
      requiredChecks: ["build"],
      checks: [
        {
          name: "build",
          conclusion: "success",
          headSha: "$ref",
          completedAt: "2026-08-06T10:00:00Z",
        },
      ],
    });
    const { orchestrator } = makeOrchestrator({ provider, forge });
    const outcome = await orchestrator.run({
      runId: "run_pr_evidence",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_pr_evidence"),
    });

    expect(outcome.finalState).toBe("PR_DELIVERED");
    const evidence = provider.capturedPrEvidence[0] as {
      candidate: { sha: string; matches_pull_request_head: boolean };
      pull_request: { number: number; head_sha: string };
      ci: { required_contexts: string[]; verdicts: unknown[] };
      unavailable: string[];
    };
    expect(evidence.pull_request.number).toBe(1);
    expect(evidence.pull_request.head_sha).toBe(evidence.candidate.sha);
    expect(evidence.candidate.matches_pull_request_head).toBe(true);
    expect(evidence.ci).toEqual({
      required_contexts: ["build"],
      verdicts: [
        { context: "build", state: "satisfied", detail: '"build" passed' },
      ],
    });
    expect(evidence.unavailable.join(" ")).toMatch(/comments were not collected/i);
  }, 90_000);

  it("passes repository review guidance as captured untrusted additions", async () => {
    mkdirSync(join(source, ".runmill", "skills"), { recursive: true });
    writeFileSync(join(source, ".runmill", "skills", "local.md"), "Inspect tenant boundaries.\n");
    writeFileSync(join(source, ".runmill", "skills", "pr.md"), "Inspect migration rollback.\n");
    git(source, "add", ".runmill/skills");
    git(source, "commit", "-q", "-m", "add review guidance");
    git(source, "push", "-q", "origin", "main");

    const base = config();
    const cfg = {
      ...base,
      review: {
        ...base.review,
        localReviewSkill: ".runmill/skills/local.md",
        prReviewSkill: ".runmill/skills/pr.md",
      },
    };
    const provider = defaultProvider();
    const { orchestrator } = makeOrchestrator({ provider, cfg });
    const outcome = await orchestrator.run({
      runId: "run_review_guidance",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_review_guidance"),
    });

    expect(outcome.finalState).toBe("PR_DELIVERED");
    const local = provider.startedRequests.find((request) => request.role === "local-reviewer");
    const pr = provider.startedRequests.find((request) => request.role === "pr-reviewer");
    expect(local?.supplementalReviewGuidance).toMatchObject({
      source: ".runmill/skills/local.md",
      content: "Inspect tenant boundaries.\n",
    });
    expect(pr?.supplementalReviewGuidance).toMatchObject({
      source: ".runmill/skills/pr.md",
      content: "Inspect migration rollback.\n",
    });
    expect(
      provider.startedRequests.find((request) => request.role === "implementer")
        ?.supplementalReviewGuidance,
    ).toBeUndefined();
  }, 90_000);

  it("refuses PR evidence when the remote head is not the local candidate", async () => {
    class MismatchedHeadForge extends FakeForgeAdapter {
      override async getPullRequest(input: { repo: string; number: number }) {
        const current = await super.getPullRequest(input);
        return current === undefined ? undefined : { ...current, headSha: "external-commit" };
      }
    }
    const provider = defaultProvider();
    const forge = new MismatchedHeadForge();
    const { orchestrator } = makeOrchestrator({ provider, forge });
    const outcome = await orchestrator.run({
      runId: "run_wrong_head",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_wrong_head"),
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toMatch(/does not match the exact candidate/i);
    expect(provider.startedRequests.some((request) => request.role === "pr-reviewer")).toBe(false);
  }, 90_000);

  it("refuses a review that tampers with orchestrator-owned PR evidence", async () => {
    const provider = new FakeProviderAdapter({
      byRole: {
        implementer: [
          { kind: "write", path: "greeting.ts", content: "export const greet = () => 'hi';\n" },
        ],
        "local-reviewer": [{ kind: "say", text: "reviewing" }],
        "pr-reviewer": [
          { kind: "write", path: ".runmill/run/pr-evidence.json", content: "{}\n" },
        ],
      },
      outputByRole: { "local-reviewer": GOOD_REVIEW, "pr-reviewer": GOOD_REVIEW },
    });
    const { orchestrator, forge } = makeOrchestrator({ provider });
    const outcome = await orchestrator.run({
      runId: "run_tampered_evidence",
      issue: ISSUE,
      target: TARGET,
      lease: lease("run_tampered_evidence"),
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.reason).toMatch(/modified.*orchestrator-owned evidence/i);
    expect(forge.calls.some((call) => call.op === "merge")).toBe(false);
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

    expect(outcome.finalState, outcome.reason).toBe("PR_DELIVERED");
    expect(provider.startedRequests.filter((r) => r.role === "pr-reviewer").length).toBe(2);
    const evidence = provider.capturedPrEvidence as {
      candidate: { sha: string };
      pull_request: { head_sha: string };
    }[];
    expect(evidence).toHaveLength(2);
    expect(evidence[0]?.candidate.sha).not.toBe(evidence[1]?.candidate.sha);
    for (const item of evidence) expect(item.pull_request.head_sha).toBe(item.candidate.sha);
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

    expect(outcome.finalState, outcome.reason).toBe("NEEDS_HUMAN");
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
