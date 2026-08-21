# Run lifecycle

Successful deliveries and merges are also recorded in `log.md` beside the project state database,
outside the managed repository. This is a concise, human-readable journal rather than recovery
state; the SQLite store remains authoritative. Log timestamps use local `DD/MM/YYYY HH:mm` format
and 24-hour time.

> Implemented in [`src/orchestrator/orchestrator.ts`](../src/orchestrator/orchestrator.ts) and
> [`src/state/store.ts`](../src/state/store.ts).

A run is Runmill's durable unit of engineering work:

> One issue → one claim → one isolated implementation → one evidence bundle → one delivery
> decision.

It records the selected issue, repository and base revision, agent configuration, candidate
commit, verification evidence, independent review, side effects, PR and CI state, merge decision,
and the reason for any stop, retry, quarantine, or escalation. The run moves from the backlog to a
pull request, and possibly to a merge, through durable state transitions. A crash therefore leaves
an inspectable record. Checkpoint continuation is not implemented in the developer preview.

The daemon is the outer loop around this state machine. It performs one run at a time and polls
again while idle; see [daemon operation](./daemon.md).

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
| `→ TASK_PACKET_READY` | The task contract is built — issue, exact base, path limits, and required checks |
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
| `PR_REVIEW` | The exact local candidate plus orchestrator-owned PR identity and CI verdicts for the same SHA | `budgets.max_agent_invocations.pr_review` / `pr_fixer` |

`PR_REVIEW` runs **after** CI and **before** the merge gate. Before starting it, Runmill re-reads the
pull request, requires its remote head to equal the exact local candidate, and writes
`.runmill/run/pr-evidence.json` with the PR number, URL, head and base SHAs, that candidate
relationship, and reconciled CI verdicts. If a fixer produces another commit, local verification,
the remote-head assertion, CI, and PR evidence all run again for the new SHA.

The reviewer does not receive pull request comments, a separately fetched remote checkout, or a
speculative merge/rebase result, and the evidence file says so. Runmill does not claim those inputs
were reviewed. Immediately before automatic merge it checks the remote head again, and GitHub's
merge request includes the expected candidate SHA so a concurrent push fails atomically.

A blocking finding dispatches a fixer, and the fix is re-verified against the full
[coverage contract](./verification.md) before it goes back onto the branch: a fix is new code, and
new code has not been proven. Two things end the loop rather than continuing it:

- **The fixer changed nothing.** The next review would reach the same verdict, so looping again
  would only spend money.
- **An unparseable review.** Its conclusion is unknown, and unknown is not permission to merge.

The reviewer sees the workspace read-only. Its only workspace write grant is its pre-created,
role-specific JSON output file; the directory containing the task packet and evidence remains
read-only. A reviewer that tries to edit the candidate is denied by the OS sandbox. Something whose
only job is to form an opinion has no business editing what it judges.

## The task packet

The agent gets a structured task contract alongside the isolated repository checkout. The packet
names the issue, acceptance criteria, exact base commit and branch, required checks, path and
network constraints, and completion requirements. The issue body is stored separately as fenced,
untrusted data. Runmill does not currently preload a configurable set of entry files or enforce a
prompt-byte budget, so it exposes no configuration keys that imply those controls exist.

The output contract is set per role — implementer, reviewer, fixer — so the reviewer is *required*
to emit structured findings rather than prose that has to be parsed hopefully. An event shape the
adapter does not recognize quarantines the run rather than being parsed best-effort:
misreading a tool call or a terminal result is worse than stopping
([`RM-PROVIDER-001`](./errors.md#rm-provider-001)).

The packet's path constraints are enforcement inputs, not prompt advice. Before every candidate
checkpoint, Runmill computes the complete Git diff, normalizes every repository-relative path, and
requires each path to match `allowed_paths` and none to match `forbidden_paths`. Forbidden rules win
over broad allows. `.github/**`, `.runmill/**`, package manifests, and lockfiles are always forbidden;
an attempted change quarantines the run before a commit or forge call. The two packet input files
and the reviewer's named output files are handled as exact runtime artifacts, so excluding them does
not create a general `.runmill/` escape.

## The side-effect outbox

Every external mutation — a backlog transition, a PR creation, a merge — is written down **before**
it is attempted:

```ts
/**
 * Record the intent to perform an external mutation.
 *
 * Called BEFORE the remote call. A crash between this row and the remote
 * response leaves a durable record naming the run and the operation. New
 * delivery runs remain blocked until an operator verifies the remote outcome.
 */
intendSideEffect(input: { runId, system, operation, target }): string
```

The ordering is the whole point, and it follows from one fact:

> **A failed request does not prove the effect did not happen.**

A timeout, a dropped connection, or a 500 after the server committed all look identical to a
request that never arrived. Code that writes its record *after* success will, on exactly those
paths, have performed a merge it has no memory of.

So intent is durable first. On restart, a row still marked `intended`, `in_flight`, or `failed` is a
question: *did this land?* Runmill does not currently pretend it can answer every provider-specific
question automatically. It blocks every new delivery run until a person checks the named remote
system and records the observed outcome:

```bash
runmill effects list
runmill effects resolve <key> --outcome applied
# or: --outcome not-applied
```

Effects are keyed by `sha256(runId + operation + target)`. An operator resolution closes that exact
row and remains visible in its audit fields.

This is why a pending effect stays pending rather than being retried blindly, and why
`runmill inspect` lists them.

## Crash recovery

State transitions and side-effect intents are committed to SQLite as they happen. After a crash:

```bash
runmill list                 # every run and its state
runmill list --needs-attention
runmill inspect <run-id>     # state, transitions, events, pending effects
runmill effects list         # ambiguous remote mutations
runmill leases list          # local ownership rows
```

Three cases:

- **Mid-agent** — the workspace is preserved on any non-clean exit, deliberately, so it can be
  inspected. `COMPLETED` and `PR_DELIVERED` clean up eagerly; `NEEDS_HUMAN`, `QUARANTINED`, and
  `AWAITING_APPROVAL` keep their trees, because there the tree is the evidence.
  `runmill gc` removes terminal/orphaned workspaces. It does not resume the agent session.
- **Mid-mutation** — new runs stop. Check GitHub or the backlog, then use `runmill effects resolve`
  with the outcome you observed. Runmill never retries an ambiguous mutation blindly.
- **Lease lost** — the run is fenced out and stops. Another worker owns the issue now, and the
  correct behavior is to do nothing rather than race.

Before a pull request exists, an ordinary failed run restores the issue's prior state and assignee
under the same lease, then releases it, so a fresh attempt can be selected. A hard process crash can
leave both the remote lease ref and local row behind. Recovery is deliberately manual in this
preview: verify the worker is dead, restore the issue state/assignee, delete the exact remote lease
ref, then run:

```bash
runmill leases resolve <issue> --confirm-remote-cleared
```

The command independently verifies that the remote ref is absent before clearing the local row.
`runmill resume <run-id>` only explains this limitation and never changes state; it cannot continue
a checkpoint.

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

`runmill daemon` adds circuit breakers across runs — consecutive failures, quarantines,
escalation rate, and daily spend — so a systemic problem stops the loop instead of being retried
against every issue. Daily spend uses a per-repository SQLite ledger and the configured UTC or
host-local calendar bucket, so restarting the daemon does not reset the cap. The other three
breaker counters are process-session controls in this preview and do reset on restart; supervisors
must not automatically restart a breaker exit. An empty queue does not stop the normal daemon; it
polls until a signal, budget, or breaker stops it. `runmill daemon --once` keeps the batch-style
drain-and-exit behavior.

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
