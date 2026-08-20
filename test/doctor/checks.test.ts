/**
 * Host checks.
 *
 * These decide whether a run is allowed to start at all, so the interesting
 * cases are the ones where a check could wrongly report success — a missing
 * binary read as present, a sandbox assumed rather than proven, an unsupported
 * platform sailing through.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  checkGit,
  checkRepository,
  checkRemote,
  checkProvider,
  checkSandbox,
  checkCiEnvironment,
  runAllChecks,
  worstStatus,
} from "../../src/doctor/checks.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runmill-doctor-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkGit", () => {
  it("passes on a host with git and reports the version it found", async () => {
    const r = await checkGit();
    expect(r.id).toBe("git");
    expect(r.status).toBe("pass");
    expect(r.observed).toMatch(/git version/);
  });
});

describe("checkRemote", () => {
  /**
   * The first thing a run does is `git ls-remote origin` to take the issue
   * lease. Without a remote that fails deep inside the daemon, as a raw git
   * message, after the run is already claimed — and one quarantine is enough to
   * trip the breaker. doctor is the place to say so, before any of that.
   */
  it("fails when the repository has no origin remote", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });

    const r = await checkRemote({ repoRoot: dir });

    expect(r.id).toBe("repository:remote");
    expect(r.status).toBe("fail");
    expect(r.observed).toContain("no origin remote");
  });

  it("names the command that fixes it", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });

    const r = await checkRemote({ repoRoot: dir });

    expect(r.remediation).toContain("git remote add origin");
  });

  it("explains that leases live on the remote, not just that a remote is missing", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });

    const r = await checkRemote({ repoRoot: dir });

    expect(r.expected).toMatch(/lease/i);
  });

  it("reports the remote url when one is configured", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "https://example.invalid/acme/x.git"], {
      cwd: dir,
    });

    const r = await checkRemote({ repoRoot: dir });

    expect(r.observed).toContain("https://example.invalid/acme/x.git");
  });

  it("does not fail the check merely because the remote is unreachable", async () => {
    // doctor runs on laptops, planes, and locked-down networks. An unreachable
    // remote is worth flagging, but it is not the same defect as not having
    // configured one at all, and it must not be reported as if it were.
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "https://example.invalid/acme/x.git"], {
      cwd: dir,
    });

    const r = await checkRemote({ repoRoot: dir });

    expect(r.status).not.toBe("fail");
  });

  it("cannot block forever on a remote that wants to ask a question", async () => {
    // `doctor` is what an operator runs when something is already wrong, often
    // against a remote whose credential has expired. git would happily sit on
    // a username prompt or an unknown-host prompt forever, and a diagnostic
    // command that hangs is worse than one that reports a failure.
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://user@10.255.255.1/private.git"],
      { cwd: dir },
    );

    const started = Date.now();
    const r = await checkRemote({ repoRoot: dir });

    expect(Date.now() - started).toBeLessThan(25_000);
    expect(r.status).not.toBe("pass");
  }, 30_000);

  it("is part of the standard doctor run", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });

    const results = await runAllChecks({ repoRoot: dir }, ["codex"]);

    expect(results.map((c) => c.id)).toContain("repository:remote");
  });
});

describe("checkRepository", () => {
  it("reports the repository root when inside one", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    const r = await checkRepository({ repoRoot: dir });
    expect(r.status).toBe("pass");
    // macOS symlinks /var to /private/var, so compare on the basename.
    expect(r.observed).toContain(dir.split("/").pop() as string);
  });

  it("fails outside a repository rather than assuming the cwd will do", async () => {
    const r = await checkRepository({ repoRoot: tmpdir() });
    // tmpdir is not a repository on any supported platform.
    if (r.status === "pass") {
      // Someone has a repo at tmpdir; the assertion would be meaningless.
      expect(r.observed).toBeTruthy();
      return;
    }
    expect(r.status).toBe("fail");
    expect(r.observed).toBe("not a git repository");
    expect(r.remediation).toMatch(/git repository/);
  });
});

describe("checkProvider", () => {
  it("refuses an unknown implementation instead of quietly probing codex", async () => {
    // Anything that was not exactly "claude" fell through to codex, so a typo
    // in runmill.yaml produced a PASSING check for a provider nobody chose.
    const r = await checkProvider("cluade");
    expect(r.status).toBe("fail");
    expect(r.observed).toMatch(/unknown provider/);
    expect(r.remediation).toBe("runmill config validate");
  });

  it("fails with an installable remediation when a valid provider is absent", async () => {
    // `claude` is a real implementation; on a host without it this must fail
    // with advice, and on a host with it, pass.
    const r = await checkProvider("claude");
    expect(r.id).toBe("provider:claude");
    if (r.status === "fail") {
      expect(r.observed).toMatch(/not found/);
      expect(r.remediation).toMatch(/Install/);
    }
  });

  it("names the provider in the check id, so --check can target it", async () => {
    const r = await checkProvider("claude");
    expect(r.id).toBe("provider:claude");
  });
});

describe("checkCiEnvironment", () => {
  const original = process.env["CI"];
  afterEach(() => {
    if (original === undefined) delete process.env["CI"];
    else process.env["CI"] = original;
  });

  it("fails under CI, because runmill is local-first in this release", () => {
    process.env["CI"] = "true";
    const r = checkCiEnvironment();
    expect(r.status).toBe("fail");
    expect(r.remediation).toMatch(/local-first/);
  });

  it("passes on an interactive host", () => {
    delete process.env["CI"];
    expect(checkCiEnvironment().status).toBe("pass");
  });

  it("treats CI=1 the same as CI=true", () => {
    process.env["CI"] = "1";
    expect(checkCiEnvironment().status).toBe("fail");
  });

  it("does not treat an arbitrary CI value as CI", () => {
    process.env["CI"] = "false";
    expect(checkCiEnvironment().status).toBe("pass");
  });
});

