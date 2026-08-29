import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  buildEnvironment,
  buildSeatbeltProfile,
  buildBubblewrapArgs,
  detectMechanism,
  trustStoreReadPaths,
  createNativeSandboxBackend,
} from "../../src/workspace/sandbox.js";

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

  it("drops credential-bearing proxy URLs but keeps credential-free proxies", () => {
    const env = buildEnvironment(
      {},
      {
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://operator:secret@proxy.internal:3128",
        HTTP_PROXY: "http://proxy.internal:3128",
      },
    );

    expect(env["HTTPS_PROXY"]).toBeUndefined();
    expect(env["HTTP_PROXY"]).toBe("http://proxy.internal:3128");
  });

  it("also strips a credential-bearing proxy passed as an explicit extra", () => {
    const env = buildEnvironment(
      { ALL_PROXY: "socks5://name:password@proxy.internal:1080" },
      { PATH: "/usr/bin" },
    );
    expect(env["ALL_PROXY"]).toBeUndefined();
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

describe("explicit backend selection", () => {
  it("represents none as a non-executing backend instead of falling back", async () => {
    const backend = createNativeSandboxBackend("none");
    expect(backend.mechanism).toBe("none");
    await expect(
      backend.run({
        command: "/usr/bin/true",
        args: [],
        cwd: dir,
        policy: { writablePaths: [], allowNetwork: false },
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "RM-SANDBOX-001" });
  });

  it.runIf(platform() === "linux")(
    "requires bubblewrap and denies a planted outside resource with the real mechanism",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "runmill-bwrap-workspace-"));
      const outside = mkdtempSync(join(tmpdir(), "runmill-bwrap-outside-"));
      const allowed = join(workspace, "allowed.txt");
      const secret = join(outside, "secret.txt");
      writeFileSync(allowed, "allowed\n");
      writeFileSync(secret, "planted-secret\n");
      expect(readFileSync(secret, "utf8")).toContain("planted-secret");
      try {
        const backend = createNativeSandboxBackend("native");
        expect(backend.mechanism).toBe("bubblewrap");
        const permitted = await backend.run({
          command: "/bin/cat",
          args: [allowed],
          cwd: workspace,
          policy: { writablePaths: [workspace], allowNetwork: false },
          timeoutMs: 10_000,
        });
        expect(permitted).toMatchObject({ outcome: "exited", exitCode: 0 });
        expect(permitted.stdout).toContain("allowed");

        const denied = await backend.run({
          command: "/bin/cat",
          args: [secret],
          cwd: workspace,
          policy: { writablePaths: [workspace], allowNetwork: false },
          timeoutMs: 10_000,
        });
        expect(denied.exitCode).not.toBe(0);
        expect(denied.stdout).not.toContain("planted-secret");
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("buildSeatbeltProfile", () => {
  it("denies by default", () => {
    const p = buildSeatbeltProfile({ writablePaths: ["/w"], allowNetwork: false }, "/Users/x");
    expect(p).toContain("(deny default)");
    expect(p).not.toContain("(allow process-exec)");
  });

  it("grants writes only to declared paths", () => {
    const p = buildSeatbeltProfile({ writablePaths: ["/w"], allowNetwork: false }, "/Users/x");
    expect(p).toContain('file-write* (subpath "/w")');
  });

  it("can grant one pre-created output file without granting its parent", () => {
    const p = buildSeatbeltProfile(
      { writablePaths: [], writableFiles: ["/w/review.json"], allowNetwork: false },
      "/Users/x",
    );
    expect(p).toContain('(allow file-read* file-write* (literal "/w/review.json"))');
    expect(p).not.toContain('(allow file-read* file-write* (subpath "/w"))');
  });

  it("denies writes to protected metadata after granting its writable parent", () => {
    const p = buildSeatbeltProfile(
      { writablePaths: ["/w"], protectedPaths: ["/w/.git"], allowNetwork: false },
      "/Users/x",
    );
    const grant = p.indexOf('(allow file-read* file-write* (subpath "/w"))');
    const protect = p.indexOf(
      '(deny file-write* (literal "/w/.git") (subpath "/w/.git"))',
    );
    expect(protect).toBeGreaterThan(grant);
  });

  it("denies credential directories after any broader grant", () => {
    const p = buildSeatbeltProfile({ writablePaths: ["/w"], allowNetwork: false }, "/Users/x");
    const denySsh = p.indexOf('(deny file-read* file-write* (subpath "/Users/x/.ssh")');
    const allowW = p.indexOf('file-write* (subpath "/w")');
    expect(denySsh).toBeGreaterThan(allowW);
    expect(p).toContain('/Users/x/.aws');
    expect(p).toContain('/Users/x/.config/gh');
    expect(p).toContain('/Users/x/.codex');
    expect(p).toContain('/Users/x/.claude');
    expect(p).toContain('/Users/x/.config/claude');
  });

  it("grants the real path of the symlinked system directories", () => {
    // /etc, /var and /tmp are symlinks into /private on macOS, and Seatbelt
    // matches on the resolved path. A `(subpath "/etc")` rule therefore grants
    // nothing at all: it names a symlink, not the directory the kernel checks.
    // The visible consequence was that /private/etc/ssl/cert.pem was denied, so
    // certificate validation failed and no agent could reach its API.
    const p = buildSeatbeltProfile({ writablePaths: ["/w"], allowNetwork: false }, "/Users/x");

    expect(p).toContain('(subpath "/private/etc/ssl")');
    expect(p).not.toContain('(subpath "/private/etc")');
    expect(p).not.toContain('(subpath "/Library")');
    expect(p).not.toContain('(subpath "/opt")');
  });

  it("grants the timezone database, which every local clock reads", () => {
    // /etc/localtime is a symlink into /private/var/db/timezone. Without it a
    // process that formats a local time fails, and some runtimes die outright:
    // the Claude CLI exits with a bare "internal error (EPERM)" and no clue.
    const p = buildSeatbeltProfile({ writablePaths: ["/w"], allowNetwork: false }, "/Users/x");

    expect(p).toContain('(subpath "/private/var/db/timezone")');
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
  it("binds only required qualified paths and never ambient system trees", () => {
    const args = buildBubblewrapArgs(
      {
        writablePaths: ["/w"],
        readablePaths: ["/runtime/tool", "/runtime/lib.so"],
        allowNetwork: false,
      },
      "/home/x",
    );
    const joined = args.join(" ");
    expect(joined).toContain("--ro-bind /runtime/tool /runtime/tool");
    expect(joined).toContain("--ro-bind /runtime/lib.so /runtime/lib.so");
    expect(joined).not.toContain("--ro-bind-try");
    expect(joined).not.toContain("--ro-bind /usr /usr");
    expect(joined).not.toContain("--ro-bind /etc /etc");
  });

  it("unshares the network namespace when network is denied", () => {
    const args = buildBubblewrapArgs({ writablePaths: ["/w"], allowNetwork: false }, "/home/x");
    expect(args).toContain("--unshare-net");
  });

  it("binds declared writable paths without materializing ambient home paths", () => {
    const args = buildBubblewrapArgs({ writablePaths: ["/w"], allowNetwork: false }, "/home/x");
    const joined = args.join(" ");
    expect(joined).toContain("--bind /w /w");
    expect(joined).not.toContain("/home/x");
  });

  it("dies with the parent so an orphaned agent cannot outlive the run", () => {
    const args = buildBubblewrapArgs({ writablePaths: ["/w"], allowNetwork: false }, "/home/x");
    expect(args).toContain("--die-with-parent");
  });

  it("does not bind ambient library or executable directories", () => {
    const joined = buildBubblewrapArgs(
      { writablePaths: ["/w"], allowNetwork: false },
      "/home/x",
    ).join(" ");
    expect(joined).not.toMatch(/\/(?:usr|bin|sbin|lib64?) \//);
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
      joined.indexOf("--ro-bind /w /w"),
    );
  });

  it("remounts protected metadata read-only after its writable parent", () => {
    const args = buildBubblewrapArgs(
      { writablePaths: ["/w"], protectedPaths: ["/w/.git"], allowNetwork: false },
      "/home/x",
    );
    const joined = args.join(" ");
    expect(joined).toContain("--ro-bind /w/.git /w/.git");
    expect(joined).not.toContain("--ro-bind-try /w/.git /w/.git");
    expect(joined.indexOf("--ro-bind /w/.git /w/.git")).toBeGreaterThan(
      joined.indexOf("--bind /w /w"),
    );
  });

  it("binds one writable output file after its read-only workspace", () => {
    const args = buildBubblewrapArgs(
      {
        writablePaths: [],
        writableFiles: ["/w/review.json"],
        readablePaths: ["/w"],
        allowNetwork: false,
      },
      "/home/x",
    );
    const joined = args.join(" ");
    expect(joined).toContain("--bind /w/review.json /w/review.json");
    expect(joined.indexOf("--bind /w/review.json /w/review.json")).toBeGreaterThan(
      joined.indexOf("--ro-bind /w /w"),
    );
    expect(joined).not.toContain("--bind /w /w");
  });

  it("treats every qualified provider path as required at launch", () => {
    const args = buildBubblewrapArgs(
      { writablePaths: ["/w"], readablePaths: ["/home/x/.codex"], allowNetwork: false },
      "/home/x",
    );
    expect(args.join(" ")).toContain("--ro-bind /home/x/.codex /home/x/.codex");
    expect(args).not.toContain("--ro-bind-try");
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

describe("Sandbox.run", () => {
  it("resolves one exact PATH executable and sanitizes PATH to closure shims", async () => {
    const firstBin = join(dir, "first-bin");
    const secondBin = join(dir, "second-bin");
    mkdirSync(firstBin);
    mkdirSync(secondBin);
    writeFileSync(join(firstBin, "tool"), "#!/bin/sh\nprintf exact\n", { mode: 0o755 });
    writeFileSync(join(secondBin, "tool"), "#!/bin/sh\nprintf ambient\n", { mode: 0o755 });
    writeFileSync(join(firstBin, "ambient-sibling"), "#!/bin/sh\nprintf leaked\n", {
      mode: 0o755,
    });

    const backend = createNativeSandboxBackend("native", {
      platform: platform(),
      path: `${firstBin}${delimiter}${secondBin}:/bin:/usr/bin`,
    });
    const qualification = await backend.qualify({ command: "tool", subprocesses: [] });

    expect(qualification.executable.path).toBe(realpathSync(join(firstBin, "tool")));
    expect(qualification.executable.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(qualification.executableIdentities.map((entry) => entry.path)).not.toContain(
      realpathSync(join(secondBin, "tool")),
    );
    expect(qualification.sanitizedPath.split(delimiter)).not.toContain(firstBin);
    expect(qualification.sanitizedPath.split(delimiter)).not.toContain(secondBin);
  });

  it("refuses root, home, and workspace-ancestor grants before spawning", async () => {
    const workspace = join(dir, "workspace", "nested");
    mkdirSync(workspace, { recursive: true });
    const backend = createNativeSandboxBackend("native", {
      platform: platform(),
      path: "/bin:/usr/bin",
    });

    for (const readablePath of ["/", dirname(workspace), process.env["HOME"]].filter(
      (value): value is string => value !== undefined,
    )) {
      await expect(
        backend.run({
          command: "/usr/bin/true",
          args: [],
          cwd: workspace,
          policy: { writablePaths: [], readablePaths: [readablePath], allowNetwork: false },
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow(/over-broad|ancestor|home|RM-SANDBOX-001/i);
    }
  });

  it("rejects duplicate and conflicting guest mounts", async () => {
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const backend = createNativeSandboxBackend("native", {
      platform: platform(),
      path: "/bin:/usr/bin",
    });

    await expect(
      backend.run({
        command: "/usr/bin/true",
        args: [],
        cwd: workspace,
        policy: {
          writablePaths: [workspace],
          readablePaths: [workspace],
          allowNetwork: false,
        },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/duplicate|conflicting|overlap|RM-SANDBOX-001/i);

    const nested = join(workspace, "nested");
    mkdirSync(nested);
    await expect(
      backend.run({
        command: "/usr/bin/true",
        args: [],
        cwd: workspace,
        policy: {
          writablePaths: [workspace, nested],
          allowNetwork: false,
        },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/overlap|RM-SANDBOX-001/i);
  });

  it("refuses an over-broad configured trust root", async () => {
    const workspace = join(dir, "trust-workspace");
    mkdirSync(workspace);
    const backend = createNativeSandboxBackend("native");
    await expect(
      backend.run({
        command: "/usr/bin/true",
        args: [],
        cwd: workspace,
        env: { SSL_CERT_DIR: "/" },
        policy: { writablePaths: [workspace], allowNetwork: false },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/over-broad|trust|RM-SANDBOX-001/i);
  });

  it.runIf(onMac)(
    "starts an installed-style Node CLI while denying PATH and package siblings with real Seatbelt",
    async () => {
      const installRoot = join(dir, "install");
      const packageRoot = join(installRoot, "node_modules", "demo-cli");
      const siblingRoot = join(installRoot, "node_modules", "ambient-package");
      const bin = join(installRoot, "bin");
      const workspace = join(dir, "workspace");
      mkdirSync(join(packageRoot, "bin"), { recursive: true });
      mkdirSync(siblingRoot, { recursive: true });
      mkdirSync(bin, { recursive: true });
      mkdirSync(workspace);
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "demo-cli" }));
      writeFileSync(join(packageRoot, "payload.txt"), "PACKAGE_OK\n");
      const secret = join(siblingRoot, "secret.txt");
      writeFileSync(secret, "PACKAGE_SECRET\n");
      const cli = join(packageRoot, "bin", "demo.js");
      writeFileSync(
        cli,
        "#!/usr/bin/env node\n" +
          "const fs=require('node:fs');const path=require('node:path');" +
          "process.stdout.write(fs.readFileSync(path.join(__dirname,'..','payload.txt'),'utf8'));" +
          "try{process.stdout.write(fs.readFileSync(process.argv[2],'utf8'))}" +
          "catch{process.stdout.write('SIBLING_DENIED\\n')}\n",
        { mode: 0o755 },
      );
      symlinkSync(cli, join(bin, "demo-cli"));
      writeFileSync(join(bin, "ambient-tool"), "#!/bin/sh\nprintf AMBIENT_TOOL\n", {
        mode: 0o755,
      });

      // Positive controls: both planted resources are readable outside Seatbelt.
      expect(readFileSync(join(packageRoot, "payload.txt"), "utf8")).toContain("PACKAGE_OK");
      expect(readFileSync(secret, "utf8")).toContain("PACKAGE_SECRET");

      const backend = createNativeSandboxBackend("native", {
        platform: "darwin",
        path: `${bin}${delimiter}${dirname(process.execPath)}:/usr/bin:/bin`,
      });
      const result = await backend.run({
        command: "demo-cli",
        args: [secret],
        cwd: workspace,
        policy: { writablePaths: [workspace], allowNetwork: false },
        timeoutMs: 20_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("PACKAGE_OK");
      expect(result.stdout).toContain("SIBLING_DENIED");
      expect(result.stdout).not.toContain("PACKAGE_SECRET");
    },
    30_000,
  );

  it.runIf(onMac)("starts npm verification through the exact runtime closure", async () => {
    const workspace = join(dir, "npm-verifier");
    mkdirSync(workspace);
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({
        private: true,
        scripts: { verify: "node -e \"process.stdout.write('NPM_VERIFY_OK')\"" },
      }),
    );
    const backend = createNativeSandboxBackend("native");
    const result = await backend.run({
      command: "npm",
      args: ["run", "verify"],
      cwd: workspace,
      subprocesses: ["/bin/sh"],
      policy: { writablePaths: [], readablePaths: [workspace], allowNetwork: false },
      timeoutMs: 20_000,
    });

    expect(result).toMatchObject({ outcome: "exited", exitCode: 0 });
    expect(result.stdout).toContain("NPM_VERIFY_OK");
  }, 30_000);

  it.runIf(onMac)("awaits an idempotent abort through the backend lifecycle", async () => {
    const workspace = join(dir, "abort-workspace");
    mkdirSync(workspace);
    const backend = createNativeSandboxBackend("native", {
      platform: "darwin",
      path: "/bin:/usr/bin",
    });
    const execution = await backend.start({
      command: "/bin/sh",
      args: ["-c", "trap '' TERM; sleep 30"],
      cwd: workspace,
      policy: { writablePaths: [workspace], allowNetwork: false },
      timeoutMs: 20_000,
    });

    await Promise.all([execution.abort(), execution.abort()]);
    const result = await execution.result;
    expect(result.outcome).toBe("aborted");
    expect(result.durationMs).toBeLessThan(10_000);
  }, 20_000);

  it("cleans prepared runtime directories when backend launch qualification fails", async () => {
    const isolatedTmp = join(dir, "isolated-tmp");
    const workspace = join(isolatedTmp, "workspace");
    const bin = join(workspace, "opaque-tool");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(bin, "not-an-elf-or-script", { mode: 0o755 });
    const previousTmp = process.env["TMPDIR"];
    process.env["TMPDIR"] = isolatedTmp;
    try {
      const backend = createNativeSandboxBackend("native", {
        platform: "linux",
        path: workspace,
      });
      await expect(
        backend.start({
          command: bin,
          args: [],
          cwd: workspace,
          policy: { writablePaths: [workspace], allowNetwork: false },
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow(/bwrap|sandbox/i);
      expect(
        readdirSync(isolatedTmp).filter((name) => name.startsWith("runmill-")),
      ).toEqual([]);
    } finally {
      if (previousTmp === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTmp;
    }
  });

  it("refuses to run when no mechanism is available", async () => {
    const sandbox = createNativeSandboxBackend("none");
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

  it("refuses a missing writable file instead of granting its parent directory", async () => {
    const sandbox = createNativeSandboxBackend("native");
    await expect(sandbox.start({
        command: "/usr/bin/true",
        args: [],
        cwd: tmpdir(),
        policy: {
          writablePaths: [],
          writableFiles: [join(dir, "missing", "review.json")],
          allowNetwork: false,
        },
        timeoutMs: 1_000,
      })).rejects.toThrow(/writable sandbox file|does not exist|RM-SANDBOX-001/i);
  });

  it.runIf(hasSandbox)("does not expose a provider API key to tool subprocesses", async () => {
    const ws = mkdtempSync(join(tmpdir(), "runmill-cred-"));
    try {
      const result = await createNativeSandboxBackend("native").run({
        command: "/bin/sh",
        args: ["-c", 'printf "%s" "${ANTHROPIC_API_KEY:-absent}"'],
        cwd: ws,
        policy: { writablePaths: [ws], allowNetwork: false },
        timeoutMs: 20_000,
        env: { ANTHROPIC_API_KEY: "sk-test-value" },
      });
      expect(result.stdout.trim()).toBe("absent");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(hasSandbox)("still strips that same variable when nobody hands it over", async () => {
    // Inheriting it from the parent is exactly what the denylist is for. Only
    // an explicit hand-off survives.
    const ws = mkdtempSync(join(tmpdir(), "runmill-cred2-"));
    try {
      const result = await createNativeSandboxBackend("native").run({
        command: "/bin/sh",
        args: ["-c", 'printf "%s" "${ANTHROPIC_API_KEY:-absent}"'],
        cwd: ws,
        policy: { writablePaths: [ws], allowNetwork: false },
        timeoutMs: 20_000,
        env: { ANTHROPIC_API_KEY: "leaked" },
      });
      expect(result.stdout.trim()).toBe("absent");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(hasSandbox)("can write to the temporary directory it was handed", async () => {
    // TMPDIR is on the environment allowlist, so the child is TOLD where its
    // temp directory is and was then denied access to it. Node, npm, compilers
    // and the agent CLIs all write there; the Claude CLI could not start at all.
    const ws = mkdtempSync(join(tmpdir(), "runmill-tmp-"));
    try {
      const result = await createNativeSandboxBackend("native").run({
        command: "/bin/sh",
        args: ["-c", 'printf ok > "$TMPDIR/runmill-probe" && cat "$TMPDIR/runmill-probe"'],
        subprocesses: ["/bin/cat"],
        cwd: ws,
        policy: { writablePaths: [ws], allowNetwork: false },
        timeoutMs: 20_000,
      });
      expect(result.stderr).not.toMatch(/not permitted|denied/i);
      expect(result.stdout.trim()).toBe("ok");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(hasSandbox)("can read the local timezone", async () => {
    const ws = mkdtempSync(join(tmpdir(), "runmill-tz-"));
    try {
      const result = await createNativeSandboxBackend("native").run({
        command: "/bin/sh",
        args: ["-c", "date +%Z"],
        subprocesses: ["/bin/date"],
        cwd: ws,
        policy: { writablePaths: [ws], allowNetwork: false },
        timeoutMs: 20_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).not.toBe("");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(onMac && hasSandbox)("can read the CA bundle, so TLS can verify a peer", async () => {
    // Not a proxy for "TLS works" -- this IS what failed. rustls and OpenSSL
    // both read /etc/ssl/cert.pem, which resolves to /private/etc, and the
    // profile granted only the symlink. Every agent request died as
    // "invalid peer certificate: UnknownIssuer".
    const ws = mkdtempSync(join(tmpdir(), "runmill-ca-"));
    try {
      const result = await createNativeSandboxBackend("native").run({
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

      const sandbox = createNativeSandboxBackend("native");
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
    const sandbox = createNativeSandboxBackend("native");
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
    const sandbox = createNativeSandboxBackend("native");
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

  it.runIf(hasSandbox)(
    "permits normal edits but DENIES writes to planted Git config and hooks",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "runmill-git-boundary-"));
      const gitDir = join(workspace, ".git");
      const config = join(gitDir, "config");
      const hook = join(gitDir, "hooks", "pre-commit");
      mkdirSync(join(gitDir, "hooks"), { recursive: true });
      writeFileSync(config, "[core]\n\trepositoryformatversion = 0\n");
      writeFileSync(hook, "#!/bin/sh\nexit 0\n");

      try {
        // Non-vacuity: these are ordinary writable files outside the sandbox.
        const originalConfig = readFileSync(config, "utf8");
        writeFileSync(config, `${originalConfig}# outside-write-worked\n`);
        expect(readFileSync(config, "utf8")).toContain("outside-write-worked");
        writeFileSync(config, originalConfig);

        const result = await createNativeSandboxBackend("native").run({
          command: "/bin/sh",
          args: [
            "-c",
            "printf normal > normal.txt; " +
              "printf pwn >> .git/config; printf '# pwn' >> .git/hooks/pre-commit",
          ],
          cwd: workspace,
          policy: {
            writablePaths: [workspace],
            protectedPaths: [gitDir],
            allowNetwork: false,
          },
          timeoutMs: 20_000,
        });

        expect(readFileSync(join(workspace, "normal.txt"), "utf8")).toBe("normal");
        expect(readFileSync(config, "utf8")).toBe(originalConfig);
        expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\nexit 0\n");
        expect(result.exitCode).not.toBe(0);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.runIf(hasSandbox)("DENIES rewriting a linked-checkout .git pointer file", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "runmill-git-pointer-"));
    const dotGit = join(workspace, ".git");
    const original = "gitdir: /outside/worktrees/check\n";
    writeFileSync(dotGit, original);
    try {
      // Non-vacuity: the pointer is writable without the sandbox.
      writeFileSync(dotGit, `${original}# outside-write-worked\n`);
      expect(readFileSync(dotGit, "utf8")).toContain("outside-write-worked");
      writeFileSync(dotGit, original);

      const result = await createNativeSandboxBackend("native").run({
        command: "/bin/sh",
        args: ["-c", "printf normal > normal.txt; printf pwn >> .git"],
        cwd: workspace,
        policy: {
          writablePaths: [workspace],
          protectedPaths: [dotGit],
          allowNetwork: false,
        },
        timeoutMs: 20_000,
      });

      expect(readFileSync(join(workspace, "normal.txt"), "utf8")).toBe("normal");
      expect(readFileSync(dotGit, "utf8")).toBe(original);
      expect(result.exitCode).not.toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(hasSandbox)("refuses a missing protective mount instead of silently dropping it", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "runmill-missing-protection-"));
    try {
      await expect(
        createNativeSandboxBackend("native").start({
          command: "/usr/bin/true",
          args: [],
          cwd: workspace,
          policy: {
            writablePaths: [workspace],
            protectedPaths: [join(workspace, ".git")],
            allowNetwork: false,
          },
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({
          whatHappened: expect.stringMatching(/protective mount|does not exist/i),
        });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
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

      const sandbox = createNativeSandboxBackend("native");
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
    const sandbox = createNativeSandboxBackend("native");
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
    const sandbox = createNativeSandboxBackend("native");
    const result = await sandbox.run({
      command: "/bin/sh",
      args: [join(dir, "slow.sh")],
      subprocesses: ["/bin/sleep"],
      cwd: dir,
      policy: { writablePaths: [dir], allowNetwork: false },
      timeoutMs: 1_000,
    });
    expect(result.outcome).toBe("timeout");
    expect(result.durationMs).toBeLessThan(10_000);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});
