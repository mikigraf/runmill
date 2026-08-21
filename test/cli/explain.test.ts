/**
 * Explanations and the support bundle.
 *
 * The bundle is the one artifact a developer is invited to paste into a public
 * issue tracker, so what it leaves out matters more than what it includes.
 */
import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { EXPLANATIONS, buildSupportBundle } from "../../src/cli/explain.js";
import type { CheckResult } from "../../src/doctor/checks.js";
import packageJson from "../../package.json" with { type: "json" };

const CHECKS: CheckResult[] = [
  { id: "git", status: "pass", observed: "git version 2.50.1", expected: "git >= 2.30" },
  {
    id: "sandbox:mechanism",
    status: "fail",
    code: "RM-SANDBOX-001",
    observed: `bwrap not found (looked under ${homedir()}/bin)`,
    expected: "bubblewrap installed",
  },
  {
    id: "sandbox:network",
    status: "warn",
    observed: "Seatbelt cannot scope network by host",
    expected: "proxy egress",
  },
];

describe("EXPLANATIONS", () => {
  it("covers every topic doctor advertises", () => {
    expect(Object.keys(EXPLANATIONS).sort()).toEqual(["github", "linear", "provider", "sandbox"]);
  });

  it("explains what each platform can and cannot enforce rather than implying parity", () => {
    // Claiming network scoping on macOS would be the most consequential thing
    // this text could get wrong.
    expect(EXPLANATIONS["sandbox"]).toMatch(/Seatbelt/);
    expect(EXPLANATIONS["sandbox"]).toMatch(/bubblewrap/);
    expect(EXPLANATIONS["sandbox"]).toMatch(/network/i);
  });

  it("states the negative capability requirement for merge modes", () => {
    expect(EXPLANATIONS["github"]).toMatch(/branch protection/i);
    expect(EXPLANATIONS["github"]).toMatch(/administration/);
  });

  it("points every topic at its full reference", () => {
    for (const [topic, body] of Object.entries(EXPLANATIONS)) {
      expect(body, `${topic} has no docs pointer`).toMatch(/docs\/[a-z]+\.md/);
    }
  });
});

describe("buildSupportBundle", () => {
  it("includes the environment and every check with its status", () => {
    const { human, data } = buildSupportBundle(CHECKS, process.cwd());
    expect(human).toContain("runmill");
    expect(human).toContain("node");
    expect(human).toContain("platform");
    expect((data.checks as unknown[]).length).toBe(3);
    expect(human).toContain("git version 2.50.1");
  });

  it("redacts the home directory from observations", () => {
    // A path like /Users/jane/... names the reporter. The bundle is meant to be
    // pasted somewhere public.
    const { human, data } = buildSupportBundle(CHECKS, process.cwd());
    expect(human).not.toContain(homedir());
    expect(JSON.stringify(data)).not.toContain(homedir());
    expect(human).toContain("~/bin");
  });

  it("carries the error code so a maintainer can look it up", () => {
    const { data } = buildSupportBundle(CHECKS, process.cwd());
    expect(JSON.stringify(data)).toContain("RM-SANDBOX-001");
  });

  it("marks pass, warn, and fail distinguishably", () => {
    const { human } = buildSupportBundle(CHECKS, process.cwd());
    expect(human).toContain("✓");
    expect(human).toContain("✗");
    expect(human).toContain("!");
  });

  it("reports the installed Runmill version, not the managed repository version", () => {
    const { data } = buildSupportBundle(CHECKS, "/nonexistent-path-for-test");
    expect(data.runmill).toBe(packageJson.version);
  });

  it("redacts absolute paths outside HOME and the repository", () => {
    const checks: CheckResult[] = [
      {
        id: "configuration",
        status: "fail",
        observed: "invalid file at /private/tmp/runmill-secret/policy.yaml",
        expected: "valid policy",
      },
      {
        id: "repository",
        status: "fail",
        observed: "missing /work/customer/secret-repo/.runmill/checks.yaml",
        expected: "manifest",
      },
    ];
    const { human, data } = buildSupportBundle(checks, "/different/repository");
    expect(human).not.toContain("/private/tmp/runmill-secret");
    expect(human).not.toContain("/work/customer/secret-repo");
    expect(JSON.stringify(data)).not.toContain("/private/tmp/runmill-secret");
    expect(JSON.stringify(data)).not.toContain("/work/customer/secret-repo");
    expect(human).toContain("<path>");
  });

  it("redacts remote URLs including embedded credentials and private repository names", () => {
    const checks: CheckResult[] = [
      {
        id: "repository:remote",
        status: "pass",
        observed: "https://alice:ghp_SYNTHETIC_SECRET@github.example.com/acme/private.git",
        expected: "origin",
      },
    ];
    const { human, data } = buildSupportBundle(checks, process.cwd());
    const serialized = `${human}\n${JSON.stringify(data)}`;
    expect(serialized).not.toContain("ghp_SYNTHETIC_SECRET");
    expect(serialized).not.toContain("acme/private");
    expect(serialized).toContain("<url>");
  });

  it("omits the onboarding section when nothing has been recorded", () => {
    const { human } = buildSupportBundle(CHECKS, process.cwd());
    expect(human).not.toContain("onboarding");
  });

  it("includes onboarding milestones and doctor failures when present", () => {
    const { human, data } = buildSupportBundle(CHECKS, process.cwd(), {
      milestones: { installed_at: "2026-01-01T00:00:00.000Z", first_run_at: "2026-01-01T00:05:00.000Z" },
      doctorFailures: { "sandbox:mechanism": 3 },
      tthwSeconds: 300,
    });
    expect(human).toContain("onboarding");
    expect(human).toContain("installed_at → first_run_at");
    expect(human).toContain("tthw        300s");
    expect(human).toContain("sandbox:mechanism");
    expect((data.onboarding as { tthwSeconds: number }).tthwSeconds).toBe(300);
  });

  it("tells the reader where to file it", () => {
    expect(buildSupportBundle(CHECKS, process.cwd()).human).toContain("issues/new");
  });

  it("produces JSON-serializable data", () => {
    const { data } = buildSupportBundle(CHECKS, process.cwd());
    expect(() => JSON.stringify(data)).not.toThrow();
  });
});
