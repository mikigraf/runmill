import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Sandbox } from "../workspace/sandbox.js";
import type { WorkspaceManager, Workspace } from "../workspace/manager.js";
import { RunmillError } from "../errors/runmill-error.js";
import {
  SUPPORTED_REPORT_FORMATS,
  validateReportContent,
  type ReportTestResult,
} from "./report.js";

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

/**
 * Refuse the vacuous-success case at the execution boundary.
 *
 * Configuration validation and doctor are useful early diagnostics, but they
 * are not security boundaries: embedders and tests can construct an
 * Orchestrator or call VerificationEngine directly. An empty union would make
 * `every required check passed` true without running anything.
 */
export function assertEffectiveVerificationChecks(
  manifest: readonly CheckSpec[],
): void {
  if (manifest.length !== 0) return;
  throw RunmillError.fromCatalog("RM-VERIFY-001", {
    whatHappened:
      "the effective verification check union is empty; refusing to claim work or " +
      "treat zero executed checks as evidence",
  });
}

export interface RunChecksInput {
  readonly workspace: Workspace;
  readonly workspaces: WorkspaceManager;
  readonly manifest: readonly CheckSpec[];
  readonly candidateSha: string;
  readonly timeoutMs?: number | undefined;
  readonly failOnMissingCheck?: boolean | undefined;
  /** Require every required local check to produce parseable coverage evidence. */
  readonly failOnSkippedCheck?: boolean | undefined;
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

const MAX_REPORT_BYTES = 16 * 1024 * 1024;

interface PreparedReport {
  readonly path?: string | undefined;
  readonly error?: string | undefined;
  readonly existedBefore: boolean;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Create report parents without following a repository-controlled symlink. */
function createReportParent(root: string, reportPath: string): string | undefined {
  const parent = dirname(reportPath);
  const rel = relative(root, parent);
  let current = root;
  for (const part of rel.split(sep).filter((value) => value !== "")) {
    current = join(current, part);
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return "report parent contains a non-directory or symbolic link";
      }
      continue;
    }
    mkdirSync(current, { mode: 0o700 });
  }
  return reportParentIsSafe(root, reportPath)
    ? undefined
    : "report path resolves outside the verification checkout";
}

/** Resolve a declaration without allowing it to escape the immutable checkout. */
function prepareReport(
  verifyPath: string,
  report: CheckSpec["report"],
): PreparedReport | undefined {
  if (report === undefined) return undefined;
  if (
    !SUPPORTED_REPORT_FORMATS.includes(
      report.format as (typeof SUPPORTED_REPORT_FORMATS)[number],
    )
  ) {
    return {
      error: `unsupported report format "${report.format}"`,
      existedBefore: false,
    };
  }
  if (report.path.trim() === "" || isAbsolute(report.path)) {
    return {
      error: "report path must be a non-empty path relative to the checkout",
      existedBefore: false,
    };
  }

  const root = realpathSync(verifyPath);
  const path = resolve(root, report.path);
  if (!isInside(root, path) || path === root) {
    return { error: "report path escapes the verification checkout", existedBefore: false };
  }

  // A report already in the commit can be stale. Proof has to be generated by
  // this invocation, not merely found at a declared path afterwards.
  const existedBefore =
    existsSync(path) ||
    (() => {
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    })();
  if (existedBefore) {
    return { path, error: "report existed before the check and may be stale", existedBefore };
  }

  // Verification checkouts are read-only. Pre-create the one file a reporter
  // may overwrite so the sandbox can bind that literal writable without
  // granting its parent directory or the source tree.
  const parentError = createReportParent(root, path);
  if (parentError !== undefined) return { path, error: parentError, existedBefore: false };
  try {
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  } catch (cause) {
    return {
      path,
      error: `could not pre-create the exact report output: ${(cause as Error).message}`,
      existedBefore: false,
    };
  }
  return { path, existedBefore: false };
}

