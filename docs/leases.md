# The lease model

> Implemented in [`src/queue/git-lease.ts`](../src/queue/git-lease.ts).

The lease is the ownership boundary in the **Queue** stage of Runmill's delivery loop.

Two runmill workers pointed at the same backlog must never work the same issue. That sounds like
a job for the issue tracker: move it to "In Progress", assign the bot, and check before starting.
It isn't, and the reason is worth getting precise about.

## Why not the backlog

Issue tracker APIs give you independent mutations and independent reads. They don't give you
compare-and-swap. So the best protocol you can build is:

1. Read the issue. Is it unassigned and in an eligible state?
2. Transition it to "In Progress" and assign the bot.
3. Read it back. Is it assigned to us?

Two workers running this at the same time both answer yes to step 3. They move the same issue to
the same state and assign the same bot, so the read-back is byte-identical for both. The check
can't tell "I claimed this" apart from "someone identical to me claimed this."

A delay, jitter, or a second read won't fix it. At no point in the sequence does one participant
learn something the other didn't. Mutual exclusion needs an operation that atomically fails for
the loser, and the backlog API doesn't have one.

## Why a git ref

`git push` of a ref that doesn't exist yet is an **atomic server-side create**. If the ref
already exists, the push is rejected. That rejection is the mutual exclusion. One worker gets exit
code 0, every other worker gets a non-zero, and the server made the call.

`--force-with-lease` supplies the other half: compare-and-swap for updates, so a worker can only
move a ref it still owns.

That gives us real distributed mutual exclusion across hosts, using a credential runmill already
holds and a server it already depends on. We didn't have to add a lock service or a database.

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
can never fast-forward an unrelated commit. That's exactly why a second `acquire` gets rejected
instead of silently merging. Leases carry no files and never touch a branch.

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

`priorStateId` and `priorAssigneeId` travel *with the lease* instead of living in local state.
Even if a worker's disk is gone, the server still has everything needed to put the issue back the
way it was found.

## Durable mutation protocol

The remote ref is the distributed lock, and the local database is the crash journal. Runmill never
infers the state of one from an unacknowledged write to the other. Each local lease row has one of four phases:

| Phase | Meaning |
|---|---|
| `acquiring` | The exact object and create intent were committed before `git push` |
| `held` | `git ls-remote` returned exactly the intended object for the exact lease ref |
| `releasing` | The exact expected object and delete intent were committed before the CAS delete |
| `released` | An exact observation proved the remote ref absent |

An unavailable or malformed observation leaves the intent pending. A different object is
contradictory evidence and also leaves the local fence active. Legacy active rows are migrated to
unresolved `acquiring` rows, because they don't hold enough evidence to claim a remote write
completed.

## The four operations

### acquire — the atomic claim

```ts
const prepared = await lease.prepareAcquire(issueId);
store.beginLeaseAcquisition({ ...prepared, repo: target.repo }); // durable `acquiring` intent
await lease.publishAcquire(prepared);
const observed = await lease.observeObjectId(issueId);
store.reconcileLeaseObservation({ ...prepared, observedObjectId: observed ?? null });
```

This succeeds only if the ref did not exist. On rejection, runmill reads the existing record and
raises `LeaseConflictError` naming the current holder, so a contended issue tells you *who* has it
as well as that the claim failed. Authority is granted only after exact observation returns the
object that was prepared and journaled. If the push applied but its response was lost, that
observation safely confirms the acquisition without a second push.

### heartbeat — available primitive, not a daemon timer

Renewal is a compare-and-swap that keeps the same `generation`.

The compare-and-swap heartbeat primitive is implemented and tested, but this developer preview
doesn't run a background renewal timer. Instead, live lease TTL comes from
`budgets.max_wall_minutes_per_issue` and is set past the whole-run deadline. The budget stops further
delivery effects before a legitimate run can become eligible for takeover. Don't read automatic
crash recovery into the existence of the heartbeat method.

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

This runs immediately before **every** external mutation: pushing a branch, opening a pull
request, merging, transitioning the backlog.

