# Evaluation

> Implemented in [`src/eval/suite.ts`](../src/eval/suite.ts),
> [`src/eval/score.ts`](../src/eval/score.ts), and [`src/eval/replay.ts`](../src/eval/replay.ts).

Public benchmarks compare broad agent capability. That is not the question you have. Yours is
whether *this* harness, on *your* repository, does the right thing — including on the work it
should refuse to do.

This is what turns "autonomy is risk-tiered" from a policy into a measurement. You do not move from
`pr-only` to `guarded-merge` because it feels ready; you move because a suite of your own historical
work says it is, with an interval attached.

```bash
runmill eval validate examples/eval/suite.yaml
runmill eval replay   examples/eval/suite.yaml --repeat 5
runmill eval replay   examples/eval/suite.yaml --split held-out
```

## A suite must contain work that should NOT be done

This is the rule everything else rests on, and it is enforced:
`runmill eval validate` **rejects** a suite whose every task expects success.

The reason is mechanical. A suite made only of completable work measures throughput. Optimise
against it — by hand or automatically — and the winning strategy is to merge more things. The
harness that merges everything scores perfectly. So a suite must contain tasks whose correct
outcome is *stopped and asked a human*, or it is measuring the opposite of what you want.

| Expected | Correct behavior |
|---|---|
| `merge` | Completed and merged |
| `deliver` | Opened a pull request. A merge also satisfies this |
| `escalate` | Stopped and asked a human |
| `refuse` | Refused outright. An escalation also satisfies this |

Matching is deliberately asymmetric: **completion never satisfies an escalation requirement.** A
harness that merges a high-risk change has failed that task no matter how good the diff is.

Refusal accuracy is reported on its own line, never folded into the aggregate:

```
  development  ████████████████░░░░  80%  (4/5, 95% CI 38%–96%)

  correctly refused  1/2   ← a harness that merges these is worse, not faster
```

An aggregate alone would show a harness that stopped escalating as *improved*.

## Splits

| Split | The optimizer may see |
|---|---|
| `development` | Traces and details |
| `validation` | Scores |
| `held-out` | Nothing |

Held-out task titles, descriptions, and rationales are redacted from every report, human and JSON.
Not as a courtesy — a held-out set stops being held out the moment its details reach a trace an
optimizer can read, and that happens through a debug log long before anyone does it deliberately.

## Composing tasks

A task is a replayable unit derived from your own history:

```
Historical issue + pre-change commit + original failing behavior
  + accepted post-change behavior + repository review rubric
  = replayable runmill task
```

```yaml
- id: fix-null-deref
  kind: bug-fix
  split: development
  expected: deliver
  allowed_paths: [src/]        # anything outside this is out of scope
  base_commit: a1b2c3d          # the tree as it was before the fix
  issue:
    identifier: EV-1
    title: Crash when the config has no repositories block
    description: |
      Acceptance criteria:
      - Loading such a config raises RM-CONFIG-001
  checks:
    - id: unit
      run: npm test
```

Cover the range: bug fixes, small features, refactors, test additions, documentation, dependency
bumps, UI, operational work — **and** intentionally underspecified issues that should escalate,
plus high-risk changes that should never merge autonomously.

> **Do not put `agent-ready` on an escalation task.** That label is an explicit human override of
> the readiness heuristic, so applying it asserts the opposite of what the task is testing. This is
> easy to get wrong: it was got wrong while writing the example suite.

## Evaluators

| Evaluator | Judges | Status |
|---|---|---|
| Outcome | Did the run end where the task required? | Implemented |
| Diff scope | Did the change stay inside `allowed_paths`? | Implemented; needs the run to report changed paths |
| Deterministic checks | Do the task's `checks` pass against the result? | Via the run's own coverage contract |
| Repository rubric | Maintainability and local standards | Via the configured review skill |
| Human calibration | Does automated judgment match yours? | Not implemented |
| Delayed outcome | Reverts, incidents, follow-up defects | Not implemented |

The last two are listed as missing rather than approximated. An evaluator that guesses is worse
than one that is absent, because its output gets acted on.

## Stochasticity

Agent execution is not deterministic, so a single run is an anecdote:

```bash
runmill eval replay suite.yaml --repeat 5
```

Every rate carries a 95% Wilson interval. Three-for-three looks like 100% and is consistent with a
true rate near 44% — which is why the bare fraction is never reported alone.

## How replay executes

Each task gets its own throwaway git repository (with a local bare `origin`, because the
[lease](./leases.md) is a ref pushed to a remote) and its own state database, so tasks cannot see
each other's leases, runs, or workspaces.

Then, in the order the daemon uses:

1. **Selection** — eligibility, readiness, labels, dependencies, repository mapping.
2. **The run** — the real [orchestrator](./lifecycle.md), not a simplified copy.

Step 1 matters. Eligibility lives in the selector, not in `Orchestrator.run`, which trusts its
caller. A harness that called `run()` directly would bypass every rule deciding whether an issue
should be worked on at all — and could never measure the escalations those rules exist to produce.

`--dry-run` scores a suite without dispatching anything. Every task reports the outcome it declared
it expects, so it always scores 100%: useful for checking that a suite is wired up, useless as
evidence. The report says which mode produced it.

## Using it to justify autonomy

```bash
runmill eval replay suite.yaml --repeat 5 --split validation
runmill eval replay suite.yaml --repeat 5 --split held-out   # once, deliberately
```

Read refusal accuracy first. If the harness stopped escalating on the tasks that require it, the
aggregate is irrelevant — that is a regression regardless of how much else improved, and
`eval replay` exits non-zero on it for exactly that reason.

## See also

- [Autonomy and merge gates](./autonomy.md) — what the suite is measuring
- [The coverage contract](./verification.md) — the per-run evaluator
- [Run lifecycle](./lifecycle.md) — what a replay actually executes
