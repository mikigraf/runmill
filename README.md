# runmill

The exit condition for coding agents.

Claude Code says it's done. Codex says it's done. runmill asks a narrower question: did the exact
commit you are about to merge pass the checks you said mattered?

Your harness already has a loop. runmill decides when it is finished. It claims work atomically so
two workers cannot collide, runs the agent under an OS sandbox with your credentials denied, proves
the required checks ran against the candidate commit, reviews the diff in a fresh context, and
refuses to merge anything it cannot account for.

[**Landing page**](./site/index.html) · [Documentation](./docs/README.md)

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
years, because it has no priority. Backlogs encode "no priority" as zero, which a naive sort puts
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

## Install

Not published to npm yet. Install from the clone:

```bash
cd runmill && npm install && npm run build && npm link
runmill --version
```

`npm link` puts `runmill` on your PATH pointing at your working copy; `npm unlink -g runmill`
removes it.

**Run `npm run build` after every change.** The linked binary runs `dist/`, not your sources.
`npm link` only builds when it actually installs, so re-linking an already-linked package does
*not* rebuild, and a stale `dist/` looks exactly like a change that didn't work. During
development, skip the build and run the sources directly:

```bash
npx tsx src/cli/main.ts <command>
```

If that fails with `EACCES ... /usr/local/lib/node_modules`, the default npm prefix is root-owned,
which is common on macOS. Point npm at a directory you own rather than reaching for `sudo`:

```bash
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"   # add to your shell profile
npm link
```

## Use it on your own repository

```bash
cd ~/your-repo
runmill init      # writes runmill.yaml, the check manifest, and review skills
runmill doctor    # verifies this host can run safely
runmill next      # see what would be selected, and why everything else was not
runmill run ENG-123
```

`runmill init` infers your repository and base branch from git. Your team, workflow states, and
merge policy are left as editable placeholders, because a guessed merge policy isn't a guess worth
making.

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
| `runmill gc` | Reconcile workspaces left behind by crashed runs. `--dry-run` to preview |
| `runmill eval validate` | Check an evaluation suite's structure and composition |
| `runmill eval replay` | Replay a suite and report pass rates with confidence intervals |
| `runmill state` | State store health |
| `runmill feedback` | File an issue, with a support bundle |

Every command takes `--json`, `--quiet`, and `--config <path>`.

**Exit codes:** `0` success · `1` failure · `2` invalid configuration · `3` blocked on a human.

## Environment variables

| Variable | Does |
|---|---|
| `RUNMILL_DEMO=1` | In-memory backlog, provider, and forge, seeded with the bundled example issues. Never inferred, so a fake can't stand in for production without you knowing |
| `RUNMILL_FAKE_BACKLOG=<file>` | Read issues from a JSON fixture instead of a live backlog |
| `RUNMILL_SOURCE_REPO=<path>` | Repository to create run workspaces from. Defaults to the working directory |
| `RUNMILL_DATA_DIR=<path>` | Where the state database and workspaces live. Defaults to `./.runmill/state` |
| `LINEAR_API_KEY` | Backlog credential. The OS keychain is checked first |
| `GITHUB_TOKEN` | Forge credential. `gh auth token` is used when this is unset |

## What it is

Generation got cheap and asynchronous. Proving the work is ready did not get cheap at the same
rate. In GitLab's June 2026 survey of 1,528 developers and technology buyers, 85% said AI had moved
the bottleneck from writing code to reviewing and validating it, and 84% said the hardest part was
governing what happens after AI writes the code.

runmill wraps Codex and Claude Code and handles the parts they don't: picking which issue to work
on, claiming it so two workers can't take the same one, deciding what context the agent gets,
checking that the tests you cared about actually ran, and deciding whether the result can merge.
You delegate more work without delegating the definition of done.

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

## Isn't this just a loop?

The loop is three lines:

```bash
while :; do cat PROMPT.md | claude-code; done
```

That genuinely works when an oracle already exists. A flaky test is its own judge. A nightly e2e
suite is its own judge. A Sentry exception tells you both when to start and when you're done. If
that describes your problem, use the three lines. You don't need this.

