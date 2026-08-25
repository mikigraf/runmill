/**
 * Bounded byte-for-byte freshness check for the vendored ctxlane fixtures.
 *
 * Compares the exact forty-three files listed in test/fixtures/ctxlane/PROVENANCE.md
 * against a sibling ctxlane publication checkout. Offline and credential-free:
 * it only reads local files. CI never has that sibling checkout, so the
 * default with no source given must stay a safe no-op — this is a
 * maintainer-run check, not a runtime dependency.
 *
 * Usage:
 *   tsx scripts/check-ctxlane-fixture-freshness.ts --source /path/to/ctxlane
 *   RUNMILL_CTXLANE_FIXTURE_SOURCE=/path/to/ctxlane tsx scripts/check-ctxlane-fixture-freshness.ts
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "ctxlane");

/**
 * Mirrors test/fixtures/ctxlane/PROVENANCE.md. Update both together.
 */
const SCHEMA_NAMES = [
  "ctxlane.work-order-authorization.v1.schema.json",
  "ctxlane.identity-lease-request.v1.schema.json",
  "ctxlane.identity-lease.v1.schema.json",
  "ctxlane.automation-error.v1.schema.json",
  "ctxlane.identity-lease-close-receipt.v1.schema.json",
  "ctxlane.identity-lease-close.v1.schema.json",
  "ctxlane.identity-lease-inspect-receipt.v1.schema.json",
  "ctxlane.identity-lease-inspect.v1.schema.json",
  "ctxlane.identity-lease-renew-acknowledgement.v1.schema.json",
  "ctxlane.identity-lease-renew-receipt.v1.schema.json",
  "ctxlane.identity-lease-renew.v1.schema.json",
  "ctxlane.identity-lease-revoke-receipt.v1.schema.json",
  "ctxlane.identity-lease-revoke.v1.schema.json",
  "ctxlane.lease-view.v1.schema.json",
  "ctxlane.profile-list.v1.schema.json",
  "ctxlane.service-health.v1.schema.json",
  "ctxlane.automation-readiness.v1.schema.json",
] as const;

const EXAMPLE_NAMES = [
  "work-order-authorization.v1.json",
  "identity-lease-request.v1.json",
  "identity-lease-active.v1.json",
  "identity-lease-refused.v1.json",
  "automation-error.v1.json",
  "work-order-signing-vector.v1.json",
  "lease-close-receipt.v1.json",
  "lease-close-request.v1.json",
  "lease-inspect-receipt.v1.json",
  "lease-inspect-request.v1.json",
  "lease-renew-acknowledgement.v1.json",
  "lease-renew-receipt.v1.json",
  "lease-renew-request.v1.json",
  "lease-revoke-receipt.v1.json",
  "lease-revoke-request.v1.json",
  "lease-view-active.v1.json",
  "lease-view-per-lease-isolated.v1.json",
  "lease-view-closed.v1.json",
  "lease-view-refused.v1.json",
  "lease-view-renewing.v1.json",
  "lease-view-revoked.v1.json",
  "profile-list.v1.json",
  "service-health.v1.json",
  "automation-readiness-ready.v1.json",
  "automation-readiness-not-ready.v1.json",
  "automation-readiness-development-exception.v1.json",
] as const;

interface FixtureEntry {
  readonly fixtureRelativePath: string;
  readonly sourceRelativePath: string;
}

/**
 * ctxlane publishes examples under `schemas/examples/`, one level deeper than
 * where Runmill vendors them under `examples/`; the two path shapes have to be
 * mapped explicitly rather than assumed identical.
 */
const ENTRIES: readonly FixtureEntry[] = [
  ...SCHEMA_NAMES.map((name) => ({
    fixtureRelativePath: join("schemas", name),
    sourceRelativePath: join("schemas", name),
  })),
  ...EXAMPLE_NAMES.map((name) => ({
    fixtureRelativePath: join("examples", name),
    sourceRelativePath: join("schemas", "examples", name),
  })),
];

function parseSourceArgument(argv: readonly string[]): string | undefined {
  const flagIndex = argv.indexOf("--source");
  if (flagIndex !== -1) {
    const value = argv[flagIndex + 1];
    if (value === undefined) throw new Error("--source requires a path argument");
    return value;
  }
  const envValue = process.env.RUNMILL_CTXLANE_FIXTURE_SOURCE;
  return envValue === undefined || envValue === "" ? undefined : envValue;
}

function shortDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

function listActualNames(directory: string): readonly string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

/**
 * Drift guard on the vendored side: catches a fixture file added or removed
 * without updating this list and PROVENANCE.md together, independent of
 * whether a comparison source is available.
 */
function checkVendoredSetMatchesExpected(): readonly string[] {
  const problems: string[] = [];
  const actualSchemas = listActualNames(join(FIXTURES_ROOT, "schemas"));
  const actualExamples = listActualNames(join(FIXTURES_ROOT, "examples"));

  for (const name of actualSchemas) {
    if (!SCHEMA_NAMES.includes(name as (typeof SCHEMA_NAMES)[number])) {
      problems.push(`[EXTRA] schemas/${name} is vendored but not listed in PROVENANCE.md`);
    }
  }
  for (const name of SCHEMA_NAMES) {
    if (!actualSchemas.includes(name)) {
      problems.push(`[MISSING] schemas/${name} is listed in PROVENANCE.md but not vendored`);
    }
  }
  for (const name of actualExamples) {
    if (!EXAMPLE_NAMES.includes(name as (typeof EXAMPLE_NAMES)[number])) {
      problems.push(`[EXTRA] examples/${name} is vendored but not listed in PROVENANCE.md`);
    }
  }
  for (const name of EXAMPLE_NAMES) {
    if (!actualExamples.includes(name)) {
      problems.push(`[MISSING] examples/${name} is listed in PROVENANCE.md but not vendored`);
    }
  }
  return problems;
}

type ComparisonStatus = "match" | "changed" | "missing-in-source";

interface ComparisonResult {
  readonly entry: FixtureEntry;
  readonly status: ComparisonStatus;
  readonly fixtureDigest: string;
  readonly sourceDigest: string | undefined;
}

function compareEntry(sourceRoot: string, entry: FixtureEntry): ComparisonResult {
  const fixtureBytes = readFileSync(join(FIXTURES_ROOT, entry.fixtureRelativePath));
  const fixtureDigest = shortDigest(fixtureBytes);

  const sourcePath = join(sourceRoot, entry.sourceRelativePath);
  if (!existsSync(sourcePath)) {
    return { entry, status: "missing-in-source", fixtureDigest, sourceDigest: undefined };
  }

  const sourceBytes = readFileSync(sourcePath);
  const sourceDigest = shortDigest(sourceBytes);
  const status: ComparisonStatus = Buffer.compare(fixtureBytes, sourceBytes) === 0 ? "match" : "changed";
  return { entry, status, fixtureDigest, sourceDigest };
}

function statusMarker(status: ComparisonStatus): string {
  if (status === "match") return "OK";
  if (status === "changed") return "CHANGED";
  return "MISSING";
}

function main(): void {
  const source = parseSourceArgument(process.argv.slice(2));

  if (source === undefined) {
    console.log(
      "ctxlane fixture freshness comparison not requested: pass --source PATH or set " +
        "RUNMILL_CTXLANE_FIXTURE_SOURCE to the sibling ctxlane publication root to compare " +
        "vendored fixtures against it. Skipping.",
    );
    process.exit(0);
  }

  const sourceRoot = resolve(source);
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    console.error(`ctxlane fixture source not found: ${sourceRoot}`);
    process.exit(1);
  }

  const vendoredProblems = checkVendoredSetMatchesExpected();
  for (const problem of vendoredProblems) console.log(problem);

  const results = ENTRIES.map((entry) => compareEntry(sourceRoot, entry));
  for (const result of results) {
    const digestSuffix = result.sourceDigest === undefined ? "" : ` source=${result.sourceDigest}`;
    console.log(
      `[${statusMarker(result.status)}] ${result.entry.fixtureRelativePath} fixture=${result.fixtureDigest}${digestSuffix}`,
    );
  }

  const failures = results.filter((result) => result.status !== "match");
  if (failures.length > 0 || vendoredProblems.length > 0) {
    console.error(
      `ctxlane fixture freshness check failed: ${failures.length} of ${results.length} vendored files differ ` +
        `from ${sourceRoot}, ${vendoredProblems.length} vendored-set problem(s). Re-vendor from source and ` +
        `update test/fixtures/ctxlane/PROVENANCE.md.`,
    );
    process.exit(1);
  }

  console.log(`ctxlane fixture freshness check passed: ${results.length} files match ${sourceRoot}.`);
}

main();
