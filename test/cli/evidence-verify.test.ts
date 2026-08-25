import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/platform/process.js";

const CLI = resolve(process.cwd(), "src/cli/main.ts");
const TSX = resolve(process.cwd(), "node_modules/.bin/tsx");

let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("runmill evidence verify", () => {
  it("fails closed on malformed handoff documents without opening Runmill state", async () => {
    directory = mkdtempSync(join(tmpdir(), "runmill-evidence-verify-"));
    const bundle = join(directory, "bundle.json");
    const trust = join(directory, "trust.json");
    const expectations = join(directory, "expectations.json");
    const unopenedState = join(directory, "must-not-exist");
    for (const path of [bundle, trust, expectations]) {
      writeFileSync(path, "{}\n", { mode: 0o600 });
    }

    const result = await run(
      TSX,
      [
        CLI,
        "--json",
        "evidence",
        "verify",
        bundle,
        "--trust",
        trust,
        "--expectations",
        expectations,
      ],
      {
        cwd: directory,
        env: { ...process.env, RUNMILL_DATA_DIR: unopenedState },
      },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("evidence trust document is invalid");
    expect(existsSync(unopenedState)).toBe(false);
  });
});
