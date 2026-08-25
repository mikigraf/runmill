import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/platform/process.js";

const SCRIPT = resolve(process.cwd(), "scripts/check-ctxlane-fixture-freshness.ts");
const TSX = resolve(process.cwd(), "node_modules/.bin/tsx");
const FIXTURES_ROOT = resolve(process.cwd(), "test/fixtures/ctxlane");

let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

/** Builds a source tree shaped like the upstream ctxlane publication root. */
function buildSourceTree(): string {
  const root = mkdtempSync(join(tmpdir(), "runmill-ctxlane-source-"));
  cpSync(join(FIXTURES_ROOT, "schemas"), join(root, "schemas"), { recursive: true });
  mkdirSync(join(root, "schemas", "examples"), { recursive: true });
  cpSync(join(FIXTURES_ROOT, "examples"), join(root, "schemas", "examples"), { recursive: true });
  return root;
}

describe("ctxlane fixture freshness check", () => {
  it("reports no comparison requested and exits 0 when no source is given", async () => {
    const result = await run(TSX, [SCRIPT], {
      cwd: process.cwd(),
      env: { ...process.env, RUNMILL_CTXLANE_FIXTURE_SOURCE: "" },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("not requested");
  });

  it("passes with a digest report when the source is byte-identical", async () => {
    directory = buildSourceTree();

    const result = await run(TSX, [SCRIPT, "--source", directory], { cwd: process.cwd(), env: process.env });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check passed: 43 files match");
    expect(result.stdout).toContain("[OK] schemas/ctxlane.work-order-authorization.v1.schema.json");
    expect(result.stdout).toContain("[OK] examples/work-order-signing-vector.v1.json");
    expect(result.stdout).toContain("[OK] examples/profile-list.v1.json");
  });

  it("fails closed and reports the changed file when a source byte differs", async () => {
    directory = buildSourceTree();
    const changedPath = join(directory, "schemas", "ctxlane.automation-error.v1.schema.json");
    const original = readFileSync(changedPath, "utf8");
    writeFileSync(changedPath, `${original}\n`);

    const result = await run(TSX, [SCRIPT, "--source", directory], { cwd: process.cwd(), env: process.env });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("[CHANGED] schemas/ctxlane.automation-error.v1.schema.json");
    expect(result.stderr).toContain("ctxlane fixture freshness check failed");
  });

  it("fails closed when an explicitly given source path does not exist", async () => {
    const missing = join(tmpdir(), "runmill-ctxlane-source-does-not-exist");

    const result = await run(TSX, [SCRIPT, "--source", missing], { cwd: process.cwd(), env: process.env });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ctxlane fixture source not found");
  });
});
