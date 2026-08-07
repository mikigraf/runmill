import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/platform/process.js";
import { mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(process.cwd(), "src/cli/main.ts");
const QUICKSTART = resolve(process.cwd(), "examples/quickstart");

// Resolve the local tsx binary by absolute path rather than going through
// `npx`. The CLI is spawned with its cwd inside a temp directory, where npx
// cannot see this project's node_modules and would try to DOWNLOAD tsx —
// making the suite depend on the network and on a shared mutable npm cache.
const TSX = resolve(process.cwd(), "node_modules/.bin/tsx");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runmill-cli-"));
  cpSync(QUICKSTART, dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function cli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await run(TSX, [CLI, ...args], {
    cwd: dir,
    env: { ...process.env, ...env },
  });
  return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
}

describe("runmill next --dry-run", () => {
  it("selects the highest-priority eligible issue and names its repository", async () => {
    const r = await cli(["next", "--dry-run"], { RUNMILL_FAKE_BACKLOG: "issues.json" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ENG-102");
    expect(r.stdout).toContain("acme/ios");
  });

  it("sorts an unprioritized issue last even when it is by far the oldest", async () => {
    const r = await cli(["next", "--dry-run"], { RUNMILL_FAKE_BACKLOG: "issues.json" });
    const selected = r.stdout.indexOf("Would select");
    const unprioritized = r.stdout.indexOf("ENG-106");
    expect(unprioritized).toBeGreaterThan(selected);
    expect(r.stdout).not.toMatch(/Would select\s+ENG-106/);
  });

  it("explains each rejection with the specific failing rule", async () => {
    const r = await cli(["next", "--dry-run"], { RUNMILL_FAKE_BACKLOG: "issues.json" });
    expect(r.stdout).toMatch(/ENG-104[\s\S]*dependencies: blocked by ENG-99/);
    expect(r.stdout).toMatch(/ENG-105[\s\S]*excluded label\(s\): needs-design/);
  });

  it("emits machine-readable output under --json", async () => {
    const r = await cli(["--json", "next"], { RUNMILL_FAKE_BACKLOG: "issues.json" });
    const parsed = JSON.parse(r.stdout) as {
      selected: { identifier: string; repo: string } | null;
      rejected: { identifier: string; rules: unknown[] }[];
    };
    expect(parsed.selected?.identifier).toBe("ENG-102");
    expect(parsed.selected?.repo).toBe("acme/ios");
    expect(parsed.rejected).toHaveLength(2);
    // Every rule is present for a rejected candidate, not only failures.
    expect(parsed.rejected[0]?.rules).toHaveLength(9);
  });

  it("prints nothing extra under --quiet", async () => {
    const r = await cli(["--quiet", "next"], { RUNMILL_FAKE_BACKLOG: "issues.json" });
    expect(r.stdout.trim()).toBe("");
  });
});

describe("runmill config validate", () => {
  it("accepts the quickstart configuration", async () => {
    const r = await cli(["config", "validate"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("is valid");
  });

  it("exits 2 and lists every violation for a bad config", async () => {
    writeFileSync(
      join(dir, "runmill.yaml"),
      [
        "version: 1",
        "autonomy: yolo",
        "provider: { implementation: codex }",
        "backlog: { provider: linear, team: ENG, eligible_states: [Todo], claim_state: In Progress }",
        "github:",
        "  branch_template: runmill/{issue_identifier}",
        "  repositories: []",
      ].join("\n"),
    );
    const r = await cli(["config", "validate"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/autonomy/);
    expect(r.stdout).toMatch(/at least one mapping rule/);
    expect(r.stdout).toMatch(/\{attempt\}/);
  });
});

describe("runmill config show", () => {
  it("prints the resolved config including defaults the file never set", async () => {
    const r = await cli(["--json", "config", "show"]);
    const cfg = JSON.parse(r.stdout) as Record<string, Record<string, unknown>>;
    expect(cfg["workspace"]?.["sandbox"]).toBe("native");
    expect(cfg["workspace"]?.["gitIsolation"]).toBe("separate-git-dir");
    expect(String(cfg["github"]?.["branchTemplate"])).toContain("{attempt}");
  });
});

describe("runmill doctor", () => {
  it("reports a status for every check and an overall verdict", async () => {
    const r = await cli(["--json", "doctor"]);
    const out = JSON.parse(r.stdout) as {
      overall: string;
      checks: { id: string; status: string }[];
    };
    expect(["pass", "warn", "fail"]).toContain(out.overall);
    expect(out.checks.map((c) => c.id)).toContain("git");
    expect(out.checks.map((c) => c.id)).toContain("sandbox:mechanism");
  });

  it("supports scoped reruns", async () => {
    const r = await cli(["--json", "doctor", "--check", "sandbox"]);
    const out = JSON.parse(r.stdout) as { checks: { id: string }[] };
    expect(out.checks.length).toBeGreaterThan(0);
    expect(out.checks.every((c) => c.id.startsWith("sandbox"))).toBe(true);
  });

  it("proves the sandbox denies a credential read rather than assuming it", async () => {
    const r = await cli(["--json", "doctor", "--check", "sandbox:deny"]);
    const out = JSON.parse(r.stdout) as { checks: { id: string; status: string }[] };
    const probe = out.checks.find((c) => c.id === "sandbox:deny-credential-read");
    expect(probe?.status).toBe("pass");
  });
});

describe("runmill errors", () => {
  it("renders the four-part error form with a docs link", async () => {
    rmSync(join(dir, "runmill.yaml"));
    const r = await cli(["next"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("What happened");
    expect(r.stderr).toContain("Why");
    expect(r.stderr).toContain("Fix");
    expect(r.stderr).toMatch(/https:\/\/github\.com\/.*\/errors/);
  });

  it("emits structured errors under --json", async () => {
    rmSync(join(dir, "runmill.yaml"));
    const r = await cli(["--json", "next"]);
    const err = JSON.parse(r.stdout) as { code: string; docsUrl: string };
    expect(err.code).toMatch(/^RM-/);
    expect(err.docsUrl).toMatch(/github\.com/);
  });
});

describe("runmill --version", () => {
  it("prints a version", async () => {
    const r = await cli(["--version"]);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