It's the part that makes expiry safe. Expiry on its own doesn't stop the original holder. A worker
that was paused, swapped, or partitioned doesn't know time passed, and it resumes believing it still
owns the issue. With timeouts alone you get two workers who both think they hold the lease, and the
second one merges.

The fix is to check a monotonically increasing generation before every side effect. The
partitioned worker's next mutation attempt fails because the generation it holds is no longer
current. However long it was gone and however sure of itself it is, it can't act on stale
ownership.

> This is the standard fencing-token result: leases without fencing tokens are not safe under
> arbitrary process pauses, and no timeout value makes them safe.

### takeover — tested primitive, manual recovery in the preview

```ts
if (!this.#isStale(current)) {
  throw new Error(`lease for ${issueId} is still live (...); refusing to steal`);
}
const next = this.#buildRecord(issueId, current.generation + 1, { ... });
```

The primitive is never silent, and "expired" alone is never enough:

- Staleness must exceed `expiresAt` **plus a grace window** (default 10 minutes).
- The generation is **incremented**, which fences the previous holder out permanently.
- `priorStateId` / `priorAssigneeId` are carried forward, so the takeover inherits the obligation
  to restore the issue.

The daemon doesn't invoke takeover or restore a crash-abandoned issue automatically yet. Doing
half of that protocol is worse than stopping. Deleting a ref without restoring the backlog can leave
the issue looking owned forever, and restoring without fencing can race a worker that is only
paused. Use the explicit manual procedure under Operating notes.

### release — CAS-guarded deletion

Release calls `assertHeld`, commits a `releasing` intent with the exact expected object, and then
deletes the ref with `--force-with-lease`. A run that lost its lease cannot delete the lease its
successor now holds. Exact absence completes release even when the push response was lost. If the
expected object is still there, the row returns to `held`. A different object or an unavailable
observation stays fenced for manual reconciliation.

## What this does and does not protect

What it does protect: two workers cannot both start the same issue. Every orchestrator-owned
external mutation is fenced, and a worker cannot mutate anything after ownership moves. An ordinary
failed attempt before PR creation restores its prior backlog state and assignee while it still
holds the lease. If any external mutation has an ambiguous outcome, Runmill keeps the remote lease
as well as the local outbox row, because a database on one host cannot fence a worker on another
host.

What it doesn't: the preview does not automatically recover a lease after process death. It isn't a
general-purpose lock service, and it says nothing about two workers touching the same *files* from
different issues. Overlapping changes are a merge-conflict problem, and git, CI, and review handle
those.

## Operating notes

Lease refs live under `refs/runmill/`, outside `refs/heads/` and `refs/tags/`, so they don't
show up in branch listings and aren't fetched by default.

```bash
git ls-remote origin 'refs/runmill/leases/*'    # who holds what
runmill inspect <run-id>                        # the lease this run holds
runmill list --needs-attention                  # runs blocked on a human
```

In this preview, a lease ref that outlives its process needs a person. Do this only when you are
certain the worker is dead:

```bash
runmill leases list
# Restore the issue's prior workflow state and assignee in the backlog first.
git push origin :refs/runmill/leases/ENG-123
runmill leases resolve ENG-123 --confirm-remote-cleared
```

The final command refuses unless `git ls-remote` proves that exact remote ref is absent. Until both
remote and local records are reconciled, issue selection stays blocked. That is slower than silently
stealing work and racing a paused process, and it's meant to be.

If `runmill effects list` also reports an ambiguous mutation, inspect that named remote system and
resolve the effect first. Restore backlog ownership only when the observed result requires it, then
delete the exact lease ref and clear the local lease row. Never clear the distributed fence just
because a client call returned an error. The request may have applied before its response was lost.

## See also

- [Run lifecycle](./lifecycle.md): where the fence sits among the run states, and the outbox
- [Autonomy and merge gates](./autonomy.md): the lease is gate 1 of 7
- [Errors](./errors.md#rm-lease-001): `RM-LEASE-001`
