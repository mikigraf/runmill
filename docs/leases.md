# The lease model

> Implemented in [`src/queue/git-lease.ts`](../src/queue/git-lease.ts).

The lease is the ownership boundary in the **Queue** stage of Runmill's delivery loop.

Two runmill workers pointed at the same backlog must never work the same issue. That sounds like
a job for the issue tracker — move it to "In Progress", assign the bot, and check before starting.
It is not, and the reason is worth being precise about.

## Why not the backlog

Issue tracker APIs offer independent mutations and independent reads. They do not offer
compare-and-swap. So the best available protocol is:

1. Read the issue. Is it unassigned and in an eligible state?
2. Transition it to "In Progress" and assign the bot.
3. Read it back. Is it assigned to us?

Two workers running this concurrently both answer yes to step 3. They transition the same issue to
the same state and assign the same bot, so the read-back is byte-identical for both. The
verification cannot distinguish "I claimed this" from "someone identical to me claimed this."

Adding a delay, a jitter, or a second read does not fix it. There is no point in the sequence
where a participant learns something the other did not. Mutual exclusion requires an operation
that atomically fails for the loser, and the backlog API has none.

## Why a git ref

`git push` of a ref that does not yet exist is an **atomic server-side create**. If the ref
already exists, the push is rejected. That rejection is the mutual exclusion — one worker gets an
exit code 0, every other worker gets a non-zero, and the server decided.

`--force-with-lease` supplies the other half: compare-and-swap for updates, so a worker can only
move a ref it still owns.

This is real distributed mutual exclusion, across hosts, using a credential runmill already holds
and a server it already depends on. No new infrastructure, no lock service, no database.

```
refs/runmill/leases/<issue-id>
```

The ref points at an **orphan commit** whose message is the lease record as JSON:

```ts
async #writeRecord(record: LeaseRecord): Promise<string> {
  return this.#git("commit-tree", EMPTY_TREE, "-m", JSON.stringify(record));
}
```

`EMPTY_TREE` is git's well-known empty tree object. The commit has no parent and no content, so it
can never fast-forward an unrelated commit — which is precisely why a second `acquire` is rejected
rather than silently merging. Leases carry no files and never touch a branch.

## The record

```ts
interface LeaseRecord {
  issueId, runId, repo,
  generation,                    // the fencing token
  acquiredAt, expiresAt, heartbeatAt,
  hostId, pid, bootId,           // who holds it
  priorStateId, priorAssigneeId, // what to restore on release
}
```

`priorStateId` and `priorAssigneeId` travel *with the lease*, not in local state. A worker whose
disk is gone still leaves behind, on the server, everything needed to put the issue back the way
it was found.

## The four operations

### acquire — the atomic claim

```ts
await this.#git("push", this.#remote, `${objectId}:${leaseRefName(issueId)}`);
```

Succeeds only if the ref did not exist. On rejection, runmill reads the existing record and raises
`LeaseConflictError` naming the current holder — a contended issue reports *who* has it, not just
that the claim failed.

### heartbeat — extending without re-claiming

Renewal is a compare-and-swap that keeps the same `generation`.

Critically, **it is driven by a timer, not by state transitions**:

```
Driven by a timer, not by state transitions: the two longest states
(IMPLEMENTING and CI_WAIT) contain no transitions, so checkpoint-only
renewal guarantees expiry while the run is still legitimately working.
```

An agent implementing a change and a pull request waiting on CI are the two longest phases of a
run, and neither emits transitions. Renewing only at checkpoints would guarantee that every
long-running run loses its lease precisely while doing the thing it was told to do.

### assertHeld — the fence

```ts
async assertHeld(held: HeldLease): Promise<void> {
  const current = await this.read(held.issueId);
  if (current === undefined) throw new LeaseConflictError(...);
  if (current.runId !== held.runId || current.generation !== held.generation) {
    throw new LeaseConflictError(`fenced out of ${held.issueId}: ...`);
  }
}
```

Called immediately before **every** external mutation — pushing a branch, opening a pull request,
merging, transitioning the backlog.

This is the part that makes expiry safe. A lease that merely expires does not stop the original
holder: a worker that was paused, swapped, or partitioned does not know time passed, and it
resumes believing it still owns the issue. Timeouts alone produce two workers who both believe
they hold the lease, and the second one merges.

Checking a monotonically increasing generation before every side effect is the fix. The
partitioned worker's next mutation attempt fails, because the generation it holds is no longer
current. It cannot act on stale ownership no matter how long it was gone or how confident it is.

> This is the standard fencing-token result: leases without fencing tokens are not safe under
> arbitrary process pauses, and no timeout value makes them safe.

### takeover — reclaiming abandoned work

```ts
if (!this.#isStale(current)) {
  throw new Error(`lease for ${issueId} is still live (...); refusing to steal`);
}
const next = this.#buildRecord(issueId, current.generation + 1, { ... });
```

Never silent, and never merely "expired":

- Staleness must exceed `expiresAt` **plus a grace window** (default 10 minutes).
- The generation is **incremented**, which fences the previous holder out permanently.
- `priorStateId` / `priorAssigneeId` are carried forward, so the takeover inherits the obligation
  to restore the issue.

### release — CAS-guarded deletion

`release` calls `assertHeld` first, then deletes the ref with `--force-with-lease`. A run that
lost its lease cannot delete the lease its successor now holds.

## What this does and does not protect

**Does:** two workers cannot both start the same issue; a partitioned worker cannot mutate
anything after ownership moves; an abandoned issue becomes available without a human; the backlog
is restored to its prior state even if the original worker never comes back.

**Does not:** it is not a general-purpose lock service, and it says nothing about two workers
touching the same *files* from different issues. Overlapping changes are a merge-conflict problem,
handled by git, CI, and review.

## Operating notes

Lease refs live under `refs/runmill/`, outside `refs/heads/` and `refs/tags/`, so they do not
appear in branch listings and are not fetched by default.

```bash
git ls-remote origin 'refs/runmill/leases/*'    # who holds what
runmill inspect <run-id>                        # the lease this run holds
runmill list --needs-attention                  # runs blocked on a human
```

A lease ref that outlives its run is cleaned up by the next `takeover` after the grace window. To
clear one by hand — only when you are certain no worker is live:

```bash
git push origin :refs/runmill/leases/ENG-123
```

## See also

- [Run lifecycle](./lifecycle.md) — where the fence sits among the run states, and the outbox
- [Autonomy and merge gates](./autonomy.md) — the lease is gate 1 of 7
- [Errors](./errors.md#rm-lease-001) — `RM-LEASE-001`
