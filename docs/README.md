# runmill documentation

Runmill is a loop orchestrator daemon for autonomous software engineering. It watches a backlog
and turns eligible issues into verified, independently reviewed pull requests using Codex or
Claude Code. Runmill owns selection, state, policy, and side effects; the agents write and review
code.

These pages explain the mechanisms that make those decisions, and why each one works the way it
does. If you want to *use* runmill, start with the [README](../README.md).

Runtime and development dependencies are pinned to exact versions, and the lockfile pins the full
transitive graph. Use `npm ci` for a reproducible local or CI installation.

## Concepts

| Page | Answers |
|---|---|
| [Daemon operation](./daemon.md) | OpenTUI, background operation, idle polling, sleep prevention, and stopping |
| [The coverage contract](./verification.md) | Why a green test run is not proof, and what runmill requires instead |
| [The lease model](./leases.md) | How two workers are prevented from taking the same issue, and why the issue tracker cannot do it |
| [Autonomy and merge gates](./autonomy.md) | What `guarded-merge` actually requires, and the seven gates in order |
| [The sandbox](./sandbox.md) | What the agent can and cannot reach, and what each platform can enforce |
| [Run lifecycle](./lifecycle.md) | States, the side-effect outbox, crash recovery, budgets |
| [Evaluation](./evaluation.md) | Measuring the harness against your own history — including the work it should refuse |

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
