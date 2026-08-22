import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/platform/process.js";

const CLI = resolve(process.cwd(), "src/cli/main.ts");
const TSX = resolve(process.cwd(), "node_modules/.bin/tsx");

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "runmill-demo-cwd-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("runmill demo", () => {
  it("runs the full simulated delivery loop without credentials", async () => {
    const forbiddenState = join(cwd, "state-must-not-land-here");
    const result = await run(TSX, [CLI, "demo"], {
      cwd,
      env: {
        ...process.env,
        RUNMILL_DATA_DIR: forbiddenState,
        LINEAR_API_KEY: "",
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        // Demo is a standalone product path. A broken ASF setup in the ambient
        // environment must be irrelevant to it.
        RUNMILL_ASF_CONTROL_CONTROLLER_ID: "invalid standalone poison",
        RUNMILL_ASF_CONTROL_KEY_ID: "invalid standalone poison",
        RUNMILL_ASF_CONTROL_KEY_FILE: join(cwd, "must-not-be-read.key"),
        RUNMILL_ASF_RUNTIME_MODULE: join(cwd, "must-not-be-read.mjs"),
        RUNMILL_ASF_DAEMON_REGISTRY: join(cwd, "must-not-be-read.json"),
      },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("selected ENG-102");
    expect(result.stdout).toContain("check demo-candidate: passed (proven)");
    expect(result.stdout).toContain("PR_DELIVERED");
    expect(result.stdout).toContain("Your working tree was not touched");
    expect(existsSync(forbiddenState)).toBe(false);
    expect(readdirSync(cwd)).toEqual([]);
  }, 20_000);

  it("returns the evidence as JSON without progress noise", async () => {
    const result = await run(TSX, [CLI, "--json", "demo"], {
      cwd,
      env: process.env,
    });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      temporary: boolean;
      outcome: { finalState: string };
      transitions: string[];
    };
    expect(parsed.temporary).toBe(true);
    expect(parsed.outcome.finalState).toBe("PR_DELIVERED");
    expect(parsed.transitions).toContain("LOCAL_VERIFY");
    expect(parsed.transitions).toContain("PR_REVIEW");
    expect(readdirSync(cwd)).toEqual([]);
  }, 20_000);
});
