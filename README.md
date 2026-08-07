# runmill

A control plane for autonomous software engineering.

runmill continuously takes work from your backlog, dispatches it to coding agents, verifies and
reviews what they produce, gets the change through CI and merge, and moves on to the next issue.

## Try it in 60 seconds

No credentials, no signup, no config to write. The quickstart runs against an in-memory backlog.

```bash
git clone https://github.com/mikigraf/runmill.git
cd runmill && npm install
cd examples/quickstart
RUNMILL_DEMO=1 npx tsx ../../src/cli/main.ts next --dry-run
```

```text
Would select  ENG-102  Crash on cold start in the iOS app
  repository  acme/ios (base main)
  priority    urgent

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

Now run the whole loop, still with no credentials:

```bash
RUNMILL_DEMO=1 npx tsx ../../src/cli/main.ts daemon
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

## Use it on your own repository

```bash
runmill init      # writes runmill.yaml, the check manifest, and review skills
runmill doctor    # verifies this host can run safely
runmill next      # see what would be selected, and why everything else was not
runmill run ENG-123
```

`runmill init` infers your repository and base branch from git. Everything it cannot infer — your
team, your workflow states, your merge policy — is left as an editable placeholder, because a
guessed merge policy is not a guess worth making.

`runmill doctor` does not ask whether a sandbox exists. It builds one, tries to read `~/.ssh` from
inside it, and fails if that succeeds.

## Commands

| Command | Does |
|---|---|
| `runmill init` | Create `runmill.yaml`, the check manifest, and the review skills |
| `runmill doctor` | Verify the host. `--check <id>`, `--explain <topic>`, `--report` |
| `runmill next` | Show what would be selected, and why every other issue was not |
| `runmill prepare <issue>` | Score how ready an issue is, and say what is missing |
| `runmill run [issue]` | Process one issue end to end |
| `runmill daemon` | Process eligible issues until the work or the budget runs out |
| `runmill list` | Show runs. `--needs-attention` for those waiting on you |
| `runmill inspect <run-id>` | State, transitions, events, and pending effects for one run |
| `runmill resume <run-id>` | Answer a decision a run is waiting on |
| `runmill policy explain <run-id>` | Why a run may or may not merge |
| `runmill config validate` | Verify configuration, reporting every violation at once |
| `runmill config show` | Print configuration with every default resolved |
| `runmill skills eject` | Write the built-in review rubrics so you can edit them |
| `runmill skills validate` | Check that the configured review skills are well formed |
| `runmill auth status` | Show which credentials resolve, and from where |
| `runmill auth login` | Store a credential in the OS keychain |
| `runmill auth logout` | Remove a stored credential |
| `runmill state` | State store health |
| `runmill feedback` | File an issue, with a support bundle |

Every command takes `--json`, `--quiet`, and `--config <path>`.

**Exit codes:** `0` success · `1` failure · `2` invalid configuration · `3` blocked on a human.

## Environment variables

| Variable | Does |
|---|---|
| `RUNMILL_DEMO=1` | Use an in-memory backlog, provider, and forge, seeded with the bundled example issues. Never inferred: a fake must not stand in for production silently |
| `RUNMILL_FAKE_BACKLOG=<file>` | Read issues from a JSON fixture instead of a live backlog |
| `RUNMILL_SOURCE_REPO=<path>` | Repository to create run workspaces from. Defaults to the working directory |
| `RUNMILL_DATA_DIR=<path>` | Where the state database and workspaces live. Defaults to `./.runmill/state` |
| `LINEAR_API_KEY` | Backlog credential. The OS keychain is checked first |
| `GITHUB_TOKEN` | Forge credential. `gh auth token` is used when this is unset |

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

- **The orchestrator owns side effects.** Backlog mutations, PR creation, and merging are executed
  by deterministic code. The agent cannot widen its own authority.
- **Verification is a coverage contract, not a green checkmark.** Success means every required
  check was discovered, ran against the exact candidate commit in a clean detached worktree, and
  completed without an undeclared skip. A passing command that never ran the suite that mattered
  is a failure.
- **Review is independent and evidence-bearing.** It runs in a fresh context with no implementer
  narrative, and returns structured findings tied to file and line.
- **Autonomy is risk-tiered.** `pr-only` is the default. Auto-merge unlocks only for low-risk
  changes, and only with a credential that provably cannot edit branch protection.
- **Failure is closed, not open.** Ambiguity, a missing check, an unreachable sandbox, or an
  unparseable review stops the run. The most important capability is knowing when not to merge.

## Autonomy modes

| Mode | Behavior |
|---|---|
| `observe` | Selects and plans. No lease, no clone, no repository mutation |
| `pr-only` | Implements, verifies, reviews, fixes, opens a PR. Never merges. **Default** |
| `guarded-merge` | May merge low-risk changes after every automated and repository gate passes |
| `continuous` | Repeats guarded execution until work runs out, a budget is reached, or a breaker opens |

## Requirements

- macOS or Linux, arm64 or x64. Windows is not supported; `doctor` says so rather than failing
  obscurely.
- Node 20.11+, git, and a GitHub repository.
- Codex or Claude Code, installed and authenticated — unless running with `RUNMILL_DEMO=1`.
- A working sandbox: Seatbelt on macOS, bubblewrap on Linux. `runmill doctor --explain sandbox`
  covers what each platform can and cannot enforce.

## Configuration

`runmill.yaml` is explicit rather than inferred, and `runmill init` writes a working starting point
so "explicit" never means "author it from nothing". The schema ships in the repository:

```yaml
# yaml-language-server: $schema=./runmill.schema.json
version: 1
autonomy: pr-only
```

Validate with `runmill config validate`; see everything including defaults with
`runmill config show`.

Configuration is split by ownership, and location is a security property: **user policy**
(autonomy, budgets, risk rules) lives outside the repository so an inbound pull request cannot
change it; **repository policy** (checks, review rubrics) lives in the repository and is always
read from the base commit and diffed; **runtime state** belongs to runmill alone.

## Status

| Phase | State |
|---|---|
| **Foundation** — CLI, config, state store, deterministic selection, git-ref lease | **Working** |
| **Agent execution** — clone isolation, Seatbelt/bubblewrap sandbox, task packet | **Working** |
| **Verified PR** — manifest resolution, freshness proof, skip detection, reviews | **Working** |
| **Governed merge** — CI reconciliation, negative credential test, protected merge | **Working** |
| **Live adapters** — Linear, Codex / Claude Code, GitHub | **Working** |
| **Continuous operation** — daemon, circuit breakers | **Working** |
| Evaluation — historical replay, held-out suites | Specified |
| Behavior handbook | Specified |

## Documentation

| Document | Contents |
|---|---|
| [`docs/errors.md`](./docs/errors.md) | Every error code, what causes it, and how to fix it |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Development setup, tests, and how the layers fit |
| [`CHANGELOG.md`](./CHANGELOG.md) | What changed, and what upgrading requires |
| [`prd.md`](./prd.md) | Full specification, plus the review that shaped it |
| [`runmill.schema.json`](./runmill.schema.json) | Configuration schema (JSON Schema Draft 2020-12) |

## License

MIT. See [`LICENSE`](./LICENSE).

The license matters here for a specific reason: runmill reads your entire repository, holds a
backlog credential and a GitHub token, and can merge to your default branch. The security model is
a claim, and a permissive license is what lets you verify it instead of taking it on faith.