It stops working when nothing outside the model can tell you the work is finished. Then the exit
condition becomes the model's own opinion, and "the agent said it was done" is a different claim
from "it is done" in exactly the cases you care about.

Harnesses get agents running, and Claude Code and Codex are very good at it. runmill does not
compete with them, and treats both as opaque. Swap the coding agent without rewriting your trust
model: the worker can change, the evidence contract stays the same.

Concretely, before anything reaches a pull request:

- Two workers cannot claim the same issue, because the claim is a compare-and-swap on a git ref
  and every later mutation is fenced on a generation number.
- The agent runs under Seatbelt or bubblewrap with your credentials denied, and `doctor` proves
  the denial by planting a secret and failing if it can be read.
- Every required check is discovered, run against the exact candidate commit in a clean detached
  worktree, and checked for undeclared skips. A suite that exits 0 having discovered no tests
  fails.
- Review runs in a fresh context, and its verdict is cross-checked. A clean report on a diff
  touching risky paths escalates rather than being believed.
- Merging stays locked until the credential provably cannot edit branch protection.

None of that is novel. It's mutual exclusion, least privilege, provenance, and separation of
duties, which is the point: once the worker is nondeterministic, the old answers stop being
optional.

What runmill does not claim is that your code is correct. It states exactly which checks were
required, that they were discovered rather than assumed, that they ran against a named candidate,
what they observed, whether anything was skipped, and which policy allowed the next transition.
Everything else is your tests' job.

## Design commitments

The orchestrator owns every side effect. Backlog transitions, PR creation, and merges run in
deterministic code, so the agent can't widen its own authority. It can add a required check; it
can't remove one.

Verification means coverage, not a green checkmark. Every required check has to be discovered, run
against the exact candidate commit in a clean detached worktree, and finish without an undeclared
skip. A command that exits 0 having run nothing has failed.

Review happens in a fresh context with no implementer narrative, and returns findings tied to a
file and a line. Its verdict is then cross-checked: a clean report on a diff touching risky paths
escalates instead of being believed.

Autonomy is tiered by risk. `pr-only` is the default. Auto-merge unlocks for low-risk changes only,
and only with a credential that provably cannot edit branch protection.

Runs fail closed. Ambiguity, a missing check, an unreachable sandbox, an unreadable branch
protection rule, or an unparseable review all stop the run. Knowing when not to merge is the point.

## Autonomy modes

| Mode | Behavior |
|---|---|
| `observe` | Selects and plans. No lease, no clone, no repository mutation |
| `pr-only` | Implements, verifies, reviews, fixes, opens a PR. Never merges. The default |
| `guarded-merge` | May merge low-risk changes after every automated and repository gate passes |
| `continuous` | Repeats guarded execution until work runs out, a budget is reached, or a breaker opens |

## What it's built on

runmill is deliberately thin. The parts that do the dangerous work are existing tools with real
track records, not something invented here.

