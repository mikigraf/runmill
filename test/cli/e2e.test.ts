import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, runWithInput } from "../../src/platform/process.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const CLI = resolve(process.cwd(), "src/cli/main.ts");
const QUICKSTART = resolve(process.cwd(), "examples/quickstart");

// Resolve the local tsx binary by absolute path rather than going through
// `npx`. The CLI is spawned with its cwd inside a temp directory, where npx
// cannot see this project's node_modules and would try to DOWNLOAD tsx —
// making the suite depend on the network and on a shared mutable npm cache.
const TSX = resolve(process.cwd(), "node_modules/.bin/tsx");
// Doctor now proves execution with a real, potentially billable model turn.
// E2E tests exercise its CLI rendering with providers absent; unit tests inject
// local provider fakes for both pass and refusal paths.
const TEST_PATH = [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);

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
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  // The quickstart fixture intentionally keeps policy in the repository for
  // inspection. Real discovery defaults outside the repository, so E2E tests
  // opt into this fixture explicitly instead of weakening the production
  // boundary with a legacy cwd fallback.
  const commandArgs = [CLI, "--config", join(dir, "runmill.yaml"), ...args];
  const options = { cwd: dir, env: { ...process.env, PATH: TEST_PATH, ...env } };
  const result = stdin === undefined
    ? await run(TSX, commandArgs, options)
    : await runWithInput(TSX, commandArgs, stdin, options);
  return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
}

describe("runmill next --dry-run", () => {
  it("selects the highest-priority eligible issue and names its repository", async () => {
    const r = await cli(["next", "--dry-run"], { RUNMILL_FAKE_BACKLOG: "issues.json" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ENG-102");
    expect(r.stdout).toContain("acme/platform");
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
      rejected: { identifier: string; rules: { rule: string }[] }[];
    };
    expect(parsed.selected?.identifier).toBe("ENG-102");
    expect(parsed.selected?.repo).toBe("acme/platform");
    expect(parsed.rejected).toHaveLength(2);
    // Every policy class is present for a rejected candidate, not only the
    // rules that happened to fail. Avoid a brittle total when a new
    // fail-closed rule is added.
    expect(parsed.rejected[0]?.rules.map((result) => result.rule)).toEqual(
      expect.arrayContaining(["workflow-state", "labels", "assignment", "dependencies"]),
    );
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

  it("refuses an empty check union before the first live run", async () => {
    mkdirSync(join(dir, ".runmill"), { recursive: true });
    writeFileSync(join(dir, ".runmill/checks.yaml"), "checks: []\n");
    const policy = join(dir, "runmill.yaml");
    writeFileSync(
      policy,
      readFileSync(policy, "utf8").replace(
        /\n# This fixture has no application[\s\S]*$/u,
        "\nverification:\n  commands: []\n",
      ),
    );

    const r = await cli(["config", "validate"]);

    expect(r.code).toBe(2);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/declares no checks/i);
  });

  it("accepts an operator-owned command when the repository manifest is empty", async () => {
    mkdirSync(join(dir, ".runmill"), { recursive: true });
    writeFileSync(join(dir, ".runmill/checks.yaml"), "checks: []\n");

    const r = await cli(["config", "validate"]);

    expect(r.code).toBe(0);
  });

  it("exits 2 and lists every violation for a bad config", async () => {
    writeFileSync(
      join(dir, "runmill.yaml"),
      [
        "version: 1",
        "autonomy: yolo",
        "providers: { implementer: { implementation: codex } }",
        "backlog: { provider: linear, team: ENG, eligible_states: [Todo], claim_state: In Progress }",
        "github:",
        "  branch_template: runmill/{issue_identifier}",
        "  repositories: []",
      ].join("\n"),
    );
    const r = await cli(["config", "validate"]);
    expect(r.code).toBe(2);
    const diagnostic = `${r.stdout}\n${r.stderr}`;
    expect(diagnostic).toMatch(/autonomy/);
    expect(diagnostic).toMatch(/at least one mapping rule|repositories.*item/i);
    expect(diagnostic).toMatch(/\{attempt\}|branch_template.*pattern/i);
  });

  it("resolves repository-owned paths from the git root when invoked in a subdirectory", async () => {
    mkdirSync(join(dir, ".git"));
    const nested = join(dir, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const result = await run(
      TSX,
      [CLI, "--config", join(dir, "runmill.yaml"), "config", "validate"],
      { cwd: nested, env: process.env },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("is valid");
  });
});

describe("runmill auth login", () => {
  it.each([
    ["a separate value", ["--token", "lin_api_must_not_reach_diagnostics"]],
    ["an equals value", ["--token=lin_api_must_not_reach_diagnostics"]],
  ])("rejects the removed --token argv path with %s without reflecting it", async (_name, args) => {
    const secret = "lin_api_must_not_reach_diagnostics";

    const result = await cli(["auth", "login", "linear", ...args]);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret);
    expect(result.stderr).toMatch(/--token credential option is not accepted/);
  });

  it("refuses empty stdin with a pipe-only command that contains no secret", async () => {
    const result = await cli(["auth", "login", "linear"], {}, "");

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "printenv LINEAR_API_KEY | runmill auth login linear",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/lin_api_[A-Za-z0-9]/u);
  });
});

describe("runmill config show", () => {
  it("prints the resolved config including defaults the file never set", async () => {
    const r = await cli(["--json", "config", "show"]);
    const cfg = JSON.parse(r.stdout) as Record<string, Record<string, unknown>>;
    expect(cfg["workspace"]?.["sandbox"]).toBe("native");
    expect(cfg["workspace"]?.["gitIsolation"]).toBe("clone");
    expect(String(cfg["github"]?.["branchTemplate"])).toContain("{attempt}");
  });
});

describe("standalone mode without ASF", () => {
  it("runs the ordinary one-shot command without ASF keys, ctxlane, or MCP", async () => {
    const emptyBacklog = join(dir, "empty-issues.json");
    writeFileSync(emptyBacklog, "[]\n");

    const result = await cli(
      ["--json", "run"],
      {
        RUNMILL_DEMO: "1",
        RUNMILL_FAKE_BACKLOG: emptyBacklog,
        RUNMILL_ASF_CONTROL_CONTROLLER_ID: "invalid standalone poison",
        RUNMILL_ASF_CONTROL_KEY_ID: "invalid standalone poison",
        RUNMILL_ASF_CONTROL_KEY_FILE: join(dir, "must-not-be-read.key"),
        RUNMILL_ASF_RUNTIME_MODULE: join(dir, "must-not-be-read.mjs"),
        RUNMILL_ASF_DAEMON_REGISTRY: join(dir, "must-not-be-read.json"),
        RUNMILL_CTXLANE_ENDPOINT: "unix:///must/not/be-contacted.sock",
      },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ran: false });
    expect(result.stderr).toBe("");
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

  it("scopes dependency readiness and refuses a fixture with no trusted remote", async () => {
    const r = await cli(["--json", "doctor", "--check", "verification:dependencies"]);
    const out = JSON.parse(r.stdout) as {
      checks: { id: string; status: string; code?: string }[];
    };

    expect(out.checks).toHaveLength(1);
    expect(out.checks[0]).toMatchObject({
      id: "verification:dependencies",
      status: "fail",
      code: "RM-VERIFY-005",
    });
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