function reportParentIsSafe(verifyPath: string, reportPath: string): boolean {
  try {
    return isInside(realpathSync(verifyPath), realpathSync(dirname(reportPath)));
  } catch {
    return false;
  }
}

function inspectReport(
  verifyPath: string,
  spec: CheckSpec,
  prepared: PreparedReport | undefined,
): {
  proven: boolean;
  detail: string;
  failed: boolean;
  skipped: number;
  tests: readonly ReportTestResult[];
} {
  if (spec.report === undefined) {
    return {
      proven: false,
      detail: "no machine-readable report declared; coverage unproven",
      failed: false,
      skipped: 0,
      tests: [],
    };
  }
  if (prepared?.error !== undefined) {
    return {
      proven: false,
      detail: `${prepared.error}; coverage unproven`,
      failed: false,
      skipped: 0,
      tests: [],
    };
  }
  const reportPath = prepared?.path;
  if (reportPath === undefined || !existsSync(reportPath)) {
    return {
      proven: false,
      detail: `declared ${spec.report.format} report was not produced; coverage unproven`,
      failed: false,
      skipped: 0,
      tests: [],
    };
  }
  if (!reportParentIsSafe(verifyPath, reportPath)) {
    return {
      proven: false,
      detail: "report path resolves outside the verification checkout; coverage unproven",
      failed: false,
      skipped: 0,
      tests: [],
    };
  }

  const info = lstatSync(reportPath);
  if (!info.isFile()) {
    return {
      proven: false,
      detail: "declared report is not a regular file; coverage unproven",
      failed: false,
      skipped: 0,
      tests: [],
    };
  }
  if (statSync(reportPath).size > MAX_REPORT_BYTES) {
    return {
      proven: false,
      detail: `declared report exceeds ${MAX_REPORT_BYTES} bytes; coverage unproven`,
      failed: false,
      skipped: 0,
      tests: [],
    };
  }

  const parsed = validateReportContent(spec.report.format, readFileSync(reportPath, "utf8"));
  return {
    proven: parsed.valid,
    detail: parsed.valid ? parsed.detail : `${parsed.detail}; coverage unproven`,
    failed: parsed.failed,
    skipped: parsed.skipped,
    tests: parsed.tests,
  };
}

/** Remove only a newly-created, safely-contained report before freshness hashing. */
function removeGeneratedReport(
  verifyPath: string,
  prepared: PreparedReport | undefined,
): void {
  if (prepared === undefined) return;
  const path = prepared.path;
  if (path === undefined || prepared.existedBefore || !reportParentIsSafe(verifyPath, path)) return;
  try {
    const info = lstatSync(path);
    if (info.isFile() || info.isSymbolicLink()) rmSync(path, { force: true });
  } catch {
    // Missing is the normal case for a command that did not produce a report.
  }
}

interface CheckExecution {
  readonly before: string;
  readonly after: string;
  readonly outcome: Awaited<ReturnType<Sandbox["run"]>>;
  readonly report: ReturnType<typeof inspectReport>;
  readonly combined: string;
}

