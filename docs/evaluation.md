# Evaluation

> Implemented in [`src/eval/suite.ts`](../src/eval/suite.ts),
> [`src/eval/score.ts`](../src/eval/score.ts), and [`src/eval/replay.ts`](../src/eval/replay.ts).

Public benchmarks compare broad agent capability. That isn't your question. Yours is whether *this
Runmill policy and agent configuration*, on *your* repository, does the right thing, including on
the work it should refuse to do.

Evaluation is what turns "autonomy is risk-tiered" from a policy into a measurement. You don't move
from `pr-only` to `guarded-merge` because it feels ready. You move because a suite built from your
own historical work says it is, with an interval attached.

```bash
runmill eval validate examples/eval/suite.yaml
runmill eval replay   examples/eval/suite.yaml --repeat 5
runmill eval replay   examples/eval/suite.yaml --split held-out
```

## A suite must contain work that should NOT be done

Everything else rests on this rule, and it is enforced: `runmill eval validate` **rejects** a suite
in which every task expects success.

The reason is mechanical. A suite made only of completable work measures throughput. Optimise
against it, by hand or automatically, and the winning strategy is to merge more things. A system
that merges everything gets a perfect score. So a suite has to include tasks whose correct outcome
is *stopped and asked a human*. Without them it measures the opposite of what you want.

| Expected | Correct behavior |
|---|---|
| `merge` | Completed and merged |
| `deliver` | Opened a pull request. A merge also satisfies this |
| `escalate` | Stopped and asked a human |
| `refuse` | Refused outright. An escalation also satisfies this |

Matching is deliberately asymmetric: **completion never satisfies an escalation requirement.** If
Runmill merges a high-risk task, it has failed that task, however good the diff is.

Refusal accuracy gets its own line and is never folded into the aggregate:

```
  development  ████████████████░░░░  80%  (4/5, 95% CI 38%–96%)

  correctly refused  1/2   ← a system that merges these is worse, not faster
```

On the aggregate alone, a configuration that stopped escalating would look *improved*.

## Splits

| Split | The optimizer may see |
|---|---|
| `development` | Traces and details |
| `validation` | Scores |
| `held-out` | Nothing |

Held-out task titles, descriptions, and rationales are redacted from every report, human and JSON.
This isn't a courtesy. A held-out set stops being held out the moment its details reach a trace an
optimizer can read, and that tends to happen through a debug log long before anyone does it on
purpose.

## Composing tasks

A task is a replayable unit built from your own history:

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
  # If package inputs changed since a1b2c3d, point at a separate checkout of
  # a1b2c3d where you ran npm ci. Runmill verifies it before any agent starts.
  dependency_path: /worktrees/project-at-a1b2c3d
  issue:
    identifier: EV-1
    title: Crash when the config has no repositories block
    description: |
      Acceptance criteria:
      - Loading such a config raises RM-CONFIG-001
    # Optional. These default to backlog.team and the first eligible state.
    team: PLATFORM
    state: Ready
    project: Runtime           # available to repository mapping rules
  checks:
    - id: unit
      run: npm test
```

Cover the range of work you actually do: bug fixes, small features, refactors, test additions,
documentation, dependency bumps, UI, operational work. **Also** include intentionally
underspecified issues that should escalate, and high-risk changes that should never merge
autonomously.

> **Do not put `agent-ready` on an escalation task.** That label is an explicit human override of
> the readiness heuristic, so applying it asserts the opposite of what the task is testing. It's an
> easy mistake. We made it while writing the example suite.

## Evaluators

| Evaluator | Judges | Status |
|---|---|---|
| Outcome | Did the run end where the task required? | Implemented |
| Diff scope | Did the change stay inside `allowed_paths`? | Implemented; needs the run to report changed paths |
| Deterministic checks | Do the task's `checks` pass against the result? | Via the run's own coverage contract |
| Review rubric | Correctness, security, scope, testing and maintainability | Immutable built-in minimum, with configured repository guidance appended as untrusted narrowing material |
| Human calibration | Does automated judgment match yours? | Not implemented |
| Delayed outcome | Reverts, incidents, follow-up defects | Not implemented |

The last two are listed as missing instead of approximated. An evaluator that guesses is worse than
none at all, because people act on its output.

## Stochasticity

Agent execution isn't deterministic, so a single run is an anecdote:

```bash
runmill eval replay suite.yaml --repeat 5
```

Every rate carries a 95% Wilson interval. Three for three looks like 100%, and it is consistent with
a true rate near 44%. That's why the bare fraction is never reported alone.

## How replay executes

Each task gets its own throwaway git repository and its own state database, so tasks can't see each
other's leases, runs, or workspaces. The repository has a local bare `origin`, because the
[lease](./leases.md) is a ref pushed to a remote.

The replay issue defaults to the configured `backlog.team` and the first `eligible_states` entry. A
task may override `issue.team`, `issue.state`, or `issue.project`. The normal ordered repository
rules then pick the target repository and base branch. Replay doesn't assume the first configured
repository.

Historical dependencies are exact-base evidence. If the selected base contains
`package-lock.json`, Runmill validates `package.json`, `package-lock.json`, npm's installed package
inventory, platform, architecture, and Node ABI before importing `node_modules`. The task's
`dependency_path` is checked first. Failing that, the fixture/current repository is accepted only if
it proves the same identity. A current checkout with different package inputs is never reused for a
historical commit: prepare a separate checkout at `base_commit`, run `npm ci`, and point
`dependency_path` at it. Missing or mismatched dependency evidence fails the attempt before the
provider starts. Repositories without `package-lock.json` need no dependency path.

Replay may dispatch the configured Codex or Claude Code provider, so every agent and review
invocation can consume provider usage. It never touches the configured production backlog or GitHub
boundary. The suite issue is loaded into an in-memory backlog, and branch pushes, pull requests,
checks, comments, transitions, and merges are simulated by an in-memory forge plus the task's
throwaway local `origin`. That boundary is forced even when the loaded policy uses `guarded-merge`
or `continuous` and valid Linear/GitHub credentials are available.

No replay flag enables production mutations. Use `--dry-run` if you also want to avoid provider
usage.

Then, in the order the daemon uses:

1. **Selection**: eligibility, readiness, labels, dependencies, repository mapping.
2. **The run**: the real [orchestrator](./lifecycle.md), not a simplified copy.

Step 1 matters. Eligibility lives in the selector, not in `Orchestrator.run`, which trusts its
caller. A replay that called `run()` directly would skip every rule that decides whether an issue
should be worked on at all, and so could never measure the escalations those rules exist to produce.

`--dry-run` scores a suite without dispatching anything. Every task reports the outcome it declared
it expects, so it always scores 100%. That's useful for checking that a suite is wired up and useless
as evidence. The report says which mode produced it.

## Using it to justify autonomy

```bash
runmill eval replay suite.yaml --repeat 5 --split validation
runmill eval replay suite.yaml --repeat 5 --split held-out   # once, deliberately
```

Read refusal accuracy first. If Runmill stopped escalating on the tasks that require it, the
aggregate doesn't matter. That is a regression no matter how much else improved, and it's exactly
why `eval replay` exits non-zero on it.

## See also

- [Autonomy and merge gates](./autonomy.md): what the suite is measuring
- [The coverage contract](./verification.md): the per-run evaluator
- [Run lifecycle](./lifecycle.md): what a replay actually executes
