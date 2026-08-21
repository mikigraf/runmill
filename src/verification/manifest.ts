import { parse as parseYaml } from "yaml";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { RunmillError } from "../errors/runmill-error.js";
import type { CheckSpec } from "./engine.js";
import { SUPPORTED_REPORT_FORMATS } from "./report.js";

export interface DeclaredSkip {
  readonly testId: string;
  readonly cause: string;
}

export interface ChecksManifest {
  readonly checks: readonly CheckSpec[];
  /** Legacy unscoped declarations, retained only so validation can reject them. */
  readonly declaredSkips: readonly DeclaredSkip[];
}

function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Parse `.runmill/checks.yaml` — the repository's own statement of what must
 * pass before a change of its is merge-ready.
 *
 * Separate from the operator policy by ownership, not by taste. Which checks a
 * repository requires is a property of the repository, so it is versioned with
 * the code and reviewed like the code. How much autonomy runmill has is a
 * property of the operator, so it lives outside where an inbound pull request
 * cannot reach it.
 *
 * `declared_skips` belongs to a check. The report format defines the exact test
 * identity; a declaration for one command must never authorize a similarly
 * named test to disappear from another command.
 */
export function parseChecksManifest(source: string): ChecksManifest {
  const raw = asRecord(parseYaml(source));

  const declaredSkips: DeclaredSkip[] = asArray<unknown>(raw["declared_skips"]).map((entry) => {
    const s = asRecord(entry);
    return {
      testId: String(s["test_id"] ?? ""),
      cause: String(s["cause"] ?? ""),
    };
  });

  const checks: CheckSpec[] = asArray<unknown>(raw["checks"]).map((entry) => {
    const c = asRecord(entry);
    const report = c["report"] === undefined ? undefined : asRecord(c["report"]);
    const checkSkips: DeclaredSkip[] = asArray<unknown>(c["declared_skips"]).map((entry) => {
      const skip = asRecord(entry);
      return {
        testId: String(skip["test_id"] ?? ""),
        cause: String(skip["cause"] ?? ""),
      };
    });
    return {
      id: String(c["id"] ?? ""),
      run: String(c["run"] ?? ""),
      // Every check a repository declares is required. An optional check is a
      // check nobody has to fix, which is indistinguishable from no check.
      required: c["required"] !== false,
      source: "repository-policy" as const,
      ...(report === undefined
        ? {}
        : { report: { path: String(report["path"] ?? ""), format: String(report["format"] ?? "") } }),
      ...(checkSkips.length === 0 ? {} : { declaredSkips: checkSkips }),
    };
  });

  return { checks, declaredSkips };
}

/** Every way the manifest can be malformed, reported at once. */
export function validateChecksManifest(manifest: ChecksManifest): readonly string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const [index, check] of manifest.checks.entries()) {
    const where = check.id === "" ? `checks[${index}]` : `check "${check.id}"`;
    if (check.id === "") errors.push(`${where}: missing id`);
    if (check.run.trim() === "") errors.push(`${where}: missing run command`);
    if (check.id !== "" && seen.has(check.id)) {
      errors.push(`${where}: duplicate id — the later definition would silently win`);
    }
    seen.add(check.id);
    if (check.report !== undefined && check.report.path === "") {
      errors.push(`${where}: report declared with no path`);
    }
    if (check.report !== undefined) {
      const resolved = resolve("/checkout", check.report.path);
      const rel = relative("/checkout", resolved);
      if (
        isAbsolute(check.report.path) ||
        rel === "" ||
        rel === ".." ||
        rel.startsWith("../")
      ) {
        errors.push(`${where}: report path must stay inside the verification checkout`);
      }
      if (
        !SUPPORTED_REPORT_FORMATS.includes(
          check.report.format as (typeof SUPPORTED_REPORT_FORMATS)[number],
        )
      ) {
        errors.push(
          `${where}: report format must be one of ${SUPPORTED_REPORT_FORMATS.join(", ")}`,
        );
      }
    }
    const skipIds = new Set<string>();
    for (const [skipIndex, skip] of (check.declaredSkips ?? []).entries()) {
      const skipWhere = `${where}.declared_skips[${skipIndex}]`;
      if (skip.testId.trim() === "") errors.push(`${skipWhere}: missing test_id`);
      if (skipIds.has(skip.testId)) {
        errors.push(`${skipWhere}: duplicate test_id ${JSON.stringify(skip.testId)}`);
      }
      skipIds.add(skip.testId);
      if (skip.cause.trim() === "") {
        errors.push(`${skipWhere} (${JSON.stringify(skip.testId)}): missing cause`);
      }
      if (check.report === undefined) {
        errors.push(`${skipWhere}: exact skip declarations require a report on this check`);
      }
    }
  }

  if (manifest.declaredSkips.length > 0) {
    errors.push(
      "top-level declared_skips is unscoped; move each declaration under the exact check",
    );
  }

  return errors;
}

