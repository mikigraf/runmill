# Run lifecycle

> Implemented in [`src/orchestrator/orchestrator.ts`](../src/orchestrator/orchestrator.ts) and
> [`src/state/store.ts`](../src/state/store.ts).

A run is one issue moving from the backlog to a pull request, and possibly to a merge. It is a
state machine with durable transitions, so a crash is a resumable event rather than an
investigation.

## States

```
DISCOVERED → ELIGIBILITY_CHECKED → CLAIMED → WORKSPACE_READY → TASK_PACKET_READY
    → IMPLEMENTING → LOCAL_VERIFY → LOCAL_REVIEW → [FIXING ⟲] → PR_READY
    → PUSHED → PR_OPEN → CI_WAIT → PR_REVIEW → [FIXING ⟲]
    → MERGE_READY → MERGED → BACKLOG_UPDATED → CLEANUP
```

Terminal: `PR_DELIVERED` · `COMPLETED` · `AWAITING_APPROVAL` · `NEEDS_HUMAN` · `QUARANTINED`

| Transition | What has to be true |
|---|---|
| `→ CLAIMED` | The [git-ref lease](./leases.md) was acquired atomically |
| `→ WORKSPACE_READY` | An isolated clone exists and the [sandbox](./sandbox.md) was constructed *and verified* |
| `→ TASK_PACKET_READY` | The bounded context packet is built — issue, repo conventions, check manifest |
| `→ LOCAL_VERIFY` | The agent produced a candidate commit |
| `→ LOCAL_REVIEW` | The [coverage contract](./verification.md) is satisfied |
| `→ PR_READY` | The review verdict passed its cross-check, with no unresolved blocking findings |
| `→ CI_WAIT` | The PR is open and branch protection was read successfully |
| `→ PR_REVIEW` | Every required CI context reported success |
| `→ MERGE_READY` | All seven [gates](./autonomy.md#the-seven-gates) passed |

`FIXING` loops back to `LOCAL_REVIEW` up to `review.max_fix_iterations` times. Exhausting it ends
in `NEEDS_HUMAN`, not in a merge.

### Two reviews, not one

`LOCAL_REVIEW` and `PR_REVIEW` are different reviews of different artifacts, and the second is not
a retry of the first.

| | Sees | Bounded by |
|---|---|---|
| `LOCAL_REVIEW` | The working tree as the implementer left it | `review.max_fix_iterations` |
| `PR_REVIEW` | The pull request after CI reported — the change in the form a human would merge | `budgets.max_agent_invocations.pr_review` / `pr_fixer` |

`PR_REVIEW` runs **after** CI so it can read what CI actually said, and **before** the merge gate
so a blocking finding stops a merge rather than annotating one. Findings that exist only in the
final form — an interaction with something that landed on the base branch meanwhile — are invisible
to the earlier pass.

A blocking finding dispatches a fixer, and the fix is re-verified against the full
[coverage contract](./verification.md) before it goes back onto the branch: a fix is new code, and
new code has not been proven. Two things end the loop rather than continuing it:

- **The fixer changed nothing.** The next review would reach the same verdict, so looping again
  would only spend money.
- **An unparseable review.** Its conclusion is unknown, and unknown is not permission to merge.

The reviewer is never given a writable path. Something whose only job is to form an opinion has no
business editing what it judges.

## The task packet

The agent does not get the repository and a prompt. It gets a **bounded packet**: the issue, the
repository conventions, the check manifest it must satisfy, and the entry files named in
`context.entry_files`, capped at `context.max_initial_bytes` (50 KB by default), with progressive
disclosure for the rest.

The output contract is set per role — implementer, reviewer, fixer — so the reviewer is *required*
to emit structured findings rather than prose that has to be parsed hopefully. An event shape the
adapter does not recognize quarantines the run rather than being parsed best-effort:
misreading a tool call or a terminal result is worse than stopping
([`RM-PROVIDER-001`](./errors.md#rm-provider-001)).

## The side-effect outbox

Every external mutation — a backlog transition, a PR creation, a merge — is written down **before**
it is attempted:

```ts
/**
 * Record the intent to perform an external mutation.
 *
 * Called BEFORE the remote call. A crash between this row and the remote
 * response leaves a durable record naming the run and the operation, so
 * startup reconciliation can query the remote and decide whether the effect
 * landed rather than assuming it did not.
 */
intendSideEffect(input: { runId, system, operation, target }): string
```

The ordering is the whole point, and it follows from one fact:

> **A failed request does not prove the effect did not happen.**

A timeout, a dropped connection, or a 500 after the server committed all look identical to a
request that never arrived. Code that writes its record *after* success will, on exactly those
paths, have performed a merge it has no memory of.

So intent is durable first. On restart, a row still marked `intended` is a question — *did this
land?* — that gets answered by querying the remote, not by assuming. Effects are keyed by
`sha256(runId + operation + target)`, so reconciliation is idempotent and a retry cannot double-apply.

This is why a pending effect stays pending rather than being retried blindly, and why
`runmill inspect` lists them.

## Crash recovery

State transitions and side-effect intents are committed to SQLite as they happen. After a crash:

```bash
runmill list                 # every run and its state
runmill list --needs-attention
runmill inspect <run-id>     # state, transitions, events, pending effects
runmill resume <run-id>
```

Three cases:

- **Mid-agent** — the workspace is preserved on any non-clean exit, deliberately, so it can be
  inspected. `COMPLETED` and `PR_DELIVERED` clean up eagerly; `NEEDS_HUMAN`, `QUARANTINED`, and
  `AWAITING_APPROVAL` keep their trees, because there the tree is the evidence.
  `runmill gc` reconciles whatever a crash left behind.
- **Mid-mutation** — the outbox row is reconciled against the remote.
- **Lease lost** — the run is fenced out and stops. Another worker owns the issue now, and the
  correct behavior is to do nothing rather than race.

## Budgets and breakers

A run stops when any bound is reached:

```yaml
budgets:
  max_cost_usd_per_issue: 5.00
  max_wall_minutes_per_issue: 240
  daily_cost_usd: 100.00
  max_agent_invocations:
    total: 14
    implementer: 1
    local_review: 4
    fixer: 3
    pr_review: 3
    pr_fixer: 2
```

Per-role invocation caps matter more than the total: a fix loop that oscillates burns its budget
in the `fixer` role specifically, and a per-role cap stops it without also starving review.

`runmill daemon` adds circuit breakers across runs — consecutive failures, error-rate thresholds —
so a systemic problem (a broken base branch, an expired credential) stops the loop rather than
being retried against every issue in the backlog.

## Observability

Every run emits an ordered event log with a monotonic sequence number. `runmill inspect` renders
state, transitions, events, check results with their evidence, and pending effects.

```bash
runmill inspect <run-id> --json | jq '.checks[] | {checkId, status, coverage, treeHashBefore, treeHashAfter}'
```

## See also

- [Autonomy and merge gates](./autonomy.md)
- [The coverage contract](./verification.md)
- [The lease model](./leases.md)
- [Errors](./errors.md)