function ids(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function baselineProblem(execution: CheckExecution): string | undefined {
  if (execution.outcome.outcome !== "exited") {
    return `baseline command ended as ${execution.outcome.outcome}`;
  }
  if (execution.before !== execution.after) {
    return "baseline tree changed during the check";
  }
  if (!execution.report.proven) return `baseline ${execution.report.detail}`;
  if (detectZeroTests(execution.combined)) return "baseline output reported zero tests";
  if (detectFocusedExecution(execution.combined)) return "baseline output reported focused execution";

  const outputSkips = countReportedSkips(execution.combined);
  if (outputSkips > 0 && outputSkips !== execution.report.skipped) {
    return (
      `baseline output reported ${outputSkips} skip(s), but its report identified ` +
      `${execution.report.skipped}`
    );
  }
  return undefined;
}

/**
 * Compare inventories, not summary counts. A declaration is authority for one
 * exact test id in one exact check. Stale declarations fail too: the set of
 * declared exceptions must equal the candidate's skipped tests plus tests that
 * passed at base and disappeared at the candidate.
 */
function compareInventories(
  spec: CheckSpec,
  baseline: readonly ReportTestResult[],
  candidate: readonly ReportTestResult[],
): readonly string[] {
  const problems: string[] = [];
  const declaredIds = (spec.declaredSkips ?? []).map((skip) => skip.testId);
  const declared = new Set(declaredIds);
  if (declared.size !== declaredIds.length) {
    problems.push("declared_skips contains duplicate test_id values");
  }
  if (declaredIds.some((id) => id.trim() === "")) {
    problems.push("declared_skips contains an empty test_id");
  }
  if ((spec.declaredSkips ?? []).some((skip) => skip.cause.trim() === "")) {
    problems.push("declared_skips contains an empty cause");
  }

  const candidateById = new Map(candidate.map((test) => [test.id, test]));
  const exceptions = new Set(
    candidate.filter((test) => test.status === "skipped").map((test) => test.id),
  );
  for (const baseTest of baseline) {
    if (baseTest.status !== "passed") continue;
    const candidateTest = candidateById.get(baseTest.id);
    if (candidateTest === undefined || candidateTest.status === "skipped") {
      exceptions.add(baseTest.id);
    }
  }

  const undeclared = [...exceptions].filter((id) => !declared.has(id)).sort();
  const unused = [...declared].filter((id) => !exceptions.has(id)).sort();
  if (undeclared.length > 0) {
    problems.push(`skipped or absent test id(s) were not declared: ${ids(undeclared)}`);
  }
  if (unused.length > 0) {
    problems.push(`declared_skips did not exactly match candidate exceptions: ${ids(unused)}`);
  }
  return problems;
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
 * Every invocation gets its own detached checkout. Report-producing checks run
 * first at the immutable base commit to establish an exact passing-test
 * inventory, then at the candidate. Both executions use the same sandbox,
 * protected Git metadata, read-only dependency tree, timeout and tree hash.
 */
export class VerificationEngine {
  readonly #sandbox: Sandbox;

  constructor(sandbox: Sandbox = new Sandbox()) {
    this.#sandbox = sandbox;
  }

  async #executeAt(
    input: Pick<RunChecksInput, "workspace" | "workspaces" | "timeoutMs">,
    spec: CheckSpec,
    commitSha: string,
  ): Promise<CheckExecution> {
    const { workspaces, workspace } = input;
    const verifyPath = await workspaces.createVerificationCheckout(workspace, commitSha);
    const verifyWorkspace: Workspace = { ...workspace, path: verifyPath };
    try {
      const before = await workspaces.treeHash(verifyWorkspace);
      const preparedReport = prepareReport(verifyPath, spec.report);
      const parts = spec.run.split(/\s+/).filter((part) => part !== "");
      const [command, ...args] = parts;
      const dependencyLookup = workspaces as unknown as {
        verificationDependencyPath?: (checkoutPath: string) => string | undefined;
      };
      const dependencyPath = dependencyLookup.verificationDependencyPath?.(verifyPath);
      const outcome = await this.#sandbox.run({
        command: command ?? "",
        args,
        cwd: verifyPath,
        policy: {
          // Candidate-controlled test code can mutate and restore a source
          // file between two hashes. Keep the checkout read-only and grant
          // only the pre-created report file. Sandbox.run adds a private,
          // writable TMPDIR for ordinary test-runner scratch data.
          writablePaths: [],
          ...(preparedReport?.path === undefined || preparedReport.error !== undefined
            ? {}
            : { writableFiles: [preparedReport.path] }),
          readablePaths: [verifyPath],
          protectedPaths: [
            join(verifyPath, ".git"),
            ...(dependencyPath === undefined ? [] : [dependencyPath]),
          ],
          allowNetwork: false,
        },
        timeoutMs: input.timeoutMs ?? 10 * 60_000,
      });
      const report = inspectReport(verifyPath, spec, preparedReport);
      removeGeneratedReport(verifyPath, preparedReport);
      const after = await workspaces.treeHash(verifyWorkspace);
      return {
        before,
        after,
        outcome,
        report,
        combined: `${outcome.stdout}\n${outcome.stderr}`,
      };
    } finally {
      await workspaces.destroyVerificationCheckout(workspace, verifyPath);
    }
  }

  async run(input: RunChecksInput): Promise<VerificationOutcome> {
    const { workspace, manifest, candidateSha } = input;
    assertEffectiveVerificationChecks(manifest);
    const results: CheckResult[] = [];
    const failures: string[] = [];

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

      const baseline =
        spec.report === undefined
          ? undefined
          : await this.#executeAt(input, spec, workspace.baseCommit);
      const execution = await this.#executeAt(input, spec, candidateSha);
      const { before, after, outcome, report, combined } = execution;
      const notes: string[] = [report.detail];
      let status: CheckResult["status"] = outcome.exitCode === 0 ? "passed" : "failed";
      let coverage: Coverage = report.proven ? "proven" : "unproven";

      // Freshness. The tree must be identical either side of the check;
      // otherwise the result does not describe the candidate commit.
      if (before !== after) {
        status = "failed";
        notes.push("tree changed during the check; result invalidated");
        failures.push(`check "${spec.id}" ran against a mutating tree`);
      }

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

      if (status === "passed" && report.failed) {
        status = "failed";
        notes.push("machine-readable report contains a failed test");
        failures.push(`check "${spec.id}" report contains a failed test`);
      }

      const outputSkips = countReportedSkips(combined);
      if (outputSkips > 0 && (!report.proven || outputSkips !== report.skipped)) {
        status = "failed";
        notes.push(
          report.proven
            ? `output reported ${outputSkips} skip(s), report identified ${report.skipped}`
            : `${outputSkips} skip(s) were reported without exact machine-readable identities`,
        );
        failures.push(
          `[RM-VERIFY-003] check "${spec.id}" has contradictory or identity-free skip evidence`,
        );
      }

      if (baseline !== undefined) {
        const invalidBaseline = baselineProblem(baseline);
        if (invalidBaseline !== undefined) {
          status = "failed";
          coverage = "unproven";
          notes.push(`${invalidBaseline}; preservation inventory unproven`);
          failures.push(`[RM-VERIFY-003] check "${spec.id}" ${invalidBaseline}`);
        } else if (!report.proven) {
          status = "failed";
          coverage = "unproven";
          notes.push("candidate report cannot prove the baseline test inventory was preserved");
          failures.push(
            `[RM-VERIFY-003] check "${spec.id}" has no valid candidate test inventory`,
          );
        } else {
          const passing = baseline.report.tests.filter((test) => test.status === "passed").length;
          notes.push(
            `baseline inventory: ${passing} passed of ${baseline.report.tests.length} tests`,
          );
          for (const problem of compareInventories(
            spec,
            baseline.report.tests,
            report.tests,
          )) {
            status = "failed";
            notes.push(problem);
            failures.push(`[RM-VERIFY-003] check "${spec.id}" ${problem}`);
          }
        }
      } else if ((spec.declaredSkips?.length ?? 0) > 0) {
        status = "failed";
        notes.push("declared_skips requires a machine-readable report for exact identities");
        failures.push(
          `[RM-VERIFY-003] check "${spec.id}" declares skips without an exact report inventory`,
        );
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

    // Coverage: every required, locally-executable check must have a result.
    for (const spec of manifest) {
      if (spec.source === "github" || !spec.required) continue;
      if (!results.some((r) => r.checkId === spec.id)) {
        failures.push(`required check "${spec.id}" produced no result`);
      }
    }

    if (input.failOnSkippedCheck !== false) {
      for (const result of results) {
        if (result.required && result.coverage !== "proven") {
          failures.push(`required check "${result.checkId}" has unproven coverage`);
        }
      }
    }

    const anyFailed = results.some((r) => r.status === "failed");
    return { mergeReady: !anyFailed && failures.length === 0, results, failures };
  }
}
