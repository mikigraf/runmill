# Runmill documentation

A coding agent can complete one task. Runmill keeps the delivery loop moving.

Runmill provides backlog-to-PR orchestration for coding agents. It picks up eligible Linear
issues, runs Codex or Claude Code, verifies and independently reviews the exact change, delivers
the GitHub pull request, and returns to the queue.

Agents implement and review code. Runmill owns eligibility, claims, workspaces, required checks,
repository side effects, pull requests, durable state, and merge policy.

These pages explain the mechanisms that make those decisions, and why each one works the way it
does. If you want to *use* runmill, start with the [README](../README.md).

Runtime and development dependencies are pinned to exact versions, and the lockfile pins the full
transitive graph. Use `npm ci` for a reproducible local or CI installation.

## The delivery loop

```text
Queue → Run → Verify → Review → Deliver → Repeat
```

- **Queue:** select eligible work, route it to a repository, and acquire one durable claim.
- **Run:** create an isolated workspace and dispatch Codex or Claude Code with bounded context and
  policy.
- **Verify:** run every required check against the exact candidate commit.
- **Review:** inspect the task and diff in a new agent context and account for every acceptance
  criterion.
- **Deliver:** push, open the PR, reconcile CI, apply merge policy, and update the backlog.
- **Repeat:** take the next eligible issue or wait without terminating when the queue is empty.

The recurring object is an **engineering run**: one issue, one claim, one isolated implementation,
one evidence bundle, and one delivery decision. Its state includes the repository and base
revision, agent configuration, candidate commit, checks, review, side effects, PR and CI status,
and the reason for any retry, stop, quarantine, or escalation. See the
[run lifecycle](./lifecycle.md) for the complete state model.

## Concepts

| Loop stage | Page | Answers |
|---|---|---|
| Queue | [The lease model](./leases.md) | How two workers are prevented from taking the same issue, and why the issue tracker cannot do it |
| Run | [Run lifecycle](./lifecycle.md) | States, the side-effect outbox, crash recovery, and budgets |
| Run | [The sandbox](./sandbox.md) | What the agent can and cannot reach, and what each platform can enforce |
| Verify | [The coverage contract](./verification.md) | Why a green test run is not proof, and what Runmill requires instead |
| Deliver | [Autonomy and merge gates](./autonomy.md) | What `guarded-merge` requires, and the seven gates in order |
| Repeat | [Daemon operation](./daemon.md) | OpenTUI, background operation, idle polling, sleep prevention, and stopping |
| Whole loop | [Evaluation](./evaluation.md) | Measuring Runmill against your own history, including work it should refuse |

## Reference

| Page | Contents |
|---|---|
| [Configuration](./configuration.md) | Every key in `runmill.yaml` and `.runmill/checks.yaml`, with defaults |
| [Errors](./errors.md) | Every error code, what causes it, how to fix it — generated from the catalog |
| [`runmill.schema.json`](../runmill.schema.json) | JSON Schema for editor autocomplete |
| [`prd.md`](../prd.md) | Full specification, plus the review that shaped it |

## The five commitments

Everything else follows from these.

**The orchestrator owns side effects.** Backlog mutations, PR creation, and merging are executed by
deterministic code. The agent proposes; it cannot widen its own authority. It can add a required
check but never remove one, and it proposes check *identifiers*, never commands.

**Verification is a coverage contract, not a green checkmark.** Success means every required check
was discovered, ran against the exact candidate commit in a clean detached worktree, and completed
without an undeclared skip. A passing command that never ran the suite that mattered is a failure.

**Review is independent and evidence-bearing.** It runs in a fresh context with no implementer
narrative, returns findings tied to file and line, and its verdict is cross-checked — a clean
report on a diff touching risk paths escalates rather than being believed.

**Autonomy is risk-tiered.** `pr-only` is the default. Auto-merge unlocks only for low-risk changes,
and only with a credential that provably *cannot* edit branch protection.

**Failure is closed, not open.** Ambiguity, a missing check, an unreachable sandbox, an unreadable
branch protection rule, or an unparseable review stops the run. The most important capability is
knowing when not to merge.

Together these commitments create a deliberate boundary: the agents are autonomous inside the
coding and review task; Runmill is deterministic around the task. Language models propose and
inspect changes. Deterministic orchestration owns workflow state and irreversible effects.

## Where to start

- **Evaluating runmill?** [The coverage contract](./verification.md) — it is the claim everything
  else rests on.
- **Considering auto-merge?** [Autonomy and merge gates](./autonomy.md).
- **Security review?** [The sandbox](./sandbox.md), then the outbox in
  [run lifecycle](./lifecycle.md).
- **Running more than one worker?** [The lease model](./leases.md).
- **Deciding whether to trust auto-merge?** [Evaluation](./evaluation.md).
- **Something failed?** [Errors](./errors.md), then `runmill inspect <run-id>`.
- **Leaving it running?** [Daemon operation](./daemon.md).

## Getting help

```bash
runmill doctor              # verify the host, with the reasoning for each check
runmill doctor --explain sandbox|github|provider|linear
runmill doctor --report     # support bundle: no credentials, source, or absolute paths
runmill feedback            # file an issue with that bundle attached
```