describe("checkSandbox", () => {
  it("reports a mechanism appropriate to this platform", async () => {
    const results = await checkSandbox();
    const mechanism = results.find((r) => r.id === "sandbox:mechanism");
    expect(mechanism).toBeDefined();
    if (platform() === "darwin") {
      expect(mechanism?.observed).toMatch(/Seatbelt/);
    } else if (platform() === "linux") {
      expect(mechanism?.observed).toMatch(/bubblewrap/);
    } else {
      expect(mechanism?.status).toBe("fail");
    }
  }, 30_000);

  it("PROVES credential denial on every supported platform", async () => {
    // This probe only existed on the macOS path, so on Linux doctor asked
    // whether a sandbox existed — exactly what it claims not to do.
    if (platform() !== "darwin" && platform() !== "linux") return;
    const results = await checkSandbox();
    const probe = results.find((r) => r.id === "sandbox:deny-credential-read");
    expect(probe, "no credential-denial probe ran").toBeDefined();
    expect(probe?.status).toBe("pass");
    expect(probe?.observed).toBe("read denied");
  }, 30_000);

  it("does not leave its probe secret behind", async () => {
    await checkSandbox();
    const leftovers = (await import("node:fs")).readdirSync(tmpdir());
    expect(leftovers.filter((f) => f.startsWith("runmill-probe-home-"))).toEqual([]);
  }, 30_000);

  it("surfaces the macOS network limitation instead of hiding it", async () => {
    if (platform() !== "darwin") return;
    const results = await checkSandbox();
    const network = results.find((r) => r.id === "sandbox:network");
    expect(network?.status).toBe("warn");
    expect(network?.remediation).toMatch(/proxy/);
  }, 30_000);

  it("checks user namespaces on Linux, where the sandbox depends on them", async () => {
    if (platform() !== "linux") return;
    const results = await checkSandbox();
    expect(results.some((r) => r.id === "sandbox:userns")).toBe(true);
  }, 30_000);
});

describe("runAllChecks", () => {
  it("returns the environment check first, then the host and sandbox checks", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    const results = await runAllChecks({ repoRoot: dir });
    expect(results[0]?.id).toBe("environment");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("git");
    expect(ids).toContain("repository");
    expect(ids).toContain("github-auth");
    expect(ids.some((i) => i.startsWith("provider:"))).toBe(true);
    expect(ids.some((i) => i.startsWith("sandbox:"))).toBe(true);
  }, 60_000);

  it("honours the configured provider implementation", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    const results = await runAllChecks({ repoRoot: dir }, "claude");
    expect(results.some((r) => r.id === "provider:claude")).toBe(true);
  }, 60_000);

  it("probes an independently configured reviewer as well as the implementer", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    const results = await runAllChecks({ repoRoot: dir }, ["codex", "claude"]);
    expect(results.some((r) => r.id === "provider:codex")).toBe(true);
    expect(results.some((r) => r.id === "provider:claude")).toBe(true);
  }, 60_000);

  it("gives every check a unique id, so --check <id> is unambiguous", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    const ids = (await runAllChecks({ repoRoot: dir })).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);
});

describe("worstStatus", () => {
  it("is fail if anything failed", () => {
    expect(
      worstStatus([
        { id: "a", status: "pass", observed: "", expected: "" },
        { id: "b", status: "warn", observed: "", expected: "" },
        { id: "c", status: "fail", observed: "", expected: "" },
      ]),
    ).toBe("fail");
  });

  it("is warn when there are warnings but no failures", () => {
    expect(
      worstStatus([
        { id: "a", status: "pass", observed: "", expected: "" },
        { id: "b", status: "warn", observed: "", expected: "" },
      ]),
    ).toBe("warn");
  });

  it("is pass only when everything passed", () => {
    expect(worstStatus([{ id: "a", status: "pass", observed: "", expected: "" }])).toBe("pass");
  });

  it("is pass for an empty list, which callers must not treat as verified", () => {
    // `doctor --check <unknown>` once matched nothing and reported PASS, telling
    // a developer their setup was fine when nothing had been checked. The fix
    // lives in the CLI, which refuses an empty match; this documents that
    // worstStatus alone cannot carry that meaning.
    expect(worstStatus([])).toBe("pass");
  });
});

describe("a check that plants files cleans up after itself", () => {
  it("leaves no runmill-probe directories in tmp", async () => {
    // Guards against the probe leaking a directory per doctor invocation.
    const before = (await import("node:fs")).readdirSync(tmpdir()).filter((f) => f.startsWith("runmill-probe"));
    await checkSandbox();
    const after = (await import("node:fs")).readdirSync(tmpdir()).filter((f) => f.startsWith("runmill-probe"));
    expect(after.length).toBeLessThanOrEqual(before.length);
  }, 30_000);
});

describe("DoctorContext with a config path", () => {
  it("accepts an explicit config path without failing the repository check", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "runmill.yaml"), "version: 1\n");
    const r = await checkRepository({ repoRoot: dir, configPath: join(dir, "runmill.yaml") });
    expect(r.status).toBe("pass");
  });
});