Isolation is the OS, not a library. Prompts steer agents; boundaries constrain them. On Linux that's
[bubblewrap](https://github.com/containers/bubblewrap) (LGPL-2.1), the unprivileged sandbox
Flatpak uses, driven with `--unshare-net` and explicit bind mounts. On macOS it's Seatbelt via
`sandbox-exec`, which is Apple system software rather than an open source project. Its own man
page has said `DEPRECATED` for years while every sandboxed app on the platform continues to run on
the framework underneath. That is a real risk worth knowing about, and it is why `doctor` reports
what each mechanism can and cannot enforce instead of implying they are equivalent.

Coordination is git. The lease is a ref pushed to `origin`, so mutual exclusion comes from a
server-side atomic ref create and `--force-with-lease`, not from a lock service you have to run.

The coding agents are [Codex](https://github.com/openai/codex) and
[Claude Code](https://github.com/anthropics/claude-code). runmill treats both as opaque and does
not tune their prompts or manage their context. Adding a third is a new dialect, not a rewrite.

| Dependency | Does | License |
|---|---|---|
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Run state, events, and the side-effect outbox | MIT |
| [commander](https://github.com/tj/commander.js) | CLI parsing | MIT |
| [yaml](https://github.com/eemeli/yaml) | `runmill.yaml` and the check manifest | ISC |
| [zod](https://github.com/colinhacks/zod) | Validates review output before it is trusted | MIT |
| [@linear/sdk](https://github.com/linear/linear) | Backlog adapter | MIT |
| [@octokit/rest](https://github.com/octokit/rest.js) | GitHub adapter | MIT |

Six runtime dependencies, all MIT or ISC. `gh` is used to borrow an existing GitHub token, and
`security` to read the macOS keychain; both are optional and runmill falls back to environment
variables.

## Requirements

- macOS or Linux, arm64 or x64. Windows is not supported; `doctor` says so rather than failing
  obscurely.
- Node 20.11+, git, and a GitHub repository.
- Codex or Claude Code, installed and authenticated, unless you're running with `RUNMILL_DEMO=1`.
- A working sandbox: Seatbelt on macOS, bubblewrap on Linux. `runmill doctor --explain sandbox`
  covers what each platform can and cannot enforce.

## Configuration

`runmill.yaml` is explicit rather than inferred, and `runmill init` writes a working starting point
so you're never authoring it from nothing. The schema ships in the repository:

```yaml
# yaml-language-server: $schema=./runmill.schema.json
version: 1
autonomy: pr-only
```

Validate with `runmill config validate`; see everything including defaults with
`runmill config show`.

Where each file lives is a security property, not filing. Autonomy, budgets, and risk rules sit
outside the repository, so an inbound pull request can't change how much authority runmill has.
Checks and review rubrics sit inside it, versioned with the code, and are read from the base commit
so a pull request can't relax the rules that govern its own merge. Runtime state belongs to runmill
alone.

## Status

| Phase | State |
|---|---|
| Foundation: CLI, config, state store, selection, git-ref lease | Working |
| Agent execution: clone isolation, Seatbelt/bubblewrap sandbox, task packet | Working |
| Verified PR: manifest resolution, freshness proof, skip detection, reviews | Working |
| Governed merge: CI reconciliation, negative credential test, protected merge | Working |
| Live adapters: Linear, Codex / Claude Code, GitHub | Working |
| Continuous operation: daemon, circuit breakers | Working |
| Evaluation: historical replay, held-out suites | Working |
| Behavior handbook | Specified |

## Documentation

Start at [`docs/`](./docs/README.md).

| Document | Contents |
|---|---|
| [`docs/verification.md`](./docs/verification.md) | Why a green test run isn't proof of anything |
| [`docs/leases.md`](./docs/leases.md) | How two workers are stopped from taking the same issue |
| [`docs/autonomy.md`](./docs/autonomy.md) | The seven merge gates, and what `guarded-merge` actually requires |
| [`docs/sandbox.md`](./docs/sandbox.md) | What the agent can and cannot reach, per platform |
| [`docs/lifecycle.md`](./docs/lifecycle.md) | Run states, the side-effect outbox, crash recovery |
| [`docs/evaluation.md`](./docs/evaluation.md) | Measuring the harness against your own history |
| [`docs/configuration.md`](./docs/configuration.md) | Every configuration key, with defaults |
| [`docs/errors.md`](./docs/errors.md) | Every error code, what causes it, and how to fix it |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Development setup, tests, and how the layers fit |
| [`CHANGELOG.md`](./CHANGELOG.md) | What changed, and what upgrading requires |
| [`prd.md`](./prd.md) | Full specification, plus the review that shaped it |
| [`runmill.schema.json`](./runmill.schema.json) | Configuration schema (JSON Schema Draft 2020-12) |

## License

MIT. See [`LICENSE`](./LICENSE).

The license matters here for a specific reason. runmill reads your entire repository, holds a
backlog credential and a GitHub token, and can merge to your default branch. The security model is
a claim. A permissive license is what lets you check it instead of taking it on faith.
