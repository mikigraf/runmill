import { createHash } from "node:crypto";
import { Sandbox } from "../workspace/sandbox.js";
import type { WorkspaceManager, Workspace } from "../workspace/manager.js";
import { RunmillError } from "../errors/runmill-error.js";

export interface CheckSpec {
  readonly id: string;
  readonly run: string;
  readonly required: boolean;
  readonly source: "repository-policy" | "changed-path" | "github" | "agent";
  readonly report?: { readonly path: string; readonly format: string } | undefined;
  /** Test ids permitted to skip, with a stated cause. */
  readonly declaredSkips?: readonly { readonly testId: string; readonly cause: string }[] | undefined;
}

export type Coverage = "proven" | "unproven";

export interface CheckResult {
  readonly checkId: string;
  readonly required: boolean;
  readonly source: string;
  readonly command: string;
  readonly attempt: number;
  readonly commitSha: string;
  readonly treeHashBefore: string;
  readonly treeHashAfter: string;
  readonly executor: "orchestrator" | "agent";
  readonly outcome: "exited" | "signaled" | "timeout" | "sandbox-denied";
  readonly exitCode: number | null;
  readonly status: "passed" | "failed" | "not_applicable";
  readonly coverage: Coverage;
  readonly durationMs: number;
  readonly stdoutHash: string;
  readonly notes: readonly string[];
}

export interface VerificationOutcome {
  readonly mergeReady: boolean;
  readonly results: readonly CheckResult[];
  readonly failures: readonly string[];
}

export interface ResolveManifestInput {
  readonly configured: readonly CheckSpec[];
  readonly changedPaths: readonly string[];
  readonly changedAreaRules?: Readonly<Record<string, { additionalChecks: readonly string[] }>> | undefined;
  readonly githubRequired?: readonly string[] | undefined;
  readonly agentProposed?: readonly string[] | undefined;
}

/**
 * Resolve which checks are required for this change.
 *
 * The union is monotonic: an agent may ADD checks but never remove them, and
 * an agent proposal is an *identifier* referencing a configured check, never a
 * command. Permitting the agent to propose a command string would make the
 * check runner a remote-code-execution primitive, since the orchestrator is
 * what runs it.
 */
export function resolveManifest(input: ResolveManifestInput): CheckSpec[] {
  const byId = new Map<string, CheckSpec>();
  for (const spec of input.configured) {
    if (spec.required) byId.set(spec.id, spec);
  }

  const addById = (id: string, source: CheckSpec["source"]): void => {
    if (byId.has(id)) return;
    const known = input.configured.find((c) => c.id === id);
    if (known === undefined) return; // unknown identifiers are ignored, never executed
    byId.set(id, { ...known, required: true, source });
  };

  for (const [area, rule] of Object.entries(input.changedAreaRules ?? {})) {
    if (input.changedPaths.some((p) => p.includes(area))) {
      for (const id of rule.additionalChecks) addById(id, "changed-path");
    }
  }
  for (const id of input.agentProposed ?? []) addById(id, "agent");

  // Remote-observed checks live in the manifest but are not locally executable.
  for (const id of input.githubRequired ?? []) {
    if (!byId.has(id)) {
      byId.set(id, { id, run: "", required: true, source: "github" });
    }
  }

  return [...byId.values()];
}

