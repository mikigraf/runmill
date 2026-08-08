import { parse as parseYaml } from "yaml";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { RunmillError } from "../errors/runmill-error.js";
import type { CheckSpec } from "./engine.js";

export interface DeclaredSkip {
  readonly testId: string;
  readonly cause: string;
}

export interface ChecksManifest {
  readonly checks: readonly CheckSpec[];
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
 * Separate from runmill.yaml by ownership, not by taste. Which checks a
 * repository requires is a property of the repository, so it is versioned with
 * the code and reviewed like the code. How much autonomy runmill has is a
 * property of the operator, so it lives outside where an inbound pull request
 * cannot reach it.
 *
 * `declared_skips` is top level and applies to every check: a skip is a
 * statement about a test, and the same test does not become acceptable to lose
 * because a different command happened to run it.
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
      ...(declaredSkips.length === 0 ? {} : { declaredSkips }),
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
  }

  for (const [index, skip] of manifest.declaredSkips.entries()) {
    if (skip.testId === "") errors.push(`declared_skips[${index}]: missing test_id`);
    // An undocumented skip is the thing this file exists to prevent.
    if (skip.cause.trim() === "") {
      errors.push(`declared_skips[${index}] ("${skip.testId}"): missing cause`);
    }
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
 * declare its checks entirely in runmill.yaml. A manifest that exists but does
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
      source = gitShowSync(repoRoot, `${baseRef}:${manifestPath}`);
      readFrom = "base-ref";
    } catch {
      // Absent at the base ref: a manifest added by this very change. Fall
      // through to the working tree — a new manifest can only ADD checks, and
      // resolveManifest's union is monotonic, so this cannot weaken anything.
      source = undefined;
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
 * Merge repository-declared checks with those configured in runmill.yaml.
 *
 * Union by id, and the repository wins a conflict: the repository is the thing
 * that knows how to build itself. Operator config adds checks the repository
 * has not adopted rather than overriding the ones it has.
 */
export function mergeCheckSources(
  repository: readonly CheckSpec[],
  configured: readonly CheckSpec[],
): CheckSpec[] {
  const byId = new Map<string, CheckSpec>();
  for (const spec of configured) byId.set(spec.id, spec);
  for (const spec of repository) byId.set(spec.id, spec);
  return [...byId.values()];
}

function gitShowSync(repoRoot: string, spec: string): string {
  // Manifest loading happens during config resolution, which is synchronous.
  // argv form, never a shell string: `spec` contains a caller-supplied path.
  return execFileSync("git", ["show", spec], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}