export interface LoadManifestInput {
  readonly repoRoot: string;
  /** Path from config, e.g. `.runmill/checks.yaml`. */
  readonly manifestPath: string;
  /**
   * Read the manifest from this git ref instead of the working tree.
   *
   * This is the security property, not an optimization: a pull request that
   * edits the check manifest must not be able to relax the checks governing
   * its own merge. Reading from the base means the rules a change is judged by
   * are the rules that existed before it.
   */
  readonly baseRef?: string | undefined;
}

export interface LoadedManifest extends ChecksManifest {
  /** Where the content came from, for the run record. */
  readonly readFrom: "base-ref" | "working-tree";
  readonly path: string;
}

/**
 * Read and validate the repository's check manifest.
 *
 * Returns undefined when no manifest exists — a repository is allowed to
 * declare its checks entirely in operator policy. A manifest that exists but does
 * not parse is a hard failure, because "unreadable" must never quietly become
 * "no checks required".
 */
export function loadChecksManifest(input: LoadManifestInput): LoadedManifest | undefined {
  const { repoRoot, manifestPath, baseRef } = input;
  const absolute = isAbsolute(manifestPath) ? manifestPath : resolve(repoRoot, manifestPath);

  let source: string | undefined;
  let readFrom: LoadedManifest["readFrom"] = "working-tree";

  if (baseRef !== undefined && baseRef !== "") {
    try {
      gitSync(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
      const paths = gitSync(repoRoot, ["ls-tree", "--name-only", baseRef, "--", manifestPath]);
      if (paths.trim() !== "") {
        source = gitSync(repoRoot, ["show", `${baseRef}:${manifestPath}`]);
        readFrom = "base-ref";
      }
      // Absent at a proven-valid base ref: a manifest added by this change.
      // Falling through is safe because it can only add repository checks.
    } catch (cause) {
      throw RunmillError.fromCatalog("RM-VERIFY-004", {
        whatHappened:
          `could not read ${manifestPath} from configured base ref ${baseRef}; ` +
          "refusing to substitute mutable working-tree policy",
        cause,
      });
    }
  }

  if (source === undefined) {
    if (!existsSync(absolute)) return undefined;
    source = readFileSync(absolute, "utf8");
  }

  let manifest: ChecksManifest;
  try {
    manifest = parseChecksManifest(source);
  } catch (cause) {
    throw RunmillError.fromCatalog("RM-VERIFY-004", {
      whatHappened: `${manifestPath} is not valid YAML.\n  ${(cause as Error).message}`,
    });
  }

  const errors = validateChecksManifest(manifest);
  if (errors.length > 0) {
    throw RunmillError.fromCatalog("RM-VERIFY-004", {
      whatHappened: `${manifestPath} is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    });
  }

  return { ...manifest, readFrom, path: manifestPath };
}

/**
 * Merge repository-declared checks with those configured in operator policy.
 *
 * Union by id, preserving the operator's definition on a conflict. Repository
 * policy can add requirements, but content under review cannot replace a
 * command or evidence rule chosen outside the repository.
 */
export function mergeCheckSources(
  repository: readonly CheckSpec[],
  configured: readonly CheckSpec[],
): CheckSpec[] {
  const byId = new Map<string, CheckSpec>();
  for (const spec of repository) byId.set(spec.id, spec);
  for (const spec of configured) byId.set(spec.id, spec);
  return [...byId.values()];
}

function gitSync(repoRoot: string, args: readonly string[]): string {
  // Manifest loading happens during config resolution, which is synchronous.
  // argv form, never a shell string: args contain caller-supplied paths/refs.
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}
