import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialFreeSandboxExecution } from "../../src/agent/tool-gateway.js";
import { runControlledProcess } from "../../src/platform/process.js";
import { FakeClock } from "../../src/testing/fake-clock.js";
import {
  AsfBubblewrapProductionSandbox,
  buildAsfBubblewrapArgs,
  buildAsfPrlimitArgs,
  proveAsfWorkspaceCandidate,
} from "../../src/workspace/asf-bubblewrap.js";

const directories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"],
      LANG: "C",
      HOME: join(cwd, ".test-home"),
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

function repository(parent = temporaryDirectory("runmill-asf-bwrap-repo-")): {
  readonly parent: string;
  readonly workspace: string;
  readonly candidate: string;
} {
  const workspace = join(parent, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  git(workspace, "init", "-q", "-b", "main", ".");
  git(workspace, "config", "user.name", "ASF Test");
  git(workspace, "config", "user.email", "asf@example.test");
  mkdirSync(join(workspace, ".runmill", "run"), { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, ".runmill", "run", "task.json"), "{}\n");
  writeFileSync(join(workspace, "README.md"), "candidate bytes\n");
  git(workspace, "add", "README.md", ".runmill/run/task.json");
  git(workspace, "commit", "-q", "-m", "candidate");
  return { parent, workspace, candidate: git(workspace, "rev-parse", "HEAD") };
}

describe("buildAsfBubblewrapArgs", () => {
  it("uses mandatory namespaces and no downgrade-capable isolation flags", () => {
    const args = buildAsfBubblewrapArgs({
      workspaceRoot: "/private/runmill/workspaces/run-1",
      writableWorkspace: true,
      protectedPaths: [
        "/private/runmill/workspaces/run-1/.git",
        "/private/runmill/workspaces/run-1/.runmill",
      ],
      environment: { PATH: "/usr/bin:/bin", LANG: "C" },
      command: "/usr/bin/sed",
      args: ["-n", "1p", "README.md"],
    });
    const joined = args.join(" ");

    for (const control of [
      "--unshare-user",
      "--unshare-ipc",
      "--unshare-pid",
      "--unshare-net",
      "--unshare-uts",
      "--unshare-cgroup",
      "--disable-userns",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
    ]) {
      expect(args).toContain(control);
    }
    expect(joined).not.toMatch(/unshare-(?:user|net|pid|ipc|uts|cgroup)-try/u);
    expect(joined).not.toContain("--bind / /");
    expect(joined).not.toContain("--ro-bind / /");
    expect(joined).not.toMatch(/--(?:ro-)?bind \/run(?:\/| )/u);
    expect(joined).not.toMatch(/--(?:ro-)?bind \/home(?:\/| )/u);
    expect(joined).toContain("--remount-ro /");
    expect(joined).toContain("--cap-drop ALL");
  });

  it("overlays protected metadata read-only after its sole writable workspace", () => {
    const root = "/private/runmill/workspaces/run-1";
    const args = buildAsfBubblewrapArgs({
      workspaceRoot: root,
      writableWorkspace: true,
      protectedPaths: [join(root, ".git"), join(root, ".runmill")],
      environment: {},
      command: "/usr/bin/true",
      args: [],
    });
    const joined = args.join(" ");
    const workspaceGrant = joined.indexOf(`--bind ${root} ${root}`);

    expect(workspaceGrant).toBeGreaterThan(-1);
    expect(joined.indexOf(`--ro-bind ${root}/.git ${root}/.git`)).toBeGreaterThan(workspaceGrant);
    expect(joined.indexOf(`--ro-bind ${root}/.runmill ${root}/.runmill`)).toBeGreaterThan(
      workspaceGrant,
    );
    expect(joined).toContain("--setenv HOME /home/runmill");
    expect(joined).toContain("--setenv GIT_CONFIG_NOSYSTEM 1");
  });
});

describe("buildAsfPrlimitArgs", () => {
  it("sets hard and soft CPU, address-space, process, and file limits before bwrap", () => {
    const result = buildAsfPrlimitArgs(
      { cpuMillis: 2_999, memoryMib: 256, processes: 32, fileSizeBytes: 65_536 },
      "/usr/bin/bwrap",
      ["--unshare-net", "/usr/bin/true"],
    );

    expect(result.cpuSeconds).toBe(2);
    expect(result.memoryBytes).toBe(256 * 1024 * 1024);
    expect(result.args).toEqual([
      "--cpu=2:2",
      `--as=${String(256 * 1024 * 1024)}:${String(256 * 1024 * 1024)}`,
      "--nproc=32:32",
      "--fsize=65536:65536",
      "--",
      "/usr/bin/bwrap",
      "--unshare-net",
      "/usr/bin/true",
    ]);
  });

  it("refuses a sub-second CPU limit instead of rounding it up and widening authority", () => {
    expect(() =>
      buildAsfPrlimitArgs(
        { cpuMillis: 999, memoryMib: 256, processes: 32, fileSizeBytes: 65_536 },
        "/usr/bin/bwrap",
        [],
      ),
    ).toThrow(/sub-second CPU budgets/u);
  });
});

describe("proveAsfWorkspaceCandidate", () => {
  it("binds a clean tree, self-contained Git directory, HEAD, and tree to the exact candidate", async () => {
    const repo = repository();
    const proof = await proveAsfWorkspaceCandidate({
      workspaceRoot: repo.workspace,
      candidateSha: repo.candidate,
      requireClean: true,
      gitPath: "/usr/bin/git",
    });

    expect(proof).toMatchObject({
      candidate_sha: repo.candidate,
      head_sha: repo.candidate,
      clean: true,
      git_directory: "self-contained",
      status_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      tree_sha: expect.stringMatching(/^[a-f0-9]{40}$/u),
    });
  });

  it("refuses a dirty fresh-candidate tree but still observes dirtiness for an implementation tree", async () => {
    const repo = repository();
    writeFileSync(join(repo.workspace, "planted-untracked"), "not in candidate\n");

    await expect(
      proveAsfWorkspaceCandidate({
        workspaceRoot: repo.workspace,
        candidateSha: repo.candidate,
        requireClean: true,
        gitPath: "/usr/bin/git",
      }),
    ).rejects.toThrow(/exactly clean Git tree/u);
    await expect(
      proveAsfWorkspaceCandidate({
        workspaceRoot: repo.workspace,
        candidateSha: repo.candidate,
        requireClean: false,
        gitPath: "/usr/bin/git",
      }),
    ).resolves.toMatchObject({ clean: false, head_sha: repo.candidate });
  });

  it("refuses a stale or contradictory candidate SHA", async () => {
    const repo = repository();
    await expect(
      proveAsfWorkspaceCandidate({
        workspaceRoot: repo.workspace,
        candidateSha: "f".repeat(40),
        requireClean: true,
        gitPath: "/usr/bin/git",
      }),
    ).rejects.toThrow(/HEAD does not equal/u);

    writeFileSync(join(repo.workspace, "README.md"), "second commit\n");
    git(repo.workspace, "add", "README.md");
    git(repo.workspace, "commit", "-q", "-m", "advance");
    await expect(
      proveAsfWorkspaceCandidate({
        workspaceRoot: repo.workspace,
        candidateSha: repo.candidate,
        requireClean: true,
        gitPath: "/usr/bin/git",
      }),
    ).rejects.toThrow(/HEAD does not equal/u);
  });

  it("refuses linked Git metadata because it would expose another workspace's control plane", async () => {
    const root = temporaryDirectory("runmill-asf-bwrap-linked-");
    const source = repository(root);
    const linked = join(root, "linked");
    git(source.workspace, "worktree", "add", "--detach", "-q", linked, source.candidate);

    await expect(
      proveAsfWorkspaceCandidate({
        workspaceRoot: linked,
        candidateSha: source.candidate,
        requireClean: true,
        gitPath: "/usr/bin/git",
      }),
    ).rejects.toThrow(/self-contained directory/u);
  });
});

describe("runControlledProcess", () => {
  it("terminates execution once observed output exceeds the trusted ceiling", async () => {
    const result = await runControlledProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(1024 * 1024)); setInterval(() => {}, 1000)"],
      cwd: temporaryDirectory("runmill-asf-output-"),
      env: { PATH: process.env["PATH"] ?? "" },
      timeoutMs: 10_000,
      maxOutputBytes: 4_096,
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe("output-limit");
    expect(result.outputBytesObserved).toBeGreaterThan(4_096);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4_096);
  });

  it("aborts the entire detached process group, including a planted grandchild", async () => {
    const directory = temporaryDirectory("runmill-asf-abort-");
    const pidFile = join(directory, "grandchild.pid");
    const controller = new AbortController();
    const execution = runControlledProcess({
      command: process.execPath,
      args: [
        "-e",
        [
          "const {spawn}=require('node:child_process')",
          "const fs=require('node:fs')",
          "const child=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore'})",
          `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
          "setInterval(() => {}, 1000)",
        ].join(";"),
      ],
      cwd: directory,
      env: { PATH: process.env["PATH"] ?? "" },
      timeoutMs: 20_000,
      maxOutputBytes: 4_096,
      signal: controller.signal,
    });

    const deadline = Date.now() + 5_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(pidFile)).toBe(true);
    const grandchildPid = Number(readFileSync(pidFile, "utf8"));
    process.kill(grandchildPid, 0);
    controller.abort();
    await expect(execution).resolves.toMatchObject({ outcome: "aborted", signal: "ABORT" });

    let alive = true;
    const stoppedDeadline = Date.now() + 5_000;
    while (alive && Date.now() < stoppedDeadline) {
      try {
        process.kill(grandchildPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 15_000);
});

const directBwrapAvailable = (() => {
  if (
    platform() !== "linux" ||
    process.getuid?.() === 0 ||
    !existsSync("/usr/bin/bwrap") ||
    !existsSync("/usr/bin/prlimit") ||
    !existsSync("/usr/bin/git")
  ) {
    return false;
  }
  // Exercise bubblewrap itself. A Seatbelt result never enables this test and
  // the probe does not infer availability merely from a Linux platform label.
  return (
    spawnSync(
      "/usr/bin/bwrap",
      [
        "--unshare-user",
        "--unshare-net",
        "--unshare-pid",
        "--die-with-parent",
        "--proc",
        "/proc",
        "--ro-bind",
        "/usr",
        "/usr",
        "/usr/bin/true",
      ],
      { encoding: "utf8", timeout: 5_000 },
    ).status === 0
  );
})();

describe("AsfBubblewrapProductionSandbox", () => {
  it.runIf(platform() !== "linux")("fails closed instead of downgrading on a non-Linux host", async () => {
    await expect(
      AsfBubblewrapProductionSandbox.create({
        clock: new FakeClock(),
        workspaceParent: temporaryDirectory("runmill-asf-parent-"),
      }),
    ).rejects.toThrow(/requires Linux/u);
  });

  it.runIf(directBwrapAvailable)(
    "plants a host resource that is accessible outside and denied inside the qualified bwrap",
    async () => {
      const parent = temporaryDirectory("runmill-asf-production-");
      const repo = repository(parent);
      const outside = join(parent, "other-workspace", "credential.txt");
      mkdirSync(join(parent, "other-workspace"), { mode: 0o700 });
      writeFileSync(outside, "outside-readable-secret", { mode: 0o600 });
      expect(readFileSync(outside, "utf8")).toBe("outside-readable-secret");

      const sandbox = await AsfBubblewrapProductionSandbox.create({
        clock: new FakeClock("2026-08-21T10:00:00Z"),
        workspaceParent: parent,
        bwrapPath: "/usr/bin/bwrap",
        prlimitPath: "/usr/bin/prlimit",
        gitPath: "/usr/bin/git",
      });
      const input: CredentialFreeSandboxExecution = {
        sandbox: {
          command: "/usr/bin/cat",
          args: [outside],
          cwd: repo.workspace,
          policy: {
            writablePaths: [],
            readablePaths: [repo.workspace],
            protectedPaths: [join(repo.workspace, ".git"), join(repo.workspace, ".runmill")],
            allowNetwork: false,
          },
          timeoutMs: 5_000,
          env: { PATH: "/usr/bin:/bin", LANG: "C" },
        },
        signal: new AbortController().signal,
        limits: { cpuMillis: 5_000, memoryMib: 512, processes: 4_096, fileSizeBytes: 1_048_576 },
        isolation: {
          inheritEnvironment: false,
          providerCredentials: "denied",
          hostCredentialPaths: "denied",
          hostSockets: "denied",
          otherWorkspaces: "denied",
          network: "disabled",
          candidate: repo.candidate,
          freshCandidate: true,
        },
      };

      expect(sandbox.qualification.probes).toMatchObject({
        sibling_read_denied: true,
        credential_read_denied: true,
        host_socket_path_denied: true,
        network_interfaces: ["lo"],
      });
      const denied = await sandbox.executeObserved(input);
      expect(denied.result.exitCode).not.toBe(0);
      expect(denied.result.stdout).not.toContain("outside-readable-secret");

      const allowed = await sandbox.executeObserved({
        ...input,
        sandbox: { ...input.sandbox, args: [join(repo.workspace, "README.md")] },
      });
      expect(allowed.result).toMatchObject({ outcome: "exited", exitCode: 0 });
      expect(allowed.result.stdout).toBe("candidate bytes\n");
      expect(allowed.observation).toMatchObject({
        candidate_before: { head_sha: repo.candidate, clean: true },
        candidate_after: { head_sha: repo.candidate, clean: true },
        writable_workspace: false,
      });
    },
    60_000,
  );
});
