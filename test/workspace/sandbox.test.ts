import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, platform, homedir } from "node:os";
import { join } from "node:path";
import {
  Sandbox,
  buildEnvironment,
  buildSeatbeltProfile,
  buildBubblewrapArgs,
  detectMechanism,
} from "../../src/workspace/sandbox.js";

const onMac = platform() === "darwin";

describe("buildEnvironment", () => {
  it("builds from empty rather than filtering the parent", () => {
    const env = buildEnvironment({}, { PATH: "/usr/bin", SOMETHING_CUSTOM: "leak" });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["SOMETHING_CUSTOM"]).toBeUndefined();
  });

  it("drops credential variables even if the parent has them", () => {
    const env = buildEnvironment(
      {},
      { PATH: "/usr/bin", GH_TOKEN: "ghp_x", AWS_SECRET_ACCESS_KEY: "s", ANTHROPIC_API_KEY: "k" },
    );
    expect(env["GH_TOKEN"]).toBeUndefined();
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("drops code-injection variables that are not obviously credentials", () => {
    // NODE_OPTIONS force-loads a script into every node process, including the
    // check runner. It is the least obvious and most dangerous of these.
    const env = buildEnvironment(
      {},
      {
        PATH: "/usr/bin",
        NODE_OPTIONS: "--require /tmp/evil.js",
        LD_PRELOAD: "/tmp/evil.so",
        DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
        BASH_ENV: "/tmp/evil.sh",
        PYTHONSTARTUP: "/tmp/evil.py",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
      },
    );
    for (const key of [
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "BASH_ENV",
      "PYTHONSTARTUP",
      "SSH_AUTH_SOCK",
    ]) {
      expect(env[key], `${key} must not survive`).toBeUndefined();
    }
  });

  it("refuses an explicitly passed denylisted variable", () => {
    const env = buildEnvironment({ NODE_OPTIONS: "--require /tmp/evil.js" }, { PATH: "/usr/bin" });
    expect(env["NODE_OPTIONS"]).toBeUndefined();
  });

  it("passes through additions that are not dangerous", () => {
    const env = buildEnvironment({ RUNMILL_RUN_ID: "run_1" }, { PATH: "/usr/bin" });
    expect(env["RUNMILL_RUN_ID"]).toBe("run_1");
  });
});

describe("buildSeatbeltProfile", () => {
  it("denies by default", () => {
    const p = buildSeatbeltProfile({ writablePaths: ["/w"], allowNetwork: false }, "/Users/x");
    expect(p).toContain("(deny default)");
  });

  it("grants writes only to declared paths", () => {
    const p = buildSeatbeltProfile({ writablePaths: ["/w"], allowNetwork: false }, "/Users/x");
    expect(p).toContain('file-write* (subpath "/w")');
  });

  it("denies credential directories after any broader grant", () => {
    const p = buildSeatbeltProfile({ writablePaths: ["/w"], allowNetwork: false }, "/Users/x");
    const denySsh = p.indexOf('(deny file-read* file-write* (subpath "/Users/x/.ssh")');
    const allowW = p.indexOf('file-write* (subpath "/w")');
    expect(denySsh).toBeGreaterThan(allowW);
    expect(p).toContain('/Users/x/.aws');
    expect(p).toContain('/Users/x/.config/gh');
  });

  it("blocks the keychain as a Mach service, not as a file", () => {
    const p = buildSeatbeltProfile({ writablePaths: ["/w"], allowNetwork: false }, "/Users/x");
    expect(p).toContain('(deny mach-lookup (global-name "com.apple.SecurityServer"))');
  });

  it("omits network unless explicitly allowed", () => {
    const closed = buildSeatbeltProfile({ writablePaths: ["/w"], allowNetwork: false }, "/h");
    const open = buildSeatbeltProfile({ writablePaths: ["/w"], allowNetwork: true }, "/h");
    expect(closed).not.toContain("network-outbound");
    expect(open).toContain("(allow network-outbound)");
  });
});

describe("buildBubblewrapArgs", () => {
  it("unshares the network namespace when network is denied", () => {
    const args = buildBubblewrapArgs({ writablePaths: ["/w"], allowNetwork: false }, "/home/x");
    expect(args).toContain("--unshare-net");
  });

  it("binds declared writable paths and masks credential directories", () => {
    const args = buildBubblewrapArgs({ writablePaths: ["/w"], allowNetwork: false }, "/home/x");
    expect(args.join(" ")).toContain("--bind /w /w");
    expect(args.join(" ")).toContain("--tmpfs /home/x/.ssh");
  });

  it("dies with the parent so an orphaned agent cannot outlive the run", () => {
    const args = buildBubblewrapArgs({ writablePaths: ["/w"], allowNetwork: false }, "/home/x");
    expect(args).toContain("--die-with-parent");
  });
});

describe("Sandbox.run", () => {
  it("refuses to run when no mechanism is available", async () => {
    const sandbox = new Sandbox("none");
    await expect(
      sandbox.run({
        command: "/bin/echo",
        args: ["hi"],
        cwd: tmpdir(),
        policy: { writablePaths: [], allowNetwork: false },
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/RM-SANDBOX-001|No sandbox mechanism/);
  });

  it.runIf(onMac)("runs a permitted command and captures output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runmill-sbx-"));
    const sandbox = new Sandbox(detectMechanism());
    const result = await sandbox.run({
      command: "/bin/echo",
      args: ["hello"],
      cwd: dir,
      policy: { writablePaths: [dir], allowNetwork: false },
      timeoutMs: 10_000,
    });
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(onMac)("permits writes inside the workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runmill-sbx-"));
    const sandbox = new Sandbox(detectMechanism());
    const target = join(dir, "written.txt");
    const result = await sandbox.run({
      command: "/usr/bin/tee",
      args: [target],
      cwd: dir,
      policy: { writablePaths: [dir], allowNetwork: false },
      timeoutMs: 10_000,
    });
    expect(result.outcome).toBe("exited");
    expect(existsSync(target)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(onMac)("DENIES reading a credential path", async () => {
    // The security claim, tested rather than asserted.
    const dir = mkdtempSync(join(tmpdir(), "runmill-sbx-"));
    const sandbox = new Sandbox(detectMechanism());
    const result = await sandbox.run({
      command: "/bin/cat",
      args: [join(homedir(), ".ssh", "id_rsa")],
      cwd: dir,
      policy: { writablePaths: [dir], allowNetwork: false },
      timeoutMs: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(onMac)("DENIES writing outside the declared workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runmill-sbx-"));
    const outside = mkdtempSync(join(tmpdir(), "runmill-outside-"));
    const sandbox = new Sandbox(detectMechanism());
    const result = await sandbox.run({
      command: "/usr/bin/tee",
      args: [join(outside, "escaped.txt")],
      cwd: dir,
      policy: { writablePaths: [dir], allowNetwork: false },
      timeoutMs: 10_000,
    });
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
    expect(result.exitCode).not.toBe(0);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it.runIf(onMac)("kills the whole process group on timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runmill-sbx-"));
    writeFileSync(join(dir, "slow.sh"), "#!/bin/sh\nsleep 30\n");
    const sandbox = new Sandbox(detectMechanism());
    const result = await sandbox.run({
      command: "/bin/sh",
      args: [join(dir, "slow.sh")],
      cwd: dir,
      policy: { writablePaths: [dir], allowNetwork: false },
      timeoutMs: 1_000,
    });
    expect(result.outcome).toBe("timeout");
    expect(result.durationMs).toBeLessThan(10_000);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});
