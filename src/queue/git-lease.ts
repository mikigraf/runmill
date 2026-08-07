import type { Clock } from "../platform/clock.js";
import { git } from "../platform/git.js";

/**
 * Distributed lease built on an atomic git ref.
 *
 * The backlog cannot provide mutual exclusion: its API has no compare-and-swap,
 * so a protocol of independent mutations followed by a read lets two processes
 * both "verify" ownership — they transition the same state and assign the same
 * bot, so the verification is identical for both.
 *
 * `git push` of a *new* ref is an atomic server-side create that fails when the
 * ref already exists, and `--force-with-lease` gives compare-and-swap for
 * updates. That is real mutual exclusion, across hosts, with a credential
 * runmill already holds.
 */

export interface LeaseRecord {
  readonly issueId: string;
  readonly runId: string;
  readonly repo: string;
  readonly generation: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly heartbeatAt: string;
  readonly hostId: string;
  readonly pid: number;
  readonly bootId?: string | undefined;
  readonly priorStateId?: string | undefined;
  readonly priorAssigneeId?: string | undefined;
}

export interface HeldLease extends LeaseRecord {
  /** Ref name, for diagnostics and cleanup. */
  readonly refName: string;
  /** Object id the ref pointed at when this handle was minted (the CAS token). */
  readonly objectId: string;
}

export class LeaseConflictError extends Error {
  readonly code = "RM-LEASE-001";
  readonly heldBy: string | undefined;
  readonly generation: number | undefined;

  constructor(message: string, heldBy?: string, generation?: number) {
    super(message);
    this.name = "LeaseConflictError";
    this.heldBy = heldBy;
    this.generation = generation;
  }
}

export interface GitRefLeaseOptions {
  readonly cwd: string;
  readonly runId: string;
  readonly clock: Clock;
  readonly ttlMinutes: number;
  readonly hostId: string;
  readonly pid: number;
  readonly bootId?: string | undefined;
  readonly remote?: string | undefined;
  /** How far past expiry a lease must be before takeover is permitted. */
  readonly takeoverGraceMinutes?: number | undefined;
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function leaseRefName(issueId: string): string {
  return `refs/runmill/leases/${issueId}`;
}

export class GitRefLease {
  readonly #opts: GitRefLeaseOptions;

  constructor(options: GitRefLeaseOptions) {
    this.#opts = options;
  }

  get #remote(): string {
    return this.#opts.remote ?? "origin";
  }

  async #git(...args: string[]): Promise<string> {
    return git(this.#opts.cwd, args, { runmillIdentity: true });
  }

