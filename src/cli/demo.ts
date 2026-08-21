import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../config/load.js";
import type { BacklogIssue } from "../domain/types.js";
import { demoFixturePath } from "../factory.js";
import { Orchestrator, type RunOutcome } from "../orchestrator/orchestrator.js";
import { SystemClock } from "../platform/clock.js";
import { GitRefLease } from "../queue/git-lease.js";
import { selectNext } from "../queue/selector.js";
import { StateStore } from "../state/store.js";
import { FakeBacklogAdapter } from "../testing/fake-backlog.js";
import { FakeForgeAdapter } from "../testing/fake-forge.js";
import { FakeProviderAdapter } from "../testing/fake-provider.js";
import {
  VerificationEngine,
  type CheckResult,
  type RunChecksInput,
  type VerificationOutcome,
} from "../verification/engine.js";

export interface DemoResult {
  readonly issue: Pick<BacklogIssue, "identifier" | "title">;
  readonly outcome: RunOutcome;
  readonly transitions: readonly string[];
  readonly temporary: true;
}

/**
 * The demo check is deliberately built in.
 *
 * A first-run demo must not depend on credentials, package managers, or an OS
 * sandbox being installed. It still checks the important invariant: the
 * marker must exist in an immutable checkout at the exact candidate SHA and
 * the checkout must remain byte-for-byte unchanged while it is inspected.
 */
class DemoVerificationEngine extends VerificationEngine {
  override async run(input: RunChecksInput): Promise<VerificationOutcome> {
    const started = Date.now();
    const path = await input.workspaces.createVerificationCheckout(
      input.workspace,
      input.candidateSha,
    );
    const checkout = { ...input.workspace, path };
    try {
      const before = await input.workspaces.treeHash(checkout);
      const actualSha = await input.workspaces.headSha(checkout);
      let marker = "";
      try {
        marker = readFileSync(join(path, "RUNMILL_DEMO.md"), "utf8");
      } catch {
        // Reported as failed evidence below.
      }
      const after = await input.workspaces.treeHash(checkout);
      const passed =
        actualSha === input.candidateSha &&
        before === after &&
        marker.includes("in-memory demo agent");
      const spec = input.manifest[0];
      const result: CheckResult = {
        checkId: spec?.id ?? "demo-candidate",
        required: true,
        source: "repository-policy",
        command: "built-in exact-candidate demo check",
        attempt: 1,
        commitSha: input.candidateSha,
        treeHashBefore: before,
        treeHashAfter: after,
        executor: "orchestrator",
        outcome: "exited",
        exitCode: passed ? 0 : 1,
        status: passed ? "passed" : "failed",
        coverage: "proven",
        durationMs: Date.now() - started,
        stdoutHash: createHash("sha256").update(marker).digest("hex").slice(0, 16),
        notes: passed
          ? ["marker inspected at the exact candidate commit"]
          : ["candidate SHA, immutable tree, or marker did not match"],
      };
      return {
        mergeReady: passed,
        results: [result],
        failures: passed ? [] : ["built-in exact-candidate demo check failed"],
      };
    } finally {
      await input.workspaces.destroyVerificationCheckout(input.workspace, path);
    }
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Run one complete, credential-free delivery loop entirely under a temp dir. */
export async function runDemo(onEvent?: (message: string) => void): Promise<DemoResult> {
  const root = mkdtempSync(join(tmpdir(), "runmill-demo-"));
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  let store: StateStore | undefined;

  try {
    execFileSync("git", ["init", "--bare", "--quiet", "--initial-branch", "main", origin], {
      stdio: "ignore",
    });
    execFileSync("git", ["clone", "--quiet", origin, source], { stdio: "ignore" });
    git(source, "config", "user.email", "demo@runmill.local");
    git(source, "config", "user.name", "runmill demo");
    writeFileSync(join(source, "README.md"), "# Demo service\n");
    git(source, "add", "README.md");
    git(source, "commit", "--quiet", "-m", "demo: seed repository");
    git(source, "push", "--quiet", "origin", "main");

    const config = parseConfig(`
version: 1
autonomy: pr-only
providers:
  implementer: { implementation: codex }
  reviewer: { implementation: inherit }
backlog:
  provider: linear
  team: ENG
  eligible_states: [Todo, Ready]
  claim_state: In Progress
  delivered_state: In Review
  completed_state: Done
  include_labels: [agent-ready]
github:
  repositories:
    - match: { team: ENG }
      repo: runmill/demo
      base_branch: main
workspace:
  git_isolation: clone
verification:
  manifest: .runmill/checks.yaml
`);

    const issues = JSON.parse(readFileSync(demoFixturePath(), "utf8")) as BacklogIssue[];
    const backlog = new FakeBacklogAdapter(issues);
    const selection = await selectNext({ backlog, config, leasedIssueIds: new Set() });
    const selected = selection.selected;
    if (selected === undefined) throw new Error("The bundled demo has no eligible issue.");

    onEvent?.(`selected ${selected.issue.identifier} — ${selected.issue.title}`);
    store = StateStore.open(join(root, "state", "runmill.db"));
    const clock = new SystemClock();
    const orchestrator = new Orchestrator({
      backlog,
      provider: new FakeProviderAdapter(),
      // A separate adapter instance represents a reviewer with brand-new
      // context rather than continuing the implementer's conversation.
      reviewProvider: new FakeProviderAdapter(),
      forge: new FakeForgeAdapter(),
      store,
      clock,
      config,
      sourceRepoPath: source,
      sourceRepository: selected.target.repo,
      workspaceRoot: join(root, "runs"),
      verification: new DemoVerificationEngine(),
      checks: [
        {
          id: "demo-candidate",
          run: "built-in exact-candidate demo check",
          required: true,
          source: "repository-policy",
        },
      ],
      onEvent,
      ciPollIntervalMs: 1,
      sleep: async () => undefined,
    });
    const runId = "demo_run";
    const outcome = await orchestrator.run({
      runId,
      issue: selected.issue,
      target: selected.target,
      lease: new GitRefLease({
        cwd: source,
        runId,
        clock,
        ttlMinutes: 20,
        hostId: "runmill-demo",
        pid: process.pid,
      }),
    });
    const transitions = store.transitionHistory(runId).map((transition) => transition.to);
    if (outcome.finalState !== "PR_DELIVERED") {
      throw new Error(`The simulated delivery loop stopped in ${outcome.finalState}: ${outcome.reason ?? "unknown reason"}`);
    }

    return {
      issue: { identifier: selected.issue.identifier, title: selected.issue.title },
      outcome,
      transitions,
      temporary: true,
    };
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
}
