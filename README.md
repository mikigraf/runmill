# runmill

A control plane for autonomous software engineering.

runmill continuously takes work from your backlog, dispatches it to coding agents, verifies and
reviews what they produce, gets the change through CI and merge, and moves on to the next issue.

> **Status: working, with live adapters.** An issue goes from the backlog through claim, isolated
> workspace, agent execution, sandboxed verification, independent review, and out as a governed
> pull request — then the daemon moves to the next one. Linear, GitHub, Codex, and Claude Code all
> have real implementations. 205 tests plus a live suite that runs against real systems.
> Still specified-only: the evaluation harness and the generated behavior handbook.
> [`prd.md`](./prd.md) is the source of truth.

## Try it in 30 seconds

No credentials needed — the quickstart runs against an in-memory backlog fixture.

```bash
git clone <this repo> && cd runmill && npm install
cd examples/quickstart
RUNMILL_FAKE_BACKLOG=issues.json npx tsx ../../src/cli/main.ts next --dry-run
```

```text
Would select  ENG-102  Crash on cold start in the iOS app
  repository  acme/ios (base main)
  priority    1

Next in queue (3):
  ENG-101  Prevent duplicate webhook delivery processing
  ENG-103  Tidy up the dashboard
  ENG-106  Unprioritized cleanup task

Rejected (2):
  ENG-104  Migrate billing to the new provider
      ✗ dependencies: blocked by ENG-99
  ENG-105  Redesign onboarding
      ✗ labels: carries excluded label(s): needs-design
```

Two things worth noticing. `ENG-102` routed to `acme/ios` because it carries the `mobile` label and
the first matching rule wins. And `ENG-106` sorted last despite being the oldest issue by seven
years, because it has no priority — backlogs encode "no priority" as zero, which a naive sort puts
first.

Then check the host is safe to run on:

```bash
npx tsx ../../src/cli/main.ts doctor
```

`doctor` does not ask whether a sandbox exists. It builds one, tries to read `~/.ssh` from inside
it, and fails if that succeeds.

## Implementation status

| Phase | State |
|---|---|
| **Foundation** — CLI, config, state store, deterministic selection, git-ref lease | **Working** |
| **Agent execution** — clone isolation, Seatbelt/bubblewrap sandbox, task packet, adapter contract | **Working** |
| **Verified PR** — manifest resolution, freshness proof, skip detection, schema-validated review | **Working** |
| **Governed merge** — CI reconciliation, negative credential test, approval gate, protected merge | **Working** |
| **Live adapters** — Linear, Codex / Claude Code, GitHub | **Working** |
| **Continuous operation** — daemon, circuit breakers | **Working** |
| Evaluation — historical replay, held-out suites | Specified |
| Behavior handbook | Specified |

Commands: `run`, `daemon`, `next --dry-run`, `list [--needs-attention]`, `doctor`,
`config validate`, `config show`, `state` — all with `--json`, `--quiet`, and documented exit codes.

### Running against your real systems

```bash
gh auth login                        # GitHub credential
export LINEAR_API_KEY=lin_api_...    # or store it in the OS keychain
runmill doctor                       # verifies the host, including sandbox escape probes
runmill run ENG-123
```

Each boundary resolves independently, and `run` prints which are live:

```text
  adapters: backlog=live provider=live forge=live
```

In-memory substitutes require an explicit `RUNMILL_DEMO=1`. A fake never stands in for production
silently — that is the difference between a governance system and a theatre of one.

### Run the whole loop

```bash
export RUNMILL_DEMO=1 RUNMILL_FAKE_BACKLOG=issues.json
npx tsx src/cli/main.ts run ENG-101
```

```text
  → ELIGIBILITY_CHECKED
  → CLAIMED
  → WORKSPACE_READY
  → TASK_PACKET_READY
  → IMPLEMENTING
  → LOCAL_VERIFY
    check readme-exists: passed (unproven)
  → LOCAL_REVIEW
  → PR_READY
  → PUSHED
  → PR_OPEN
  → CI_WAIT
  → PR_DELIVERED

ENG-101  →  PR_DELIVERED
  pull request  https://fake/acme/platform/pull/1/...
  cost          $0.24
```

`unproven` there is the system being honest: that check declares no
machine-readable report, so runmill ran it but cannot prove what it covered.

### Continuous operation

```bash
runmill daemon
```

```text
ENG-102 → PR_DELIVERED ($0.02)
ENG-101 → PR_DELIVERED ($0.02)
ENG-103 → PR_DELIVERED ($0.02)
ENG-106 → PR_DELIVERED ($0.02)
no eligible work remaining
stopped: no-work
  runs:    4
  spend:   $0.08
```

Serial by construction: selection happens only after the previous run released its lease. Circuit
breakers stop the worker on a quarantine, consecutive failures, the daily cost cap, or a high
escalation rate — that last one reports the likely cause as an underspecified backlog rather than
a broken worker, because that is usually what it is.

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
