import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  createCandidateCommit,
  git as runGit,
  resolveCandidateCommitProvenance,
  tryGit,
  type CandidateCommitProvenance,
} from "../platform/git.js";
import type { GitHubGitCredential } from "../platform/github-git-credential.js";
import {
  assertChangedPathScope,
  normalizeRepositoryPath,
  type ChangeScope,
} from "./path-scope.js";
import {
  materializeDependencies,
  prepareDependencies,
  releaseMaterializedDependencies,
  type PreparedDependencies,
} from "./dependencies.js";
import { RunmillError } from "../errors/runmill-error.js";

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
  /**
   * Trusted commit or ref to materialize. Live runs pass the exact commit
   * fetched from the configured remote; evaluation can pass a historical SHA.
   */
  readonly sourceRef?: string | undefined;
  /**
   * Operator checkout whose ignored dependencies may seed verification.
   * Defaults to sourceRepo. Replay harnesses that clone fixtures without
   * ignored files can name the original checkout explicitly.
   */
  readonly dependencySourceRepo?: string | undefined;
  readonly root: string;
  readonly isolation?: GitIsolation | undefined;
}

export interface TrustedBase {
  /** A Runmill-owned ref which keeps the fetched object reachable locally. */
  readonly ref: string;
  /** Exact commit resolved immediately after the fetch. */
  readonly commit: string;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return runGit(cwd, args);
}

/**
 * The repository root containing `dir`.
 *
 * runmill is routinely invoked from a subdirectory, and a subdirectory is not
 * something you can clone.
 */
async function repoRoot(dir: string): Promise<string> {
  const found = await tryGit(dir, ["rev-parse", "--show-toplevel"]);
  return found.ok ? found.stdout.trim() : dir;
}

/**
 * Fetch a remote branch without updating the operator's local branch.
 *
 * A normal `git fetch origin main:main` moves `refs/heads/main`, while relying
 * on the existing local branch can silently start a run from stale code. Keep
 * the remote observation under a Runmill-owned ref and return its exact SHA so
 * policy loading and workspace creation can use the same immutable base.
 */
export async function fetchTrustedBase(
  sourceRepo: string,
  baseBranch: string,
  remote = "origin",
  credential?: GitHubGitCredential,
): Promise<TrustedBase> {
  const root = await repoRoot(sourceRepo);
  const remoteRef = `refs/heads/${baseBranch}`;
  const valid = await tryGit(root, ["check-ref-format", remoteRef]);
  if (!valid.ok) {
    throw new Error(`configured base branch ${JSON.stringify(baseBranch)} is not a valid Git ref`);
  }

  const key = createHash("sha256")
    .update(remote)
    .update("\0")
    .update(baseBranch)
    .digest("hex");
  const ref = `refs/runmill/bases/${key}`;
  const fetchArgs = [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    remote,
    `+${remoteRef}:${ref}`,
  ] as const;
  const fetched =
    credential === undefined
      ? await tryGit(root, fetchArgs)
      : await credential.tryGit(root, fetchArgs);
  if (!fetched.ok) {
    throw new Error(
      `could not fetch configured base branch ${JSON.stringify(baseBranch)} from ${remote}: ` +
        (fetched.stderr.trim() || "unknown Git error"),
    );
  }

  const commit = await git(root, "rev-parse", "--verify", `${ref}^{commit}`);
  return { ref, commit };
}

const RUNTIME_INPUT_PATHS = [".runmill/run/task.json", ".runmill/run/issue.md"] as const;
const RUNTIME_OUTPUT_PATHS = [
  ".runmill/run/local-reviewer-output.json",
  ".runmill/run/pr-reviewer-output.json",
] as const;
const RUNTIME_PATHS = [...RUNTIME_INPUT_PATHS, ...RUNTIME_OUTPUT_PATHS] as const;

interface GitControlSnapshot {
  readonly gitDir: string;
  readonly headSha: string;
  readonly indexTree: string;
  readonly config: string;
  readonly headFile: string;
  readonly headRefPath?: string | undefined;
  readonly headRef: string;
  readonly hooks: string;
  readonly info: string;
  readonly objectInfo: string;
  readonly replaceRefs: string;
  readonly packedRefs: string;
}

