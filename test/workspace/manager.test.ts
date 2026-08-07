import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../../src/workspace/manager.js";

let root: string;
let source: string;
let runs: string;
let mgr: WorkspaceManager;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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
    const sha = await mgr.checkpoint(ws, "wip");
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
    await mgr.checkpoint(a, "a work");
    expect(existsSync(join(b.path, "only-a.ts"))).toBe(false);
  });
});

describe("WorkspaceManager.create (separate-git-dir isolation)", () => {
  it("creates a linked worktree", async () => {
    const ws = await create("run_wt", "separate-git-dir");
    expect(existsSync(ws.path)).toBe(true);
    expect(ws.isolation).toBe("separate-git-dir");
  });

  it("has a .git FILE, which is exactly why it is not the default", async () => {
    const ws = await create("run_wt", "separate-git-dir");
    expect(statSync(join(ws.path, ".git")).isFile()).toBe(true);
    expect(readFileSync(join(ws.path, ".git"), "utf8")).toContain("gitdir:");
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
    const sha = await mgr.checkpoint(ws, "checkpoint: implementer");
    expect(sha).toBeDefined();
    expect(git(ws.path, "log", "-1", "--format=%an")).toBe("runmill");
    expect(await mgr.isClean(ws)).toBe(true);
  });

  it("returns undefined when there is nothing to check point", async () => {
    const ws = await create();
    expect(await mgr.checkpoint(ws, "noop")).toBeUndefined();
  });

  it("lists files changed against the base commit", async () => {
    const ws = await create();
    writeFileSync(join(ws.path, "app.ts"), "export const x = 2;\n");
    await mgr.checkpoint(ws, "wip");
    expect(await mgr.changedFiles(ws)).toEqual(["app.ts"]);
  });
});

describe("verification checkout", () => {
  it("materializes the exact candidate commit in a separate directory", async () => {
    const ws = await create();
    writeFileSync(join(ws.path, "app.ts"), "export const x = 2;\n");
    const candidate = (await mgr.checkpoint(ws, "candidate")) as string;

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
    const candidate = (await mgr.checkpoint(ws, "candidate")) as string;
    const verifyPath = await mgr.createVerificationCheckout(ws, candidate);

    writeFileSync(join(ws.path, "app.ts"), "export const x = 999;\n");

    expect(readFileSync(join(verifyPath, "app.ts"), "utf8")).toContain("x = 2");
    await mgr.destroyVerificationCheckout(ws, verifyPath);
  });

  it("is clean by construction, so a dirty run tree cannot pass as the candidate", async () => {
    const ws = await create();
    writeFileSync(join(ws.path, "app.ts"), "export const x = 2;\n");
    const candidate = (await mgr.checkpoint(ws, "candidate")) as string;
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

  it("removes a linked worktree through git so the parent stays consistent", async () => {
    const ws = await create("run_wt", "separate-git-dir");
    await mgr.destroy(ws, source);
    expect(existsSync(ws.path)).toBe(false);
    expect(git(source, "worktree", "list")).not.toContain(ws.path);
  });
});
