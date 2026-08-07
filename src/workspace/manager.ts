import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git as runGit } from "../platform/git.js";
import { run } from "../platform/process.js";


export type GitIsolation = "clone" | "separate-git-dir";

export interface Workspace {
  readonly runId: string;
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly isolation: GitIsolation;
  /** Directories the sandbox must permit writes to. Nothing else. */
  readonly writablePaths: readonly string[];
}

export interface CreateWorkspaceInput {
  readonly runId: string;
  readonly sourceRepo: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly root: string;
  readonly isolation?: GitIsolation | undefined;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return runGit(cwd, args);
}

/**
 * Per-run workspaces.
 *
 * The isolation decision is load-bearing and easy to get wrong. A linked git
 * worktree's `.git` is a *file* pointing into the parent repository's git
 * directory, so the object store, config, and **hooks** are shared across every
 * worktree and with the orchestrator's own git invocations. That has two
 * consequences:
 *
 *   1. A sandbox that permits writes only inside the worktree breaks git
 *      entirely, because `.git` lives outside it.
 *   2. Granting the shared `.git` is the escape: an agent can write
 *      `.git/hooks/pre-commit` and obtain code execution in the orchestrator's
 *      context on the next commit, and can read and modify other runs' refs.
 *
 * `clone` is therefore the default: a local clone with `--no-hardlinks` gives
 * the run a self-contained `.git` inside its own directory, which is the only
 * shape where "write access only to the run worktree" is both true and
 * compatible with git working at all.
 */
export class WorkspaceManager {
  #indexSeq = 0;

  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const isolation = input.isolation ?? "clone";
    const path = join(input.root, input.runId);

    if (existsSync(path)) {
      throw new Error(
        `workspace ${path} already exists; a crashed run may have left it behind. ` +
          `Run \`runmill gc\` to reconcile.`,
      );
    }
    mkdirSync(input.root, { recursive: true, mode: 0o700 });

    if (isolation === "clone") {
      await run("git", [
        "clone",
        "--no-hardlinks",
        "--quiet",
        "--branch",
        input.baseBranch,
        input.sourceRepo,
        path,
      ]);
    } else {
      // Worktree mode. Retained because it is cheap for very large
      // repositories, but it shares the parent object store, so the sandbox
      // profile must additionally grant read access to the parent `.git` and
      // the isolation guarantee is correspondingly weaker.
      await run("git", ["worktree", "add", "--quiet", "--detach", path, input.baseBranch], {
        cwd: input.sourceRepo,
      });
    }

    await this.#harden(path);
    await git(path, "checkout", "-q", "-b", input.branch);
    const baseCommit = await git(path, "rev-parse", "HEAD");

    return {
      runId: input.runId,
      path,
      branch: input.branch,
      baseCommit,
      isolation,
      writablePaths: [path],
    };
  }

  /**
   * Close the obvious escapes before any agent runs.
   *
   * Hooks are executable code that git runs implicitly; an agent that can write
   * one has arbitrary code execution the next time the orchestrator commits.
   */
  async #harden(path: string): Promise<void> {
    await git(path, "config", "core.hooksPath", "/dev/null");
    await git(path, "config", "receive.denyCurrentBranch", "true");
    await git(path, "config", "protocol.ext.allow", "never");
    await git(path, "config", "user.name", "runmill");
    await git(path, "config", "user.email", "runmill@localhost");
  }

  /** Is the working tree free of uncommitted changes? */
  async isClean(workspace: Workspace): Promise<boolean> {
    return (await git(workspace.path, "status", "--porcelain")) === "";
  }

  /**
   * Tree identity of the working tree as it is on disk right now.
   *
   * Captured before and after every check: a commit SHA alone does not
   * describe what was on disk, so a differing hash across a check invalidates
   * its result.
   *
   * Uses a scratch index so the run's real index is never disturbed. Staging
   * into the live index to compute a hash would be a side effect that changes
   * what a later checkpoint commits.
   */
  async treeHash(workspace: Workspace): Promise<string> {
    this.#indexSeq += 1;
    const scratchIndex = join(
      tmpdir(),
      `runmill-index-${process.pid}-${workspace.runId}-${this.#indexSeq}`,
    );
    const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
    try {
      await run("git", ["read-tree", "HEAD"], { cwd: workspace.path, env });
      await run("git", ["add", "-A"], { cwd: workspace.path, env });
      const { stdout } = await run("git", ["write-tree"], { cwd: workspace.path, env });
      return stdout.trim();
    } finally {
      rmSync(scratchIndex, { force: true });
    }
  }

  async headSha(workspace: Workspace): Promise<string> {
    return git(workspace.path, "rev-parse", "HEAD");
  }

  async changedFiles(workspace: Workspace): Promise<string[]> {
    const out = await git(workspace.path, "diff", "--name-only", workspace.baseCommit);
    return out === "" ? [] : out.split("\n");
  }

  /**
   * The orchestrator owns committing. The worker never stages, commits,
   * signs, or pushes: the completion contract permits an unclean tree, branch
   * protection can require signed commits, and push needs a credential the
   * worker must never hold.
   */
  async checkpoint(workspace: Workspace, message: string): Promise<string | undefined> {
    await git(workspace.path, "add", "-A");
    const staged = await git(workspace.path, "diff", "--cached", "--name-only");
    if (staged === "") return undefined;
    await git(workspace.path, "commit", "--quiet", "-m", message);
    return git(workspace.path, "rev-parse", "HEAD");
  }

  /**
   * Create the immutable checkout verification runs against.
   *
   * Reading HEAD and recording the SHA proves nothing: a check can run against
   * a dirty tree whose contents differ from that commit. Verification therefore
   * happens in a separate detached worktree at the exact candidate commit, and
   * the provider cannot write to it.
   */
  async createVerificationCheckout(workspace: Workspace, candidateSha: string): Promise<string> {
    const path = `${workspace.path}-verify-${candidateSha.slice(0, 12)}`;
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    await git(workspace.path, "worktree", "add", "--quiet", "--detach", path, candidateSha);
    return path;
  }

  async destroyVerificationCheckout(workspace: Workspace, path: string): Promise<void> {
    try {
      await git(workspace.path, "worktree", "remove", "--force", path);
    } catch {
      rmSync(path, { recursive: true, force: true });
    }
  }

  /**
   * Write the task packet into the workspace.
   *
   * `.runmill/` inside the run workspace is orchestrator-owned; the packet is
   * an input to the agent, never something it may edit to widen its authority.
   */
  writeTaskPacket(workspace: Workspace, packet: unknown): string {
    const dir = join(workspace.path, ".runmill", "run");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "task.json");
    writeFileSync(path, `${JSON.stringify(packet, null, 2)}\n`);
    return path;
  }

  async destroy(workspace: Workspace, sourceRepo?: string): Promise<void> {
    if (workspace.isolation === "separate-git-dir" && sourceRepo !== undefined) {
      try {
        await run("git", ["worktree", "remove", "--force", workspace.path], { cwd: sourceRepo });
        return;
      } catch {
        // fall through to a plain removal
      }
    }
    rmSync(workspace.path, { recursive: true, force: true });
  }

  /** Reconcile worktrees and stale run directories after a crash. */
  async prune(sourceRepo: string): Promise<void> {
    await run("git", ["worktree", "prune"], { cwd: sourceRepo });
  }
}