  /** Build the orphan commit whose message carries the lease record. */
  async #writeRecord(record: LeaseRecord): Promise<string> {
    return this.#git("commit-tree", EMPTY_TREE, "-m", JSON.stringify(record));
  }

  async #remoteObjectId(issueId: string): Promise<string | undefined> {
    const out = await this.#git("ls-remote", this.#remote, leaseRefName(issueId));
    if (out === "") return undefined;
    const first = out.split("\n")[0];
    return first?.split(/\s+/)[0];
  }

  /** Read the current lease record from the remote, or undefined if unheld. */
  async read(issueId: string): Promise<HeldLease | undefined> {
    const objectId = await this.#remoteObjectId(issueId);
    if (objectId === undefined) return undefined;

    // Bring the object local so it can be read. A forced fetch into a local
    // mirror ref keeps this side-effect-free for the working tree.
    const localRef = `refs/runmill/remote-leases/${issueId}`;
    await this.#git("fetch", "--quiet", this.#remote, `+${leaseRefName(issueId)}:${localRef}`);
    const message = await this.#git("log", "-1", "--format=%B", objectId);
    const record = JSON.parse(message) as LeaseRecord;
    return { ...record, refName: leaseRefName(issueId), objectId };
  }

  #buildRecord(
    issueId: string,
    generation: number,
    extra: { priorStateId?: string | undefined; priorAssigneeId?: string | undefined },
    acquiredAt?: string,
  ): LeaseRecord {
    const now = this.#opts.clock.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.#opts.ttlMinutes * 60_000).toISOString();
    return {
      issueId,
      runId: this.#opts.runId,
      repo: this.#remote,
      generation,
      acquiredAt: acquiredAt ?? nowIso,
      expiresAt,
      heartbeatAt: nowIso,
      hostId: this.#opts.hostId,
      pid: this.#opts.pid,
      bootId: this.#opts.bootId,
      priorStateId: extra.priorStateId,
      priorAssigneeId: extra.priorAssigneeId,
    };
  }

  /**
   * Atomically claim the issue.
   *
   * Pushing a ref that does not exist creates it; if it already exists the
   * push is rejected, because an orphan commit can never fast-forward an
   * unrelated one. That rejection IS the mutual exclusion.
   */
  async acquire(
    issueId: string,
    extra: { priorStateId?: string; priorAssigneeId?: string } = {},
  ): Promise<HeldLease> {
    const record = this.#buildRecord(issueId, 1, extra);
    const objectId = await this.#writeRecord(record);

    try {
      await this.#git("push", this.#remote, `${objectId}:${leaseRefName(issueId)}`);
    } catch (cause) {
      const existing = await this.read(issueId);
      throw new LeaseConflictError(
        `issue ${issueId} is already leased${existing ? ` by ${existing.runId}` : ""}`,
        existing?.runId,
        existing?.generation,
      );
    }

    return { ...record, refName: leaseRefName(issueId), objectId };
  }

  /** Compare-and-swap the ref, failing if anyone else moved it. */
  async #compareAndSwap(held: HeldLease, next: LeaseRecord): Promise<HeldLease> {
    const objectId = await this.#writeRecord(next);
    const ref = leaseRefName(next.issueId);
    try {
      await this.#git(
        "push",
        `--force-with-lease=${ref}:${held.objectId}`,
        this.#remote,
        `${objectId}:${ref}`,
      );
    } catch {
      const current = await this.read(next.issueId);
      throw new LeaseConflictError(
        `lease for ${next.issueId} moved: expected generation ${held.generation} held by ` +
          `${held.runId}, found ${current ? `generation ${current.generation} held by ${current.runId}` : "no lease"}`,
        current?.runId,
        current?.generation,
      );
    }
    return { ...next, refName: ref, objectId };
  }

  /**
   * Extend expiry without changing ownership.
   *
   * Driven by a timer, not by state transitions: the two longest states
   * (IMPLEMENTING and CI_WAIT) contain no transitions, so checkpoint-only
   * renewal guarantees expiry while the run is still legitimately working.
   */
  async heartbeat(held: HeldLease): Promise<HeldLease> {
    const next = this.#buildRecord(
      held.issueId,
      held.generation,
      { priorStateId: held.priorStateId, priorAssigneeId: held.priorAssigneeId },
      held.acquiredAt,
    );
    return this.#compareAndSwap(held, next);
  }

  /**
   * The fence. Called immediately before every external mutation — push, PR
   * creation, queue enqueue, merge, backlog completion — so a partitioned
   * worker that resumes cannot act after ownership moved.
   */
  async assertHeld(held: HeldLease): Promise<void> {
    const current = await this.read(held.issueId);
    if (current === undefined) {
      throw new LeaseConflictError(`lease for ${held.issueId} no longer exists`);
    }
    if (current.runId !== held.runId || current.generation !== held.generation) {
      throw new LeaseConflictError(
        `fenced out of ${held.issueId}: this run holds generation ${held.generation}, ` +
          `current is generation ${current.generation} held by ${current.runId}`,
        current.runId,
        current.generation,
      );
    }
  }

  #isStale(record: LeaseRecord): boolean {
    const grace = (this.#opts.takeoverGraceMinutes ?? 10) * 60_000;
    const deadline = new Date(record.expiresAt).getTime() + grace;
    return this.#opts.clock.now().getTime() > deadline;
  }

  /**
   * Take a stale lease, fencing the previous holder out by incrementing the
   * generation. Never silent: staleness must exceed expiry plus a grace
   * window, and the prior holder's restoration targets are carried forward.
   */
  async takeover(issueId: string): Promise<HeldLease> {
    const current = await this.read(issueId);
    if (current === undefined) {
      return this.acquire(issueId);
    }
    if (!this.#isStale(current)) {
      throw new Error(
        `lease for ${issueId} is still live (expires ${current.expiresAt}, held by ${current.runId}); ` +
          `refusing to steal`,
      );
    }
    const next = this.#buildRecord(issueId, current.generation + 1, {
      priorStateId: current.priorStateId,
      priorAssigneeId: current.priorAssigneeId,
    });
    return this.#compareAndSwap(current, next);
  }

  /** Release, but only if this run still owns the current generation. */
  async release(held: HeldLease): Promise<void> {
    await this.assertHeld(held);
    const ref = leaseRefName(held.issueId);
    await this.#git("push", `--force-with-lease=${ref}:${held.objectId}`, this.#remote, `:${ref}`);
  }
}
