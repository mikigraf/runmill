# Autonomy and merge gates

> Implemented in [`src/orchestrator/orchestrator.ts`](../src/orchestrator/orchestrator.ts).

Autonomy modes govern the **Deliver** stage of Runmill's delivery loop.

Autonomy is a dial with four positions, and the interesting question is not "how much can it do"
but "what has to be *provable* before it does". Every mode below `continuous` differs from the one
above it by a specific gate, not by a vague sense of caution.

The agent may operate autonomously inside implementation and review. These modes govern the
deterministic workflow around the task: claims, repository effects, PR delivery, and merge policy.

| Mode | Does | Never does |
|---|---|---|
| `observe` | Selects and plans | Takes a lease, clones, or mutates anything |
| `pr-only` | Implements, verifies, reviews, fixes, opens a PR — **the default** | Merges |
| `guarded-merge` | Merges low-risk changes after every gate passes | Merges when any gate is unprovable |
| `continuous` | Applies guarded merge policy to every run in the daemon loop | — |

`pr-only` is the default because opening a pull request cannot bypass anything. It is the mode
where a mistake costs a review comment.

> [!IMPORTANT]
> Runmill is a developer preview. `guarded-merge` and `continuous` are experimental. Selecting
> either mode is not enough to enable automatic merge; the operator policy must also contain
> `experimental.automatic_merge: true`.

## The seven gates

Evaluated in order. Any failure ends the run in a terminal state that names which gate and why.

```
1. lease held with the current fencing generation
2. local checks: discovered, executed, fresh, no undeclared skip
3. review verdict, cross-checked against risk-escalating paths
4. branch protection readable (unreadable is refused, not assumed empty)
5. every required GitHub context satisfied
6. merge credential provably cannot edit branch protection
7. autonomy mode permits the classified risk
```

`runmill policy explain <run-id>` prints this for any run, with the state it reached.

### Gate 1 — the lease

`assertHeld` runs immediately before every external mutation. See [the lease model](./leases.md).

### Gate 2 — the coverage contract

Discovery, coverage, freshness, outcome. A green command satisfies only the last of those. See
[the coverage contract](./verification.md).

### Gate 3 — review, cross-checked

Review runs in a **fresh context** with no implementer narrative, and returns structured findings
tied to file and line. With the default `review.require_all_findings_resolved: true`, every finding
dispatches a fix. If that flag is deliberately disabled, only findings listed by
`review.merge_blocking_severities` (default `critical`, `high`) block an approving verdict. An
explicit `changes_required` verdict always makes every returned finding blocking. The loop is
bounded by `review.max_fix_iterations`; anything still blocking after that escalates.

The verdict itself is not taken on faith. `crossCheckVerdict` rejects contradictory combinations,
including a passing verdict whose scope is not `within_scope`, `no_findings` with a non-empty
finding list, and `changes_required` without an actionable finding. It also rejects a clean verdict
on a risk-marked diff:

```ts
if (review.verdict === "no_findings" && touchesRisk) {
  // reviewer reported no findings on a diff touching risk-escalating paths;
  // escalating rather than trusting the verdict
}
if (review.verdict !== "changes_required" && review.scope_assessment !== "within_scope") {
  // a passing review did not establish that the change stayed in scope
}
```

The first is the signature of a prompt-injected or simply over-agreeable review: a clean bill of
health on a diff touching `risk.manual_approval.paths`. The second withholds permission whenever
scope is unknown. A review cannot approve a change while stating it does something it was not asked
to do. Both cases escalate to a person instead of resolving in the change's favor.

Configure the paths that trigger this:

```yaml
risk:
  manual_approval:
    paths:
      - "migrations/"
      - "src/auth/"
      - ".github/workflows/"
```

### Gate 4 — branch protection must be readable

Branch protection is frequently unreadable: the classic endpoint needs admin, and org-level
rulesets are invisible to repo-scoped calls.

**runmill treats unreadable rules as unknown, not as absent, and refuses.** The alternative —
assuming no rules exist because none could be read — turns a permissions problem into an
unguarded merge, and does it silently, on the repositories most likely to be governed.

### Gate 5 — required contexts satisfied

