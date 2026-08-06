# runmill

A control plane for autonomous software engineering.

runmill continuously takes work from your backlog, dispatches it to coding agents, verifies and
reviews what they produce, gets the change through CI and merge, and moves on to the next issue.

> **Status: pre-implementation.** The specification is complete and reviewed; the code is not
> written yet. [`prd.md`](./prd.md) is the source of truth. Start there.

## What it is

runmill is not another coding model. It is the workflow, state, policy, and verification layer
around Codex and Claude Code. It owns everything those agents should not: which issue to work on,
how it is claimed, what context it gets, whether the tests that matter actually ran, whether the
change is in scope, and whether it may merge.

```
backlog issue ──▶ deterministic selection ──▶ atomic claim (git-ref lease)
      │
      ▼
isolated worktree + sandbox ──▶ bounded task packet ──▶ coding agent
      │
      ▼
check-coverage proof ──▶ fresh-context review ──▶ fix loop
      │
      ▼
governed pull request ──▶ CI reconciliation ──▶ risk-tiered merge ──▶ next issue
```

## Design commitments

These are the decisions the specification is built around. They are the reason runmill exists
rather than a shell script.

- **The orchestrator owns side effects.** Backlog mutations, PR creation, and merging are executed
  by deterministic code. The agent cannot widen its own authority.
- **Verification is a coverage contract, not a green checkmark.** Success means every required
  check was discovered, ran against the exact candidate commit in a clean detached worktree, and
  completed without an undeclared skip. A passing command that never ran the suite that mattered
  is a failure.
- **Review is independent and evidence-bearing.** It runs in a fresh context with no implementer
  narrative, and returns structured findings tied to file and line.
- **Autonomy is risk-tiered.** `pr-only` is the default. Auto-merge unlocks only for low-risk
  changes, only after calibration, and only with a credential that provably cannot edit branch
  protection.
- **Failure is closed, not open.** Ambiguity, a missing check, an unreachable sandbox, or an
  unparseable review stops the run. The product's most important capability is knowing when not
  to merge.

## Autonomy modes

| Mode | Behavior |
|---|---|
| `observe` | Selects and plans an issue; no repository mutation |
| `pr-only` | Implements, verifies, reviews, fixes, opens a PR. Never merges. **Default.** |
| `guarded-merge` | May merge low-risk changes after every automated and repository gate passes |
| `continuous` | Repeats guarded execution until no eligible work remains, a budget is reached, or a circuit breaker opens |

## Requirements

- macOS or Linux, arm64 or x64. Windows is not supported in the first release.
- Git, and a GitHub repository with CI.
- Codex or Claude Code, installed and authenticated.
- A backlog (Linear first; the adapter boundary is generic).
- A working sandbox: Seatbelt on macOS, bubblewrap on Linux. `runmill doctor` verifies it with
  positive escape tests and refuses to run without it.

## Configuration

`runmill.yaml` is explicit rather than inferred. Add the schema header for editor autocomplete and
inline validation:

```yaml
# yaml-language-server: $schema=https://runmill.dev/runmill.schema.json
version: 1
autonomy: pr-only
```

The schema lives at [`runmill.schema.json`](./runmill.schema.json). Validate with
`runmill config validate`.

Configuration is split by ownership, and location is a security property: **user policy**
(autonomy, budgets, risk rules) lives outside the repository so an inbound pull request cannot
change it; **repository policy** (checks, review rubrics) lives in the repository and is always
read from the base commit and diffed; **runtime state** belongs to runmill alone.

## Documentation

| Document | Contents |
|---|---|
| [`prd.md`](./prd.md) | Full specification: architecture, state machine, lease protocol, verification contract, merge governance, security model, delivery phases |
| [`prd.md` Appendix A](./prd.md) | Review findings from a six-voice adversarial review, with a resolution ledger |
| [`runmill.schema.json`](./runmill.schema.json) | Configuration schema (JSON Schema Draft 2020-12) |

## License

MIT. See [`LICENSE`](./LICENSE).

The license matters here for a specific reason: runmill reads your entire repository, holds a
backlog credential and a GitHub token, and can merge to your default branch. The security model in
the specification is a claim, and a permissive license is what lets you verify it instead of
taking it on faith.