export interface RunChecksInput {
  readonly workspace: Workspace;
  readonly workspaces: WorkspaceManager;
  readonly manifest: readonly CheckSpec[];
  readonly candidateSha: string;
  readonly timeoutMs?: number | undefined;
  readonly failOnMissingCheck?: boolean | undefined;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const SKIP_PATTERNS = [
  /(\d+)\s+skipped/i,
  /(\d+)\s+pending/i,
  /skipped:\s*(\d+)/i,
];

export function countReportedSkips(output: string): number {
  for (const pattern of SKIP_PATTERNS) {
    const match = output.match(pattern);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return 0;
}

export function detectFocusedExecution(output: string): boolean {
  return /\.only\(|fit\(|fdescribe\(|focused/i.test(output);
}

export function detectZeroTests(output: string): boolean {
  return /no tests found|0 (tests|passed)|passWithNoTests/i.test(output);
}

/**
 * Execute the resolved manifest and decide merge-readiness.
 *
 * Four separate questions, all of which must be answered yes:
 *   discovery  — which checks are required for this change?
 *   coverage   — were all of them actually invoked?
 *   freshness  — did they run against the exact candidate commit?
 *   outcome    — did they complete without a prohibited skip?
 *
 * A green command answers only the fourth. That is why this runs in a separate
 * detached checkout of the candidate commit and hashes the tree before and
 * after every check.
 */
export class VerificationEngine {
  readonly #sandbox: Sandbox;

  constructor(sandbox: Sandbox = new Sandbox()) {
    this.#sandbox = sandbox;
  }

  async run(input: RunChecksInput): Promise<VerificationOutcome> {
    const { workspaces, workspace, manifest, candidateSha } = input;
    const results: CheckResult[] = [];
    const failures: string[] = [];

    const verifyPath = await workspaces.createVerificationCheckout(workspace, candidateSha);
    const verifyWorkspace: Workspace = { ...workspace, path: verifyPath };

    try {
      for (const spec of manifest) {
        if (spec.source === "github") {
          // Remote-observed: satisfied by CI reconciliation, not locally.
          continue;
        }
        if (spec.run === "") {
          failures.push(`required check "${spec.id}" has no runnable command`);
          if (input.failOnMissingCheck !== false) {
            throw RunmillError.fromCatalog("RM-VERIFY-001", {
              whatHappened: `Required check "${spec.id}" has no command and no remote result.`,
            });
          }
          continue;
        }

        const before = await workspaces.treeHash(verifyWorkspace);
        const parts = spec.run.split(/\s+/).filter((p) => p !== "");
        const [command, ...args] = parts;

        const outcome = await this.#sandbox.run({
          command: command ?? "",
          args,
          cwd: verifyPath,
          policy: { writablePaths: [verifyPath], allowNetwork: false },
          timeoutMs: input.timeoutMs ?? 10 * 60_000,
        });

        const after = await workspaces.treeHash(verifyWorkspace);
        const notes: string[] = [];
        let status: CheckResult["status"] = outcome.exitCode === 0 ? "passed" : "failed";
        let coverage: Coverage = "proven";

        // Freshness. The tree must be identical either side of the check;
        // otherwise the result does not describe the candidate commit.
        if (before !== after) {
          status = "failed";
          notes.push("tree changed during the check; result invalidated");
          failures.push(`check "${spec.id}" ran against a mutating tree`);
        }

        const combined = `${outcome.stdout}\n${outcome.stderr}`;

        // A framework that exits 0 having discovered nothing is the nastiest
        // false green there is: it looks identical to a full pass.
        if (status === "passed" && detectZeroTests(combined)) {
          status = "failed";
          coverage = "unproven";
          notes.push("check reported zero tests discovered");
          failures.push(`check "${spec.id}" discovered no tests`);
        }

        if (status === "passed" && detectFocusedExecution(combined)) {
          status = "failed";
          notes.push("focused execution detected (.only/fit/fdescribe)");
          failures.push(`check "${spec.id}" ran a focused subset`);
        }

        const reportedSkips = countReportedSkips(combined);
        const declared = spec.declaredSkips?.length ?? 0;
        if (status === "passed" && reportedSkips > declared) {
          status = "failed";
          notes.push(`${reportedSkips} skipped, ${declared} declared`);
          failures.push(`check "${spec.id}" has ${reportedSkips - declared} undeclared skip(s)`);
        }

        if (spec.report === undefined) {
          coverage = "unproven";
          notes.push("no machine-readable report declared; coverage unproven");
        }

        if (outcome.outcome === "timeout") {
          status = "failed";
          failures.push(`check "${spec.id}" timed out`);
        }

        results.push({
          checkId: spec.id,
          required: spec.required,
          source: spec.source,
          command: spec.run,
          attempt: 1,
          commitSha: candidateSha,
          treeHashBefore: before,
          treeHashAfter: after,
          // Checks the agent ran during implementation are advisory telemetry.
          // Merge-readiness only ever counts the orchestrator's own execution.
          executor: "orchestrator",
          outcome: outcome.outcome,
          exitCode: outcome.exitCode,
          status,
          coverage,
          durationMs: outcome.durationMs,
          stdoutHash: hash(outcome.stdout),
          notes,
        });
      }
    } finally {
      await workspaces.destroyVerificationCheckout(workspace, verifyPath);
    }

    // Coverage: every required, locally-executable check must have a result.
    for (const spec of manifest) {
      if (spec.source === "github" || !spec.required) continue;
      if (!results.some((r) => r.checkId === spec.id)) {
        failures.push(`required check "${spec.id}" produced no result`);
      }
    }

    const anyFailed = results.some((r) => r.status === "failed");
    return { mergeReady: !anyFailed && failures.length === 0, results, failures };
  }
}
