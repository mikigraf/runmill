import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  statSync,
  chmodSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager, fetchTrustedBase } from "../../src/workspace/manager.js";
import { ALL_CHANGE_SCOPE } from "../../src/workspace/path-scope.js";
import { ALWAYS_FORBIDDEN_PATHS } from "../../src/agent/task-packet.js";
import { loadChecksManifest } from "../../src/verification/manifest.js";

let root: string;
let source: string;
let runs: string;
let mgr: WorkspaceManager;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRemovable(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, stat.mode | 0o700);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) makeRemovable(join(path, name));
  }
}

function addInstalledNodeProject(): void {
  const manifest = { name: "workspace-fixture", scripts: { test: "tiny-check" }, dependencies: { tiny: "1.0.0" } };
  const lock = {
    name: "workspace-fixture",
    lockfileVersion: 3,
    packages: {
      "": { name: "workspace-fixture", dependencies: { tiny: "1.0.0" } },
      "node_modules/tiny": { version: "1.0.0", integrity: "sha512-fixture" },
    },
  };
  const hidden = {
    name: "workspace-fixture",
    lockfileVersion: 3,
    packages: {
      "node_modules/tiny": { version: "1.0.0", integrity: "sha512-fixture" },
    },
  };
  writeFileSync(join(source, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(source, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(join(source, ".gitignore"), "node_modules/\n");
  mkdirSync(join(source, "node_modules/tiny"), { recursive: true });
  writeFileSync(
    join(source, "node_modules/tiny/package.json"),
    '{"name":"tiny","version":"1.0.0"}\n',
  );
  writeFileSync(join(source, "node_modules/tiny/check.js"), "console.log('1 passed')\n");
  writeFileSync(
    join(source, "node_modules/.package-lock.json"),
    `${JSON.stringify(hidden, null, 2)}\n`,
  );
  git(source, "add", "package.json", "package-lock.json", ".gitignore");
  git(source, "commit", "-q", "-m", "add node project");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runmill-ws-"));
  source = join(root, "source");
  runs = join(root, "runs");
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  git(source, "config", "user.email", "s@test");
  git(source, "config", "user.name", "S");
  writeFileSync(join(source, "README.md"), "seed\n");
  writeFileSync(join(source, "app.ts"), "export const x = 1;\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "seed");
  mgr = new WorkspaceManager();
});

afterEach(() => {
  makeRemovable(root);
  rmSync(root, { recursive: true, force: true });
});

async function create(runId = "run_1", isolation: "clone" | "separate-git-dir" = "clone") {
  return mgr.create({
    runId,
    sourceRepo: source,
    branch: `runmill/ENG-1-slug-1`,
    baseBranch: "main",
    root: runs,
    isolation,
  });
}

describe("WorkspaceManager.create (clone isolation)", () => {
  it("creates the workspace on its own branch at the base commit", async () => {
    const ws = await create();
    expect(existsSync(ws.path)).toBe(true);
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("runmill/ENG-1-slug-1");
    expect(ws.baseCommit).toBe(git(source, "rev-parse", "HEAD"));
  });

  it("uses the freshly fetched remote base without moving a stale local branch", async () => {
    mkdirSync(join(source, ".runmill"), { recursive: true });
    writeFileSync(
      join(source, ".runmill", "checks.yaml"),
      "checks:\n  - id: local-old\n    run: npm test\n",
    );
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "local base policy");
    const localMain = git(source, "rev-parse", "refs/heads/main");

    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    git(source, "remote", "add", "origin", origin);
    git(source, "push", "-q", "origin", "main");

    const updater = join(root, "updater");
    execFileSync("git", ["clone", "-q", origin, updater]);
    git(updater, "config", "user.email", "remote@test");
    git(updater, "config", "user.name", "Remote");
    writeFileSync(join(updater, "remote-only.txt"), "from origin/main\n");
    writeFileSync(
      join(updater, ".runmill", "checks.yaml"),
      "checks:\n  - id: remote-new\n    run: npm run check\n",
    );
    git(updater, "add", "-A");
    git(updater, "commit", "-q", "-m", "advance remote base");
    git(updater, "push", "-q", "origin", "main");
    const remoteMain = git(updater, "rev-parse", "HEAD");

    const trusted = await fetchTrustedBase(source, "main");
    const manifest = loadChecksManifest({
      repoRoot: source,
      manifestPath: ".runmill/checks.yaml",
      baseRef: trusted.commit,
    });
    const ws = await mgr.create({
      runId: "run_fresh_remote",
      sourceRepo: source,
      branch: "runmill/ENG-2-fresh-1",
      baseBranch: "main",
      sourceRef: trusted.commit,
      root: runs,
      isolation: "clone",
    });

    expect(trusted.ref).toMatch(/^refs\/runmill\/bases\/[a-f0-9]{64}$/);
    expect(trusted.commit).toBe(remoteMain);
    expect(git(source, "rev-parse", "refs/heads/main")).toBe(localMain);
    expect(git(source, "rev-parse", trusted.ref)).toBe(remoteMain);
    expect(manifest?.checks.map((check) => check.id)).toEqual(["remote-new"]);
    expect(ws.baseCommit).toBe(remoteMain);
    expect(readFileSync(join(ws.path, "remote-only.txt"), "utf8")).toBe("from origin/main\n");
  });

  it("gives the run a self-contained .git DIRECTORY, not a pointer file", async () => {
    // This is the whole isolation argument. A linked worktree's .git is a file
    // pointing into the parent repo, so scoping the sandbox to the workspace
    // breaks git, and granting the parent .git is the escape.
    const ws = await create();
    const dotGit = join(ws.path, ".git");
    expect(statSync(dotGit).isDirectory()).toBe(true);
  });

  it("clones from the repository root when invoked from a subdirectory", async () => {
    // runmill is routinely run from a subdirectory, and `git clone <repo>/sub`
    // is not a repository. This failed silently — create() used the
    // non-throwing `run` for the clone while everything else used `runGit` — so
    // the run died three steps later in #harden and blamed `git config`.
    const sub = join(source, "examples", "quickstart");
    execFileSync("mkdir", ["-p", sub]);
    const ws = await mgr.create({
      runId: "run_sub",
      sourceRepo: sub,
      branch: "runmill/ENG-2-slug-1",
      baseBranch: "main",
      root: runs,
      isolation: "clone",
    });
    expect(existsSync(join(ws.path, "README.md"))).toBe(true);
    expect(git(ws.path, "rev-parse", "HEAD")).toBe(git(source, "rev-parse", "HEAD"));
  });

  it("fails loudly when the clone cannot happen", async () => {
    // A silently ignored clone leaves an empty directory that every later step
    // misattributes.
    await expect(
      mgr.create({
        runId: "run_bad",
        sourceRepo: source,
        branch: "runmill/ENG-3-slug-1",
        baseBranch: "no-such-branch",
        root: runs,
        isolation: "clone",
      }),
    ).rejects.toThrow();
  });

  it("does not share the parent object store", async () => {
    const ws = await create();
    // A new commit in the workspace must not appear in the source repository.
    writeFileSync(join(ws.path, "new.ts"), "export const y = 2;\n");
    const sha = await mgr.checkpoint(ws, "wip", ALL_CHANGE_SCOPE);
    expect(sha).toBeDefined();
    expect(() => git(source, "cat-file", "-e", sha as string)).toThrow();
  });

  it("declares only the workspace itself as writable", async () => {
    const ws = await create();
    expect(ws.writablePaths).toEqual([ws.path]);
  });

  it("disables git hooks so an agent cannot get code execution via .git/hooks", async () => {
    const ws = await create();
    expect(git(ws.path, "config", "core.hooksPath")).toBe("/dev/null");
  });

  it("refuses to reuse a path left behind by a crashed run", async () => {
    await create("run_1");
    await expect(create("run_1")).rejects.toThrow(/already exists/i);
  });

  it("isolates two concurrent runs from each other", async () => {
    const a = await create("run_a");
    const b = await create("run_b");
    writeFileSync(join(a.path, "only-a.ts"), "1\n");
    await mgr.checkpoint(a, "a work", ALL_CHANGE_SCOPE);
    expect(existsSync(join(b.path, "only-a.ts"))).toBe(false);
  });
});

describe("WorkspaceManager.create (separate-git-dir isolation)", () => {
  it("refuses a linked worktree whose Git metadata cannot be safely exposed", async () => {
    await expect(create("run_wt", "separate-git-dir")).rejects.toThrow(
      /outside the workspace|weakening isolation/i,
    );
    expect(existsSync(join(runs, "run_wt"))).toBe(false);
  });
});

describe("tree identity and checkpoints", () => {
  it("reports a clean tree, then a dirty one after an edit", async () => {
    const ws = await create();
    expect(await mgr.isClean(ws)).toBe(true);
    writeFileSync(join(ws.path, "app.ts"), "export const x = 2;\n");
    expect(await mgr.isClean(ws)).toBe(false);
  });

  it("changes the tree hash when the working tree changes", async () => {
    const ws = await create();
    const before = await mgr.treeHash(ws);
    writeFileSync(join(ws.path, "app.ts"), "export const x = 99;\n");
    expect(await mgr.treeHash(ws)).not.toBe(before);
  });

  it("checkpoints agent work as an orchestrator-authored commit", async () => {
    const ws = await create();
    writeFileSync(join(ws.path, "app.ts"), "export const x = 2;\n");
    const sha = await mgr.checkpoint(ws, "checkpoint: implementer", ALL_CHANGE_SCOPE);
    expect(sha).toBeDefined();
    expect(git(ws.path, "log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce")).toBe(
      "S\0s@test\0S\0s@test",
    );
    expect(await mgr.isClean(ws)).toBe(true);
  });

  it("does not persist operator identity or signing-key settings in the agent-visible clone", async () => {
    git(source, "config", "user.name", "Verified Operator");
    git(source, "config", "user.email", "operator@example.com");
    git(source, "config", "user.signingkey", join(root, "outside-workspace.key"));
    const ws = await create("run_private_provenance");

    expect(() => git(ws.path, "config", "--local", "--get", "user.name")).toThrow();
    expect(() => git(ws.path, "config", "--local", "--get", "user.email")).toThrow();
    expect(() => git(ws.path, "config", "--local", "--get", "user.signingkey")).toThrow();
    expect(readFileSync(join(ws.path, ".git", "config"), "utf8")).not.toContain(
      "outside-workspace.key",
    );
  });

  it("uses current timestamps even when the daemon inherited epoch Git dates", async () => {
    const ws = await create("run_current_date");
    writeFileSync(join(ws.path, "app.ts"), "export const x = 2;\n");
    const priorAuthorDate = process.env["GIT_AUTHOR_DATE"];
    const priorCommitterDate = process.env["GIT_COMMITTER_DATE"];
    process.env["GIT_AUTHOR_DATE"] = "1970-01-01T00:00:00Z";
    process.env["GIT_COMMITTER_DATE"] = "1970-01-01T00:00:00Z";
    try {
      const sha = (await mgr.checkpoint(ws, "candidate", ALL_CHANGE_SCOPE)) as string;
      const [authorTime, committerTime] = git(ws.path, "show", "-s", "--format=%at%x00%ct", sha)
        .split("\0")
        .map(Number);
      expect(authorTime).toBeGreaterThan(Date.UTC(2020, 0, 1) / 1_000);
      expect(committerTime).toBeGreaterThan(Date.UTC(2020, 0, 1) / 1_000);
    } finally {
      if (priorAuthorDate === undefined) delete process.env["GIT_AUTHOR_DATE"];
      else process.env["GIT_AUTHOR_DATE"] = priorAuthorDate;
      if (priorCommitterDate === undefined) delete process.env["GIT_COMMITTER_DATE"];
      else process.env["GIT_COMMITTER_DATE"] = priorCommitterDate;
    }
  });

  it("honors source-repository SSH signing without copying the key setting into the clone", async () => {
    const signingKey = join(root, "operator-signing-key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", signingKey]);
    git(source, "config", "commit.gpgSign", "true");
    git(source, "config", "gpg.format", "ssh");
    git(source, "config", "gpg.ssh.program", "ssh-keygen");
    git(source, "config", "user.signingKey", signingKey);

    const ws = await create("run_signed");
    writeFileSync(join(ws.path, "app.ts"), "export const x = 2;\n");
    const sha = (await mgr.checkpoint(ws, "signed candidate", ALL_CHANGE_SCOPE)) as string;

    expect(git(ws.path, "cat-file", "commit", sha)).toMatch(
      /^gpgsig -----BEGIN SSH SIGNATURE-----/mu,
    );
    expect(() => git(ws.path, "config", "--local", "--get", "user.signingkey")).toThrow();
  });

  it("refuses a candidate when configured signing cannot produce a signature", async () => {
    git(source, "config", "commit.gpgSign", "true");
    git(source, "config", "gpg.format", "ssh");
    git(source, "config", "gpg.ssh.program", "ssh-keygen");
    git(source, "config", "user.signingKey", join(root, "missing-signing-key"));
    const ws = await create("run_broken_signing");
    writeFileSync(join(ws.path, "app.ts"), "export const x = 2;\n");

    await expect(mgr.checkpoint(ws, "must be signed", ALL_CHANGE_SCOPE)).rejects.toThrow(
      /sign|failed/i,
    );
    expect(git(ws.path, "rev-parse", "HEAD")).toBe(ws.baseCommit);
  });

  it("refuses the old runmill@localhost placeholder before an agent can run", async () => {
    git(source, "config", "user.name", "runmill");
    git(source, "config", "user.email", "runmill@localhost");

    await expect(create("run_placeholder_identity")).rejects.toThrow(/runmill@localhost/i);
    expect(existsSync(join(runs, "run_placeholder_identity"))).toBe(false);
  });

  it("refuses an absent explicit identity instead of letting Git invent one", async () => {
    git(source, "config", "user.name", "");

    await expect(create("run_missing_identity")).rejects.toThrow(/explicit Git user\.name/i);
    expect(existsSync(join(runs, "run_missing_identity"))).toBe(false);
  });

  it("returns undefined when there is nothing to check point", async () => {
    const ws = await create();
    expect(await mgr.checkpoint(ws, "noop", ALL_CHANGE_SCOPE)).toBeUndefined();
  });

  it("lists files changed against the base commit", async () => {
    const ws = await create();
    writeFileSync(join(ws.path, "app.ts"), "export const x = 2;\n");
    await mgr.checkpoint(ws, "wip", ALL_CHANGE_SCOPE);
    expect(await mgr.changedFiles(ws)).toEqual(["app.ts"]);
  });

  it("refuses an agent-authored commit instead of adopting its HEAD", async () => {
    const ws = await create();
    writeFileSync(join(ws.path, "agent.ts"), "export const agent = true;\n");
    git(ws.path, "add", "agent.ts");
    git(
      ws.path,
      "-c",
      "user.name=untrusted agent",
      "-c",
      "user.email=agent@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-q",
      "--no-verify",
      "-m",
      "agent commit",
    );

    await expect(mgr.checkpoint(ws, "orchestrator", ALL_CHANGE_SCOPE)).rejects.toThrow(
      /HEAD|refs/i,
    );
    expect(git(ws.path, "rev-parse", "HEAD")).not.toBe(ws.baseCommit);
    // Refusal did not bless the worker commit as a new baseline.
    await expect(mgr.checkpoint(ws, "try again", ALL_CHANGE_SCOPE)).rejects.toThrow(/HEAD|refs/i);
  });

  it("refuses a changed Git config before invoking the checkpoint", async () => {
    const ws = await create();
    git(ws.path, "config", "core.hooksPath", ".git/hooks");
    await expect(mgr.checkpoint(ws, "orchestrator", ALL_CHANGE_SCOPE)).rejects.toThrow(
      /Git config/i,
    );
  });

  it("refuses a planted Git hook even while core.hooksPath remains disabled", async () => {
    const ws = await create();
    writeFileSync(join(ws.path, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    await expect(mgr.checkpoint(ws, "orchestrator", ALL_CHANGE_SCOPE)).rejects.toThrow(
      /Git hooks/i,
    );
  });

  it("refuses an agent-mutated index", async () => {
    const ws = await create();
    writeFileSync(join(ws.path, "staged.ts"), "export const staged = true;\n");
    git(ws.path, "add", "staged.ts");
    await expect(mgr.checkpoint(ws, "orchestrator", ALL_CHANGE_SCOPE)).rejects.toThrow(
      /Git index/i,
    );
  });

  it("rejects a changed path outside allowed_paths before creating a commit", async () => {
    const ws = await create();
    mkdirSync(join(ws.path, "test"), { recursive: true });
    writeFileSync(join(ws.path, "test", "escape.test.ts"), "outside\n");
    await expect(
      mgr.checkpoint(ws, "candidate", {
        allowedPaths: ["src/**"],
        forbiddenPaths: ALWAYS_FORBIDDEN_PATHS,
      }),
    ).rejects.toThrow(/outside allowed_paths/i);
    expect(git(ws.path, "rev-parse", "HEAD")).toBe(ws.baseCommit);
    expect(git(ws.path, "diff", "--cached", "--name-only")).toBe("");
  });

  it.each([
    ".github/workflows/agent.yml",
    "package.json",
    "package-lock.json",
    "nested/dependency.lock",
    ".runmill/agent-policy.yml",
  ])("rejects the always-forbidden path %s before creating a commit", async (path) => {
    const ws = await create(`run_forbidden_${path.replaceAll(/[^a-z]/g, "_")}`);
    mkdirSync(join(ws.path, path, ".."), { recursive: true });
    writeFileSync(join(ws.path, path), "agent change\n");

    await expect(
      mgr.checkpoint(ws, "candidate", {
        allowedPaths: ["**"],
        forbiddenPaths: ALWAYS_FORBIDDEN_PATHS,
      }),
    ).rejects.toThrow(/forbidden_paths/i);
    expect(git(ws.path, "rev-parse", "HEAD")).toBe(ws.baseCommit);
  });

  it("detects an edit to the orchestrator-owned task packet", async () => {
    const ws = await create();
    const packet = mgr.writeTaskPacket(ws, { run_id: "run_1" });
    writeFileSync(packet, '{"run_id":"agent"}\n');
    await expect(mgr.checkpoint(ws, "candidate", ALL_CHANGE_SCOPE)).rejects.toThrow(
      /orchestrator-owned run input/i,
    );
  });
});

describe("verification checkout", () => {
  it("materializes exact-lock npm dependencies without putting them in the candidate commit", async () => {
    addInstalledNodeProject();
    const ws = await create();
    const verifyPath = await mgr.createVerificationCheckout(ws, await mgr.headSha(ws));

    expect(existsSync(join(verifyPath, "node_modules/tiny/check.js"))).toBe(true);
    expect(git(verifyPath, "status", "--porcelain")).toBe("");
    expect(mgr.verificationDependencyPath(verifyPath)).toBe(join(verifyPath, "node_modules"));
    expect(lstatSync(join(verifyPath, "node_modules/tiny/check.js")).mode & 0o222).toBe(0);

    await mgr.destroyVerificationCheckout(ws, verifyPath);
    await mgr.destroy(ws, source);
    makeRemovable(join(root, "dependencies"));
  });

  it("refuses a stale source install before an agent or verification check can run", async () => {
    addInstalledNodeProject();
    // HEAD remains the trusted base, while the operator checkout no longer
    // represents that exact package/lock input.
    writeFileSync(join(source, "package-lock.json"), "{}\n");

    await expect(create()).rejects.toThrow(/RM-VERIFY-005|exact base commit/i);
    expect(existsSync(join(runs, "run_1"))).toBe(false);
  });

  it("refuses to hide prepared dependencies inside the measured source tree", async () => {
    addInstalledNodeProject();
    git(source, "rm", "-q", ".gitignore");
    git(source, "commit", "-q", "-m", "stop ignoring dependencies");
    const ws = await create();

    await expect(
      mgr.createVerificationCheckout(ws, await mgr.headSha(ws)),
    ).rejects.toThrow(/RM-VERIFY-005|node_modules is not ignored/i);

    await mgr.destroy(ws, source);
    makeRemovable(join(root, "dependencies"));
  });

  it("materializes the exact candidate commit in a separate directory", async () => {
    const ws = await create();
    writeFileSync(join(ws.path, "app.ts"), "export const x = 2;\n");
    const candidate = (await mgr.checkpoint(ws, "candidate", ALL_CHANGE_SCOPE)) as string;

    const verifyPath = await mgr.createVerificationCheckout(ws, candidate);
    expect(verifyPath).not.toBe(ws.path);
    expect(git(verifyPath, "rev-parse", "HEAD")).toBe(candidate);
    await mgr.destroyVerificationCheckout(ws, verifyPath);
  });

  it("is unaffected by later edits to the run workspace", async () => {
    // The point of a detached checkout: a check cannot be tricked by the agent
    // editing the tree while the check is running.
    const ws = await create();
    writeFileSync(join(ws.path, "app.ts"), "export const x = 2;\n");
    const candidate = (await mgr.checkpoint(ws, "candidate", ALL_CHANGE_SCOPE)) as string;
    const verifyPath = await mgr.createVerificationCheckout(ws, candidate);

    writeFileSync(join(ws.path, "app.ts"), "export const x = 999;\n");

    expect(readFileSync(join(verifyPath, "app.ts"), "utf8")).toContain("x = 2");
    await mgr.destroyVerificationCheckout(ws, verifyPath);
  });

  it("is clean by construction, so a dirty run tree cannot pass as the candidate", async () => {
    const ws = await create();
    writeFileSync(join(ws.path, "app.ts"), "export const x = 2;\n");
    const candidate = (await mgr.checkpoint(ws, "candidate", ALL_CHANGE_SCOPE)) as string;
    writeFileSync(join(ws.path, "untracked.ts"), "leak\n");

    const verifyPath = await mgr.createVerificationCheckout(ws, candidate);
    expect(git(verifyPath, "status", "--porcelain")).toBe("");
    expect(existsSync(join(verifyPath, "untracked.ts"))).toBe(false);
    await mgr.destroyVerificationCheckout(ws, verifyPath);
  });
});

describe("task packet", () => {
  it("writes the packet inside the workspace", async () => {
    const ws = await create();
    const path = mgr.writeTaskPacket(ws, { run_id: "run_1", objective: "do the thing" });
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ run_id: "run_1" });
  });
});

describe("cleanup", () => {
  it("removes the workspace", async () => {
    const ws = await create();
    await mgr.destroy(ws, source);
    expect(existsSync(ws.path)).toBe(false);
  });

});