/** Hash names, kinds, modes and bytes without following repository-controlled links. */
function fingerprintPath(path: string): string {
  const hash = createHash("sha256");
  const visit = (candidate: string, label: string): void => {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(candidate);
    } catch {
      hash.update(`${label}\0missing\0`);
      return;
    }
    hash.update(`${label}\0${stat.mode.toString(8)}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${readlinkSync(candidate)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update("directory\0");
      for (const name of readdirSync(candidate).sort()) visit(join(candidate, name), `${label}/${name}`);
      return;
    }
    if (stat.isFile()) {
      hash.update("file\0");
      hash.update(readFileSync(candidate));
      hash.update("\0");
      return;
    }
    hash.update("other\0");
  };
  visit(path, ".");
  return hash.digest("hex");
}

function pathspecExclusions(): string[] {
  return RUNTIME_PATHS.map((path) => `:(exclude,top,literal)${path}`);
}

function nulSeparatedPaths(output: string): string[] {
  if (output === "") return [];
  return output
    .split("\0")
    .filter((path) => path !== "")
    .map(normalizeRepositoryPath);
}

function currentHeadRefPath(gitDir: string): string | undefined {
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  if (!head.startsWith("ref: ")) return undefined;
  const ref = head.slice("ref: ".length);
  if (!ref.startsWith("refs/heads/") || ref.split("/").some((part) => part === "..")) {
    throw new Error(`workspace HEAD points at an unsafe ref ${JSON.stringify(ref)}`);
  }
  return join(gitDir, ...ref.split("/"));
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
  readonly #trustedGit = new Map<string, GitControlSnapshot>();
  readonly #runInputs = new Map<string, Map<string, string>>();
  readonly #commitProvenance = new Map<string, CandidateCommitProvenance>();
  readonly #dependencySources = new Map<
    string,
    { readonly installedSource: string; readonly cacheRoot: string }
  >();
  readonly #preparedDependencies = new Map<string, PreparedDependencies>();

  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const isolation = input.isolation ?? "clone";
    if (isolation !== "clone") {
      throw new Error(
        "separate-git-dir isolation is not supported: its Git metadata lives outside the " +
          "workspace and cannot be granted to the agent without weakening isolation",
      );
    }
    const path = join(input.root, input.runId);
    let provenance: CandidateCommitProvenance | undefined;

    if (existsSync(path)) {
      throw new Error(
        `workspace ${path} already exists; a crashed run may have left it behind. ` +
          `Run \`runmill gc\` to reconcile.`,
      );
    }
    mkdirSync(input.root, { recursive: true, mode: 0o700 });

    if (isolation === "clone") {
      // Clone from the repository ROOT, not from whatever directory runmill was
      // invoked in. `git clone <repo>/subdir` is not a repository and fails —
      // and it failed silently here, because this used the non-throwing `run`
      // while every other call used `runGit`. The run then died three steps
      // later in #harden, pointing at `git config` instead of the clone.
      const root = await repoRoot(input.sourceRepo);
      const dependencySource = await repoRoot(input.dependencySourceRepo ?? input.sourceRepo);
      // Resolve operator-owned Git identity before creating the run clone. The
      // selected values remain in orchestrator memory: the agent neither gets
      // a signing credential nor gets to rewrite candidate provenance.
      provenance = await resolveCandidateCommitProvenance(root);

      // Production supplies the exact SHA returned by fetchTrustedBase. Direct
      // callers may still name a local ref (tests and offline fixtures), but a
      // missing branch is fetched into Runmill's namespace rather than moving
      // an operator-owned refs/heads entry.
      let sourceRef = input.sourceRef ?? input.baseBranch;
      const present = await tryGit(root, ["rev-parse", "--verify", `${sourceRef}^{commit}`]);
      if (!present.ok && input.sourceRef === undefined) {
        sourceRef = (await fetchTrustedBase(root, input.baseBranch)).commit;
      } else if (!present.ok) {
        throw new Error(
          `trusted base ${JSON.stringify(sourceRef)} is not a commit in ${root}; ` +
            "refusing to substitute the mutable local checkout",
        );
      }

      await runGit(root, [
        "clone",
        "--no-hardlinks",
        "--quiet",
        "--no-checkout",
        root,
        path,
      ]);
      await git(path, "checkout", "-q", "--detach", sourceRef);

      this.#dependencySources.set(path, {
        installedSource: dependencySource,
        cacheRoot: join(dirname(input.root), "dependencies"),
      });
    } else {
      // Worktree mode. Retained because it is cheap for very large
      // repositories, but it shares the parent object store, so the sandbox
      // profile must additionally grant read access to the parent `.git` and
      // the isolation guarantee is correspondingly weaker.
      await runGit(input.sourceRepo, ["worktree", "add", "--quiet", "--detach", path, input.baseBranch]);
    }

    await this.#harden(path);
    await git(path, "checkout", "-q", "-b", input.branch);
    const baseCommit = await git(path, "rev-parse", "HEAD");

    if (provenance === undefined) {
      throw new Error("clone workspace did not capture trusted candidate commit provenance");
    }
    this.#commitProvenance.set(path, provenance);
    this.#trustedGit.set(path, await this.#captureGitControl(path));

    // A detached Git checkout deliberately excludes ignored node_modules.
    // Import the operator's explicit npm install before any agent work, bind
    // it to this exact trusted base, and keep it outside the agent sandbox.
    const dependencySource = this.#dependencySources.get(path);
    try {
      if (dependencySource !== undefined) {
        const prepared = prepareDependencies({
          trustedCheckout: path,
          installedSource: dependencySource.installedSource,
          cacheRoot: dependencySource.cacheRoot,
        });
        if (prepared !== undefined) this.#preparedDependencies.set(path, prepared);
      }
    } catch (error) {
      this.#trustedGit.delete(path);
      this.#runInputs.delete(path);
      this.#commitProvenance.delete(path);
      this.#dependencySources.delete(path);
      this.#preparedDependencies.delete(path);
      rmSync(path, { recursive: true, force: true });
      throw error;
    }

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
    const env = { GIT_INDEX_FILE: scratchIndex };
    try {
      await runGit(workspace.path, ["read-tree", "HEAD"], { env });
      await runGit(workspace.path, ["add", "-A"], { env });
      return await runGit(workspace.path, ["write-tree"], { env });
    } finally {
      rmSync(scratchIndex, { force: true });
    }
  }

  async headSha(workspace: Workspace): Promise<string> {
    return git(workspace.path, "rev-parse", "HEAD");
  }

  async changedFiles(workspace: Workspace): Promise<string[]> {
    const out = await git(workspace.path, "diff", "--name-only", "-z", workspace.baseCommit, "--");
    return nulSeparatedPaths(out);
  }

  async #captureGitControl(path: string): Promise<GitControlSnapshot> {
    const gitDir = await git(path, "rev-parse", "--absolute-git-dir");
    const headRefPath = currentHeadRefPath(gitDir);
    return {
      gitDir,
      headSha: await git(path, "rev-parse", "HEAD"),
      indexTree: await git(path, "write-tree"),
      config: fingerprintPath(join(gitDir, "config")),
      headFile: fingerprintPath(join(gitDir, "HEAD")),
      headRefPath,
      headRef: headRefPath === undefined ? "detached" : fingerprintPath(headRefPath),
      hooks: fingerprintPath(join(gitDir, "hooks")),
      info: fingerprintPath(join(gitDir, "info")),
      objectInfo: fingerprintPath(join(gitDir, "objects", "info")),
      replaceRefs: fingerprintPath(join(gitDir, "refs", "replace")),
      packedRefs: fingerprintPath(join(gitDir, "packed-refs")),
    };
  }

  async #assertTrustedGitControl(workspace: Workspace): Promise<void> {
    const trusted = this.#trustedGit.get(workspace.path);
    if (trusted === undefined) {
      throw new Error(`workspace ${workspace.path} has no trusted Git checkpoint`);
    }

    // Inspect raw paths before invoking Git. A modified local config may name
    // an executable fsmonitor or include file, so asking Git for status first
    // could execute the very control-plane change this guard is meant to stop.
    if (fingerprintPath(join(trusted.gitDir, "config")) !== trusted.config) {
      throw new Error("agent changed the workspace Git config before the orchestrator checkpoint");
    }
    if (fingerprintPath(join(trusted.gitDir, "hooks")) !== trusted.hooks) {
      throw new Error("agent changed workspace Git hooks before the orchestrator checkpoint");
    }
    if (fingerprintPath(join(trusted.gitDir, "info")) !== trusted.info) {
      throw new Error("agent changed workspace Git control files before the orchestrator checkpoint");
    }
    if (fingerprintPath(join(trusted.gitDir, "objects", "info")) !== trusted.objectInfo) {
      throw new Error("agent changed workspace Git object controls before the orchestrator checkpoint");
    }
    if (
      fingerprintPath(join(trusted.gitDir, "HEAD")) !== trusted.headFile ||
      (trusted.headRefPath !== undefined &&
        fingerprintPath(trusted.headRefPath) !== trusted.headRef) ||
      fingerprintPath(join(trusted.gitDir, "refs", "replace")) !== trusted.replaceRefs ||
      fingerprintPath(join(trusted.gitDir, "packed-refs")) !== trusted.packedRefs
    ) {
      throw new Error("agent changed HEAD or Git refs before the orchestrator checkpoint");
    }

    const headSha = await git(workspace.path, "rev-parse", "HEAD");
    if (headSha !== trusted.headSha) {
      throw new Error(
        `agent changed HEAD before the orchestrator checkpoint (expected ${trusted.headSha}, got ${headSha})`,
      );
    }
    const indexTree = await git(workspace.path, "write-tree");
    if (indexTree !== trusted.indexTree) {
      throw new Error("agent changed the Git index before the orchestrator checkpoint");
    }
  }

  #assertRunInputs(workspace: Workspace): void {
    for (const [path, expected] of this.#runInputs.get(workspace.path) ?? []) {
      const absolute = join(workspace.path, path);
      if (!existsSync(absolute) || fingerprintPath(absolute) !== expected) {
        throw new Error(`agent changed orchestrator-owned run input ${path}`);
      }
    }
  }

  async #candidateChangedFiles(workspace: Workspace): Promise<string[]> {
    this.#indexSeq += 1;
    const scratchIndex = join(
      tmpdir(),
      `runmill-scope-${process.pid}-${workspace.runId}-${this.#indexSeq}`,
    );
    const env = { GIT_INDEX_FILE: scratchIndex };
    try {
      await runGit(workspace.path, ["read-tree", "HEAD"], { env });
      await runGit(
        workspace.path,
        ["add", "-A", "--", ".", ...pathspecExclusions()],
        { env },
      );
      const out = await runGit(
        workspace.path,
        ["diff", "--cached", "--name-only", "-z", workspace.baseCommit, "--"],
        { env },
      );
      return nulSeparatedPaths(out);
    } finally {
      rmSync(scratchIndex, { force: true });
    }
  }

  /**
   * The orchestrator owns committing. The worker never stages, commits,
   * signs, or pushes: the completion contract permits an unclean tree, branch
   * protection can require signed commits, and push needs a credential the
   * worker must never hold.
   */
  async checkpoint(
    workspace: Workspace,
    message: string,
    scope: ChangeScope,
  ): Promise<string | undefined> {
    await this.#assertTrustedGitControl(workspace);
    this.#assertRunInputs(workspace);
    const changedPaths = await this.#candidateChangedFiles(workspace);
    assertChangedPathScope(changedPaths, scope);

    // Runtime packet/reviewer files are orchestrator-owned evidence, not part
    // of the candidate. Leaving them out also keeps diff-scope checks focused
    // on the change the agent actually produced.
    await runGit(
      workspace.path,
      ["add", "-A", "--", ".", ...pathspecExclusions()],
    );
    // Bind the decision to the exact index the commit will consume. The
    // scratch-index check above avoids mutating the real index for an obvious
    // violation; this second check closes the gap if a lingering worker edits
    // the tree between the scratch snapshot and `git add`.
    const stagedCandidate = nulSeparatedPaths(
      await runGit(workspace.path, [
        "diff",
        "--cached",
        "--name-only",
        "-z",
        workspace.baseCommit,
        "--",
      ]),
    );
    try {
      assertChangedPathScope(stagedCandidate, scope);
    } catch (error) {
      await runGit(workspace.path, ["read-tree", "HEAD"]);
      throw error;
    }

    const staged = await git(workspace.path, "diff", "--cached", "--name-only", "HEAD", "--");
    if (staged === "") return undefined;
    const provenance = this.#commitProvenance.get(workspace.path);
    if (provenance === undefined) {
      throw new Error(`workspace ${workspace.path} has no trusted candidate commit provenance`);
    }
    // A signer that waits for input must not hang the delivery loop forever.
    // Doctor runs this same operation up front with a shorter bound.
    const sha = await createCandidateCommit(workspace.path, message, provenance, {
      timeoutMs: 60_000,
    });
    // Only this successful orchestrator-authored commit advances trust. A
    // worker-authored commit is rejected above and can never become baseline.
    this.#trustedGit.set(workspace.path, await this.#captureGitControl(workspace.path));
    return sha;
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
    try {
      const dependencySource = this.#dependencySources.get(workspace.path);
      if (dependencySource !== undefined) {
        const prepared = prepareDependencies({
          trustedCheckout: path,
          installedSource: dependencySource.installedSource,
          cacheRoot: dependencySource.cacheRoot,
        });
        if (prepared !== undefined) {
          const ignored = await tryGit(path, ["check-ignore", "--quiet", "--", "node_modules/"]);
          if (!ignored.ok) {
            throw RunmillError.fromCatalog("RM-VERIFY-005", {
              whatHappened:
                "node_modules is not ignored in the candidate checkout; refusing to add " +
                "verification-only dependencies to the measured source tree",
            });
          }
          materializeDependencies(prepared, path);
          this.#preparedDependencies.set(path, prepared);
        }
      }
      return path;
    } catch (error) {
      releaseMaterializedDependencies(path);
      try {
        await git(workspace.path, "worktree", "remove", "--force", path);
      } catch {
        rmSync(path, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async destroyVerificationCheckout(workspace: Workspace, path: string): Promise<void> {
    this.#preparedDependencies.delete(path);
    releaseMaterializedDependencies(path);
    try {
      await git(workspace.path, "worktree", "remove", "--force", path);
    } catch {
      rmSync(path, { recursive: true, force: true });
    }
  }

  /** Nested dependency tree the verification sandbox must keep read-only. */
  verificationDependencyPath(checkoutPath: string): string | undefined {
    return this.#preparedDependencies.has(checkoutPath)
      ? join(checkoutPath, "node_modules")
      : undefined;
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
    this.#recordRunInput(workspace, path);
    return path;
  }

  writeIssueDocument(workspace: Workspace, content: string): string {
    const dir = join(workspace.path, ".runmill", "run");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "issue.md");
    writeFileSync(path, content);
    this.#recordRunInput(workspace, path);
    return path;
  }

  #recordRunInput(workspace: Workspace, absolutePath: string): void {
    const rel = relative(workspace.path, absolutePath).split(sep).join("/");
    const inputs = this.#runInputs.get(workspace.path) ?? new Map<string, string>();
    inputs.set(rel, fingerprintPath(absolutePath));
    this.#runInputs.set(workspace.path, inputs);
  }

  async destroy(workspace: Workspace, sourceRepo?: string): Promise<void> {
    this.#trustedGit.delete(workspace.path);
    this.#runInputs.delete(workspace.path);
    this.#commitProvenance.delete(workspace.path);
    this.#dependencySources.delete(workspace.path);
    this.#preparedDependencies.delete(workspace.path);
    if (workspace.isolation === "separate-git-dir" && sourceRepo !== undefined) {
      const removed = await tryGit(sourceRepo, ["worktree", "remove", "--force", workspace.path]);
      if (removed.ok) return;
    }
    rmSync(workspace.path, { recursive: true, force: true });
  }

  /** Reconcile worktrees and stale run directories after a crash. */
  async prune(sourceRepo: string): Promise<void> {
    await runGit(sourceRepo, ["worktree", "prune"]);
  }
}
