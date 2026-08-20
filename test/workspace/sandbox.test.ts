import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  Sandbox,
  buildEnvironment,
  buildSeatbeltProfile,
  buildBubblewrapArgs,
  detectMechanism,
  toolchainReadPaths,
  trustStoreReadPaths,
} from "../../src/workspace/sandbox.js";

/** realpath'd parent directory, matching what the profile actually grants. */
function dirOf(file: string): string {
  return realpathSync(dirname(file));
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runmill-toolchain-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Whether this host can construct a sandbox at all.
 *
 * These tests were gated to macOS, which meant the bubblewrap path — half the
 * supported platforms — had its enforcement verified by nothing, anywhere. The
 * assertions below are about behavior every mechanism must provide, so they run
 * wherever a mechanism exists.
 */
const hasSandbox = detectMechanism() !== "none";
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

  it("carries the TLS trust configuration this host actually uses", () => {
    // The agent has to reach its own API. On a machine with a custom CA bundle
    // or a TLS-inspecting proxy, dropping these makes every request fail as
    // "invalid peer certificate: UnknownIssuer" inside the sandbox while
    // working perfectly outside it -- which reads as "the agent is broken".
    const env = buildEnvironment(
      {},
      {
        PATH: "/usr/bin",
        SSL_CERT_FILE: "/etc/ssl/cert.pem",
        SSL_CERT_DIR: "/etc/ssl/certs",
        HTTPS_PROXY: "http://proxy:3128",
        NO_PROXY: "localhost",
      },
    );

    expect(env["SSL_CERT_FILE"]).toBe("/etc/ssl/cert.pem");
    expect(env["SSL_CERT_DIR"]).toBe("/etc/ssl/certs");
    expect(env["HTTPS_PROXY"]).toBe("http://proxy:3128");
    expect(env["NO_PROXY"]).toBe("localhost");
  });

  it("still refuses NODE_EXTRA_CA_CERTS", () => {
    // Distinct from SSL_CERT_FILE: this one adds a CA on top of the system
    // set rather than naming the trust configuration already in use.
    const env = buildEnvironment({}, { PATH: "/usr/bin", NODE_EXTRA_CA_CERTS: "/tmp/evil.pem" });

    expect(env["NODE_EXTRA_CA_CERTS"]).toBeUndefined();
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

  it("grants the real path of the symlinked system directories", () => {
    // /etc, /var and /tmp are symlinks into /private on macOS, and Seatbelt
    // matches on the resolved path. A `(subpath "/etc")` rule therefore grants
    // nothing at all: it names a symlink, not the directory the kernel checks.
    // The visible consequence was that /private/etc/ssl/cert.pem was denied, so
    // certificate validation failed and no agent could reach its API.
    const p = buildSeatbeltProfile({ writablePaths: ["/w"], allowNetwork: false }, "/Users/x");

    expect(p).toContain('(subpath "/private/etc")');
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

  it("binds the 64-bit library directory so dynamic binaries can find their loader", () => {
    // On x86-64 Linux the ELF interpreter is /lib64/ld-linux-x86-64.so.2. Without
    // it inside the namespace EVERY sandboxed exec dies at load time — agents and
    // check runs alike — with a bare exit 127/133 and no explanation.
    const args = buildBubblewrapArgs({ writablePaths: ["/w"], allowNetwork: false }, "/home/x");
    expect(args.join(" ")).toContain("/lib64 /lib64");
  });

  it("tolerates system directories a distribution does not have", () => {
    // /lib64 is absent on arm64, /sbin is merged away on some images. A plain
    // --ro-bind aborts the whole sandbox when the source is missing, so the
    // optional ones must use the -try form.
    const args = buildBubblewrapArgs({ writablePaths: ["/w"], allowNetwork: false }, "/home/x");
    const joined = args.join(" ");
    expect(joined).toContain("--ro-bind-try /lib64 /lib64");
  });

  it("lets a writable path win over a read-only grant for the same directory", () => {
    // bwrap applies mounts in order, so a --ro-bind emitted after the --bind
    // for the same target remounts it read-only. The workspace is now also
    // reachable through the toolchain grant (the agent binary can live inside
    // it), and when the read-only bind landed last the agent silently lost
    // write access to the very directory it was told to work in.
    const args = buildBubblewrapArgs(
      { writablePaths: ["/w"], readablePaths: ["/w"], allowNetwork: false },
      "/home/x",
    );
    const joined = args.join(" ");

    expect(joined.indexOf("--bind /w /w")).toBeGreaterThan(
      joined.indexOf("--ro-bind-try /w /w"),
    );
  });

  it("tolerates a provider config directory that is not installed", () => {
    // readablePaths carries ~/.codex and ~/.config/claude. A developer running
    // only one of the two providers does not have the other's directory, and a
    // hard --ro-bind on a missing source makes bwrap exit 1 before the agent
    // starts — which reads as "the agent failed", not "that path is absent".
    const args = buildBubblewrapArgs(
      { writablePaths: ["/w"], readablePaths: ["/home/x/.codex"], allowNetwork: false },
      "/home/x",
    );
    expect(args.join(" ")).toContain("--ro-bind-try /home/x/.codex /home/x/.codex");
  });
});

describe("trustStoreReadPaths", () => {
  it("grants the directory holding the bundle SSL_CERT_FILE names", () => {
    const bundle = join(dir, "certs", "ca.pem");
    mkdirSync(join(dir, "certs"), { recursive: true });
    writeFileSync(bundle, "-----BEGIN CERTIFICATE-----\n");

    expect(trustStoreReadPaths({ SSL_CERT_FILE: bundle })).toContain(
      realpathSync(join(dir, "certs")),
    );
  });

  it("grants SSL_CERT_DIR itself", () => {
    const certs = join(dir, "cadir");
    mkdirSync(certs, { recursive: true });

    expect(trustStoreReadPaths({ SSL_CERT_DIR: certs })).toContain(realpathSync(certs));
  });

  it("grants nothing when the environment names nothing", () => {
    expect(trustStoreReadPaths({})).toEqual([]);
  });

  it("grants nothing for a bundle that is not there", () => {
    expect(trustStoreReadPaths({ SSL_CERT_FILE: join(dir, "missing", "ca.pem") })).toEqual([]);
  });
});

describe("toolchainReadPaths", () => {
  /**
   * A sandboxed command has to be able to load itself.
   *
   * Every policy here denies by default and then grants /usr, /bin and friends,
   * which is enough only when the toolchain happens to live in a system prefix.
   * codex installed through bun lives at ~/.bun/bin, node through nvm lives at
   * ~/.nvm/versions/..., and pipx and cargo put theirs under ~/.local/bin. On
   * those machines the sandbox denied the binary itself, and the run failed in
   * milliseconds with no output, because the process never started.
   */
  it("includes the directories on PATH", () => {
    const paths = toolchainReadPaths("node", { PATH: `/usr/bin:${dirOf(process.execPath)}` });

    expect(paths).toContain(dirOf(process.execPath));
  });

  it("skips PATH entries that do not exist rather than granting them", () => {
    const paths = toolchainReadPaths("node", { PATH: "/usr/bin:/nope/not/here" });

    expect(paths).not.toContain("/nope/not/here");
  });

  it("ignores an empty PATH entry instead of granting the whole filesystem", () => {
    // A trailing or doubled colon means "the current directory" to some shells.
    // Turning that into a subpath grant would hand over everything.
    const paths = toolchainReadPaths("node", { PATH: "/usr/bin::" });

    expect(paths).not.toContain("");
    expect(paths).not.toContain(".");
  });

  it("follows a symlinked binary to the tree that actually holds it", () => {
    // ~/.bun/bin/codex is a symlink into ../install/global/node_modules/...,
    // so granting only the PATH directory grants a symlink pointing at a
    // directory the sandbox still denies.
    const pkg = join(dir, "install", "global", "node_modules", "demo", "bin");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "tool.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(join(pkg, "tool.js"), join(binDir, "tool"));

    const paths = toolchainReadPaths("tool", { PATH: binDir });

    // The package root, so sibling dependencies resolve too, not just the file.
    expect(paths).toContain(realpathSync(join(dir, "install", "global")));
  });

  it("follows every candidate on PATH, not just the first", () => {
    // Wrappers re-resolve through PATH: ~/.superset/bin/codex is a shell script
    // that searches PATH for the next codex and execs it. Granting only the
    // first match grants the wrapper and denies the program it runs, which
    // fails as an unreadable file rather than as a denied binary.
    const wrapperDir = join(dir, "wrapper");
    const realDir = join(dir, "real");
    const pkg = join(dir, "pkgroot", "node_modules", "demo", "bin");
    mkdirSync(wrapperDir, { recursive: true });
    mkdirSync(realDir, { recursive: true });
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(wrapperDir, "tool"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(pkg, "tool.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
    symlinkSync(join(pkg, "tool.js"), join(realDir, "tool"));

    const paths = toolchainReadPaths("tool", { PATH: `${wrapperDir}${delimiter}${realDir}` });

    expect(paths).toContain(realpathSync(join(dir, "pkgroot")));
  });

  it("grants the directory of a binary given as an absolute path", () => {
    const binDir = join(dir, "abs");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "tool"), "#!/bin/sh\n", { mode: 0o755 });

    const paths = toolchainReadPaths(join(binDir, "tool"), { PATH: "/usr/bin" });

    expect(paths).toContain(realpathSync(binDir));
  });

  it("returns no duplicates, so the profile stays readable", () => {
    const paths = toolchainReadPaths("node", { PATH: "/usr/bin:/usr/bin:/usr/bin" });

    expect(new Set(paths).size).toBe(paths.length);
  });

  it("survives a command that cannot be found at all", () => {
    expect(() => toolchainReadPaths("definitely-not-a-real-binary", { PATH: "/usr/bin" })).not.toThrow();
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

  it.runIf(onMac && hasSandbox)("can read the CA bundle, so TLS can verify a peer", async () => {
    // Not a proxy for "TLS works" -- this IS what failed. rustls and OpenSSL
    // both read /etc/ssl/cert.pem, which resolves to /private/etc, and the
    // profile granted only the symlink. Every agent request died as
    // "invalid peer certificate: UnknownIssuer".
    const ws = mkdtempSync(join(tmpdir(), "runmill-ca-"));
    try {
      const result = await new Sandbox(detectMechanism()).run({
        command: "/bin/cat",
        args: ["/etc/ssl/cert.pem"],
        cwd: ws,
        policy: { writablePaths: [ws], allowNetwork: false },
        timeoutMs: 20_000,
      });
      expect(result.stderr).not.toMatch(/not permitted/i);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("BEGIN CERTIFICATE");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(hasSandbox)(
    "runs a toolchain that lives outside the system prefixes",
    async () => {
      // The regression this encodes: agent CLIs and interpreters routinely live
      // under the user's home (bun, nvm, volta, pipx, ~/.local/bin). The policy
      // granted /usr and friends only, so the binary itself was denied and the
      // run died in milliseconds with an empty stderr -- indistinguishable from
      // an agent that simply failed.
      // Deliberately outside the workspace: a workspace grant would make the
      // binary readable for the wrong reason and the test would pass without
      // the toolchain grant it is here to cover.
      const toolDir = mkdtempSync(join(tmpdir(), "runmill-toolchain-bin-"));
      const workspace = mkdtempSync(join(tmpdir(), "runmill-toolchain-ws-"));
      const tool = join(toolDir, "hello-tool");
      writeFileSync(tool, "#!/bin/sh\necho toolchain-ran\n", { mode: 0o755 });

      const sandbox = new Sandbox(detectMechanism());
      let result;
      try {
        result = await sandbox.run({
          command: tool,
          args: [],
          cwd: workspace,
          policy: { writablePaths: [workspace], allowNetwork: false },
          timeoutMs: 20_000,
        });
      } finally {
        rmSync(toolDir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
      }

      expect(result.stderr).not.toMatch(/not permitted|Operation not permitted/i);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("toolchain-ran");
    },
    30_000,
  );

  it.runIf(hasSandbox)("runs a permitted command and captures output", async () => {
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

  it.runIf(hasSandbox)("permits writes inside the workspace", async () => {
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

  it.runIf(hasSandbox)("DENIES reading a credential path", async () => {
    // The security claim, tested rather than asserted — and tested in a way
    // that cannot pass for the wrong reason.
    //
    // This read `~/.ssh/id_rsa` directly, so on any machine without that file
    // `cat` failed because the file was absent and the test passed having
    // proven nothing about the sandbox. It now plants a real secret at a real
    // credential path, proves it is readable OUTSIDE the sandbox, and only then
    // asserts the denial inside.
    //
    // HOME is redirected to a temp directory first: the denial rules are built
    // from $HOME, and writing to a developer's actual ~/.ssh to run a test is
    // not a trade worth making.
    const dir = mkdtempSync(join(tmpdir(), "runmill-sbx-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "runmill-home-"));
    const realHome = process.env["HOME"];
    const secret = join(fakeHome, ".ssh", "id_rsa");

    try {
      mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
      writeFileSync(secret, "PRIVATE-KEY-MATERIAL\n");
      process.env["HOME"] = fakeHome;

      // Non-vacuity: unsandboxed, this read succeeds.
      expect(readFileSync(secret, "utf8")).toContain("PRIVATE-KEY-MATERIAL");

      const sandbox = new Sandbox(detectMechanism());
      const result = await sandbox.run({
        command: "/bin/cat",
        args: [secret],
        cwd: dir,
        policy: { writablePaths: [dir], allowNetwork: false },
        timeoutMs: 10_000,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("PRIVATE-KEY-MATERIAL");
    } finally {
      if (realHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = realHome;
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it.runIf(hasSandbox)("DENIES writing outside the declared workspace", async () => {
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

  it.runIf(hasSandbox)("kills the whole process group on timeout", async () => {
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
