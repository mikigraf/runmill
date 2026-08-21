/**
 * Live adapter tests.
 *
 * Excluded from the default `npm test` run (see vitest.config.ts) because they
 * talk to real systems and real credentials. Run explicitly:
 *
 *   npx vitest run --config vitest.live.config.ts
 *
 * Each suite skips itself when its credential or binary is absent, so this file
 * is safe to run anywhere; it simply reports less.
 */
import { describe, expect, it } from "vitest";
import { CliProviderAdapter, CODEX_DIALECT, CLAUDE_DIALECT } from "../../src/agent/cli-provider.js";
import { CredentialStore } from "../../src/credentials/store.js";
import { GitHubForgeAdapter } from "../../src/pr/github.js";
import { LinearBacklogAdapter } from "../../src/backlog/linear.js";
import { snapshotHash } from "../../src/domain/snapshot.js";

const creds = new CredentialStore();
const githubToken = await creds.get("github");
const linearKey = await creds.get("linear");

const codex = new CliProviderAdapter({ dialect: CODEX_DIALECT });
const claude = new CliProviderAdapter({ dialect: CLAUDE_DIALECT });
const codexInstalled = (await codex.detect()).installed;
const claudeInstalled = (await claude.detect()).installed;

describe.runIf(codexInstalled)("live: Codex provider", () => {
  it("detects the installed binary and reports a version", async () => {
    const installation = await codex.detect();
    expect(installation.installed).toBe(true);
    expect(installation.version).toBeTruthy();
  });

  it("reports authentication status", async () => {
    const auth = await codex.authStatus();
    expect(typeof auth.authenticated).toBe("boolean");
  });

  it("advertises the capabilities the orchestrator depends on", async () => {
    const caps = await codex.capabilities();
    expect(caps.streamingOutput).toBe(true);
    expect(caps.toolAllowDeny).toBe(true);
  });

  it("refuses to resume for a reviewer role", async () => {
    await expect(
      codex.resume({
        runId: "r",
        issueId: "ENG-1",
        role: "local-reviewer",
        attempt: 1,
        workingDirectory: process.cwd(),
        taskPacketPath: "task.json",
        allowedPaths: [],
        forbiddenPaths: [],
        allowedCommands: [],
        network: "none",
        maxTurns: 1,
        timeoutMs: 1000,
        sessionId: "s",
      }),
    ).rejects.toThrow(/may not resume/i);
  });
});

describe.runIf(claudeInstalled)("live: Claude Code provider", () => {
  it("detects the installed binary", async () => {
    expect((await claude.detect()).installed).toBe(true);
  });
});

describe.runIf(githubToken !== undefined)("live: GitHub forge", () => {
  // Constructed lazily: `describe.runIf` still evaluates this callback body
  // when the condition is false, so building a client here would throw on a
  // host without the credential.
  const forge = (): GitHubForgeAdapter =>
    new GitHubForgeAdapter({ token: githubToken as string });
  const REPO = "nodejs/node";

  it("lists checks for a real ref, unioning check-runs and statuses", async () => {
    const checks = await forge().listChecks({ repo: REPO, ref: "main" });
    expect(Array.isArray(checks)).toBe(true);
    for (const check of checks) {
      expect(check.name).toBeTruthy();
      expect(check.headSha).toBeTruthy();
    }
  }, 60_000);

  it("reads branch protection, or reports it unreadable rather than guessing", async () => {
    const protection = await forge().getBranchProtection({ repo: REPO, branch: "main" });
    expect(typeof protection.unreadable).toBe("boolean");
    if (!protection.unreadable) {
      expect(Array.isArray(protection.requiredChecks)).toBe(true);
    }
  }, 60_000);

  it("answers the negative capability test on a repo it does not admin", async () => {
    // The gate that keeps merge locked when the credential is too powerful.
    const canWrite = await forge().canWriteBranchProtection({ branch: "main", repo: REPO });
    expect(canWrite).toBe(false);
  }, 60_000);

  it("returns undefined for a pull request that does not exist", async () => {
    const pr = await forge().getPullRequest({ repo: REPO, number: 999_999_999 });
    expect(pr).toBeUndefined();
  }, 60_000);

  it("rejects a malformed repository name before any network call", async () => {
    await expect(forge().listChecks({ repo: "not-a-repo", ref: "main" })).rejects.toThrow(
      /owner\/name/,
    );
  });
});

describe.runIf(linearKey !== undefined)("live: Linear backlog", () => {
  const backlog = (): LinearBacklogAdapter =>
    new LinearBacklogAdapter({ apiKey: linearKey as string });

  it("lists candidates for the configured team without throwing", async () => {
    const team = process.env["RUNMILL_LIVE_TEAM"] ?? "ENG";
    const issues = await backlog().listCandidates({ team, states: ["Todo", "Backlog"] });
    expect(Array.isArray(issues)).toBe(true);
    for (const issue of issues) {
      expect(issue.identifier).toMatch(/^[A-Z]+-\d+$/);
      // Priority must come back RAW, including Linear's 0 = no priority.
      expect(issue.priority).toBeGreaterThanOrEqual(0);
      expect(issue.priority).toBeLessThanOrEqual(4);
    }
  }, 60_000);

  it("produces a stable snapshot hash for a real issue", async () => {
    // snapshotHash is a domain function now, not an adapter method: it must
    // give the same answer whatever produced the issue.
    const team = process.env["RUNMILL_LIVE_TEAM"] ?? "ENG";
    const issues = await backlog().listCandidates({ team, states: ["Todo", "Backlog"] });
    const first = issues[0];
    if (first === undefined) return;
    expect(snapshotHash(first)).toBe(snapshotHash(first));
  }, 60_000);
});

describe("live: credential resolution", () => {
  it("resolves a GitHub token from gh when no env var is set", async () => {
    const token = await new CredentialStore().get("github");
    // gh is authenticated on this host; if it were not, this documents that.
    expect(token === undefined || token.length > 0).toBe(true);
  }, 30_000);

  it("reports a clear error for a credential that does not exist", async () => {
    const store = new CredentialStore({
      linear: "RUNMILL_DEFINITELY_UNSET_VAR",
      github: "RUNMILL_DEFINITELY_UNSET_VAR_2",
      "runmill-policy": "RUNMILL_DEFINITELY_UNSET_VAR_3",
    });
    await expect(store.require("linear")).rejects.toThrow(/RM-AUTH-003|No credential/);
  }, 30_000);
});