Every context branch protection requires must have actually reported success. `neutral` and
`skipped` do not count. A required check that is never *scheduled* fails after 10 minutes rather
than waiting forever — see [remote checks](./verification.md#remote-checks).

Immediately before an automatic merge, Runmill also asks GitHub for its authoritative mergeability
verdict and requires `clean` plus `mergeable: true`. If branch rules require a merge queue, Runmill
stops: queue enrollment is not implemented in this preview, so it will not substitute a direct
merge. A `blocked` verdict also withholds merge, including when required conversations are not
resolved.

### Gate 6 — the negative capability test

This is the gate that distinguishes `guarded-merge` from `pr-only`, and it is a proof of
*inability*:

```ts
const canWriteProtection = await this.#d.forge.canWriteBranchProtection({ repo: target.repo });
if (canWriteProtection) {
  return finish("NEEDS_HUMAN", {
    reason:
      "the merge credential can edit branch protection, so a bypass-free merge is " +
      "unverifiable; merge modes stay locked until it cannot",
  });
}
```

The reasoning: if the credential that merges can also rewrite the rules constraining the merge,
then "no merge bypassed protection" is not a verifiable claim. Not because runmill would rewrite
them — because nothing *proves* it could not, and an audit trail that depends on good intentions
is not an audit trail.

So before any merge mode unlocks, runmill checks whether its own credential is too powerful, and
locks merging if it is. A governance system that cannot demonstrate its own constraints is
decorative.

**What this means in practice:**

| Mode | Credential |
|---|---|
| `pr-only` | An ordinary `gh auth login` session. Opening a PR cannot bypass anything |
| `guarded-merge`, `continuous` | A GitHub App installation token scoped to `contents: write` + `pull_requests: write`, and explicitly **not** `administration` |

A classic personal access token with `repo` scope will not unlock merging. `repo` includes
administration on repositories you own, so it fails the negative test — correctly.

`runmill doctor --explain github` covers this interactively.

### Gate 7 — risk tier vs mode

If branch protection requires an approving human review, the run finishes in `AWAITING_APPROVAL`
rather than attempting a merge it cannot complete. Runmill then evaluates the final diff and the
claimed issue against operator-owned risk policy immediately before `MERGE_READY`:

- only `risk.default: low` is eligible for automatic merge;
- a final changed path matching `risk.manual_approval.paths` requires approval;
- an issue label matching `risk.manual_approval.labels` requires approval; and
- `missing_acceptance_criteria`, `check_config_changed`, and `lockfile_changed` are evaluated from
  the task packet and final changed paths.

A known match finishes in `AWAITING_APPROVAL` and names every matching rule. A configured condition
that Runmill cannot prove from available evidence finishes in `NEEDS_HUMAN`. Today that applies to
`public_api_change`, `permissions_change`, and `secret_related_change`: treating an unimplemented
classifier as "false" would be a fail-open merge.

This gate governs automatic merge only. `pr-only` still delivers the verified, reviewed pull
request so a person can make the final decision.

## What happens after the gates

**`pr-only`** transitions the issue to `backlog.delivered_state`, comments with the PR URL,
releases the lease, and finishes at `PR_DELIVERED`. This is a success, not a partial one.
The delivered state is required and cannot be eligible, so the daemon's next poll cannot select
the same issue and open a second pull request.

**`guarded-merge` / `continuous`** re-assert the lease, require GitHub's clean mergeability verdict,
merge with `github.merge.method`, transition the issue to `backlog.completed_state`, release, clean
up, and finish at `COMPLETED`. Repositories requiring a merge queue stop for a person in this
preview.

Note the ordering: `assertHeld` immediately precedes the merge. The gap between "we decided to
merge" and "we merged" is where a stale worker would do damage, so the fence is checked inside it.

## Terminal states

| State | Meaning |
|---|---|
| `PR_DELIVERED` | Delivered a pull request. `pr-only` never merges by design |
| `COMPLETED` | Every gate passed and the change was merged |
| `AWAITING_APPROVAL` | Branch protection or operator risk policy requires a person's approval |
| `NEEDS_HUMAN` | A gate could not be satisfied deterministically, so it escalated |
| `QUARANTINED` | Something happened that policy could not classify |

`NEEDS_HUMAN` and `QUARANTINED` are different on purpose. The first is a gate doing its job — a
known condition with a named reason. The second means runmill encountered something it could not
categorize, which is the case where continuing would mean guessing.

```bash
runmill list --needs-attention
runmill policy explain <run-id>
runmill inspect <run-id>
runmill effects list
```

Checkpoint continuation is not available in the developer preview. `runmill resume <run-id>` is an
honest diagnostic refusal and does not record an answer or advance state. Resolve any ambiguous
external effect, restore the issue to an eligible state, and start a fresh attempt.

## Choosing a mode

Start at `pr-only`. It is the default, it needs no special credential, and every PR it opens is
evidence about whether you would have wanted it merged.

Move to `guarded-merge` once you have a body of runs you would have approved, and once you can
issue a scoped App token and explicitly opt in with `experimental.automatic_merge: true`. Use
`continuous` when every repeated daemon run should apply that experimental merge policy. The
daemon loop itself works with `pr-only` too; autonomy controls each run, while `runmill daemon`
controls repetition, polling, circuit breakers, and session budgets.

Autonomy should be earned with evidence you actually collected, and the PRs from `pr-only` are
that evidence.

## See also

- [The coverage contract](./verification.md) — gate 2 in full
- [The lease model](./leases.md) — gate 1 in full
- [Run lifecycle](./lifecycle.md) — states, the outbox, and recovery
- [Configuration](./configuration.md) — every key referenced above
