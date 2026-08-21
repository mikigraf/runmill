import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GitRefLease, LeaseConflictError } from "../../src/queue/git-lease.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

let root: string;
let origin: string;
let workA: string;
let workB: string;
let clock: FakeClock;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runmill-lease-"));
  origin = join(root, "origin.git");
  workA = join(root, "a");
  workB = join(root, "b");

  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", origin, workA]);
  git(workA, "config", "user.email", "a@test");
  git(workA, "config", "user.name", "A");
  writeFileSync(join(workA, "README.md"), "seed\n");
  git(workA, "add", "README.md");
  git(workA, "commit", "-m", "seed");
  git(workA, "push", "origin", "main");

  execFileSync("git", ["clone", origin, workB]);
  git(workB, "config", "user.email", "b@test");
  git(workB, "config", "user.name", "B");

  clock = new FakeClock("2026-08-06T10:00:00Z");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function lease(cwd: string, runId: string): GitRefLease {
  return new GitRefLease({ cwd, runId, clock, ttlMinutes: 20, hostId: `host-${runId}`, pid: 1234 });
}

describe("GitRefLease.acquire — when the push fails for a reason that is not contention", () => {
  /**
   * A push can fail because someone else holds the lease, or because the
   * remote is gone, unreachable, or read-only for this credential. Only the
   * first is contention. Reporting the others as "already leased" sends the
   * operator looking for a competing worker that does not exist, and because a
   * quarantine trips the breaker, one unreachable remote stops the daemon with
   * a sentence that is not true.
   */
  /** Make every push to `origin` fail the way a read-only credential does. */
  function rejectPushes(): void {
    const hook = join(origin, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'remote: write access denied' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
  }

  it("does not report a rejected push as contention when nothing holds the lease", async () => {
    rejectPushes();

    const error = await lease(workA, "run_a")
      .acquire("ENG-1")
      .then(() => undefined)
      .catch((err: unknown) => err);

    expect(error).toBeDefined();
    expect((error as Error).message).not.toMatch(/already leased/i);
  });

  it("surfaces the underlying git failure so the operator can act on it", async () => {
    rejectPushes();

    const error = await lease(workA, "run_a")
      .acquire("ENG-1")
      .then(() => undefined)
      .catch((err: unknown) => err);

    expect(error).not.toBeInstanceOf(LeaseConflictError);
    // Names the issue it was claiming and what git actually said.
    expect((error as Error).message).toMatch(/ENG-1/);
    expect((error as Error).message).toMatch(/denied|reject|remote/i);
  });

  it("still reports genuine contention as a lease conflict", async () => {
    // The regression guard for the fix above: real contention must keep its
    // own error type, because the daemon retries it differently.
    await lease(workA, "run_a").acquire("ENG-1");

    await expect(lease(workB, "run_b").acquire("ENG-1")).rejects.toBeInstanceOf(
      LeaseConflictError,
    );
  });
});

describe("GitRefLease.acquire", () => {
  it("creates the lease ref and returns generation 1", async () => {
    const held = await lease(workA, "run_a").acquire("ENG-1");
    expect(held.generation).toBe(1);
    expect(held.issueId).toBe("ENG-1");
    expect(held.refName).toBe("refs/runmill/leases/ENG-1");

    const refs = git(workA, "ls-remote", "origin", "refs/runmill/leases/ENG-1");
    expect(refs).not.toBe("");
  });

  it("records expiry TTL ahead of acquisition, not the run budget", async () => {
    const held = await lease(workA, "run_a").acquire("ENG-1");
    expect(held.acquiredAt).toBe("2026-08-06T10:00:00.000Z");
    expect(held.expiresAt).toBe("2026-08-06T10:20:00.000Z");
  });

  it("keeps the placeholder identity and epoch date confined to internal lease objects", async () => {
    const held = await lease(workA, "run_a").acquire("ENG-1");
    expect(git(workA, "show", "-s", "--format=%an%x00%ae%x00%at", held.objectId)).toBe(
      ["runmill", "runmill@localhost", "0"].join("\0"),
    );
  });

  it("EXCLUDES a second claimant: this is the mutual exclusion FR-04 requires", async () => {
    // Two independent clones, both believing the issue is free. Only one may win.
    await lease(workA, "run_a").acquire("ENG-1");
    await expect(lease(workB, "run_b").acquire("ENG-1")).rejects.toBeInstanceOf(LeaseConflictError);
  });

  it("reports who holds the lease when it loses", async () => {
    await lease(workA, "run_a").acquire("ENG-1");
    try {
      await lease(workB, "run_b").acquire("ENG-1");
      expect.unreachable("second claimant should lose");
    } catch (err) {
      expect(err).toBeInstanceOf(LeaseConflictError);
      expect((err as LeaseConflictError).heldBy).toBe("run_a");
    }
  });

  it("lets a different issue be claimed concurrently", async () => {
    await lease(workA, "run_a").acquire("ENG-1");
    const other = await lease(workB, "run_b").acquire("ENG-2");
    expect(other.generation).toBe(1);
  });

  it("stores host, pid, and run identity for liveness decisions", async () => {
    await lease(workA, "run_a").acquire("ENG-1");
    const held = await lease(workB, "run_b").read("ENG-1");
    expect(held).toMatchObject({ runId: "run_a", hostId: "host-run_a", pid: 1234 });
  });
});

describe("GitRefLease.heartbeat", () => {
  it("extends expiry without changing the generation", async () => {
    const l = lease(workA, "run_a");
    const held = await l.acquire("ENG-1");
    clock.advanceMinutes(5);
    const beat = await l.heartbeat(held);
    expect(beat.generation).toBe(held.generation);
    expect(beat.expiresAt).toBe("2026-08-06T10:25:00.000Z");
    expect(beat.heartbeatAt).toBe("2026-08-06T10:05:00.000Z");
  });

  it("survives a long IMPLEMENTING phase that would otherwise expire the lease", async () => {
    // Renewing only at state transitions guarantees expiry during the two
    // longest states. A timer-driven heartbeat is what prevents it.
    const l = lease(workA, "run_a");
    let held = await l.acquire("ENG-1");
    for (let i = 0; i < 12; i += 1) {
      clock.advanceMinutes(5);
      held = await l.heartbeat(held);
    }
    expect(new Date(held.expiresAt).getTime()).toBeGreaterThan(clock.now().getTime());
  });

  it("refuses to heartbeat a lease taken over by someone else", async () => {
    const l = lease(workA, "run_a");
    const held = await l.acquire("ENG-1");

    clock.advanceMinutes(60); // well past TTL
    await lease(workB, "run_b").takeover("ENG-1");

    await expect(l.heartbeat(held)).rejects.toBeInstanceOf(LeaseConflictError);
  });
});

describe("GitRefLease.assertHeld (fencing)", () => {
  it("passes while the run still owns the current generation", async () => {
    const l = lease(workA, "run_a");
    const held = await l.acquire("ENG-1");
    await expect(l.assertHeld(held)).resolves.toBeUndefined();
  });

  it("throws once a newer generation exists, even though the run is still alive", async () => {
    // This is the fence: a partitioned worker that resumes must not be able to
    // push, open a PR, enqueue, or merge after ownership moved.
    const l = lease(workA, "run_a");
    const held = await l.acquire("ENG-1");
    clock.advanceMinutes(60);
    await lease(workB, "run_b").takeover("ENG-1");
    await expect(l.assertHeld(held)).rejects.toBeInstanceOf(LeaseConflictError);
  });
});

describe("GitRefLease.takeover", () => {
  it("refuses while the current lease is still live", async () => {
    await lease(workA, "run_a").acquire("ENG-1");
    clock.advanceMinutes(1);
    await expect(lease(workB, "run_b").takeover("ENG-1")).rejects.toThrow(/still live/i);
  });

  it("succeeds once the heartbeat is stale beyond the grace window", async () => {
    await lease(workA, "run_a").acquire("ENG-1");
    clock.advanceMinutes(60);
    const taken = await lease(workB, "run_b").takeover("ENG-1");
    expect(taken.runId).toBe("run_b");
  });

  it("increments the generation so the prior holder is fenced out", async () => {
    await lease(workA, "run_a").acquire("ENG-1");
    clock.advanceMinutes(60);
    const taken = await lease(workB, "run_b").takeover("ENG-1");
    expect(taken.generation).toBe(2);
  });

  it("carries prior state and assignee forward for restoration", async () => {
    const l = lease(workA, "run_a");
    await l.acquire("ENG-1", { priorStateId: "Todo", priorAssigneeId: "human-1" });
    clock.advanceMinutes(60);
    const taken = await lease(workB, "run_b").takeover("ENG-1");
    expect(taken.priorStateId).toBe("Todo");
    expect(taken.priorAssigneeId).toBe("human-1");
  });
});

describe("GitRefLease.release", () => {
  it("deletes the ref so the issue can be claimed again", async () => {
    const l = lease(workA, "run_a");
    const held = await l.acquire("ENG-1");
    await l.release(held);
    expect(git(workA, "ls-remote", "origin", "refs/runmill/leases/ENG-1")).toBe("");
    await expect(lease(workB, "run_b").acquire("ENG-1")).resolves.toBeDefined();
  });

  it("refuses to release a lease the run no longer owns", async () => {
    const l = lease(workA, "run_a");
    const held = await l.acquire("ENG-1");
    clock.advanceMinutes(60);
    await lease(workB, "run_b").takeover("ENG-1");
    await expect(l.release(held)).rejects.toBeInstanceOf(LeaseConflictError);
  });
});
