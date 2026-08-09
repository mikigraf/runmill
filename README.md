# Runmill

## Just give your agents a backlog

**Your coding agent shouldn't wait for your next prompt.**

Runmill gives Codex and Claude Code a backlog and keeps them working through it.

It picks up eligible Linear issues, gives each one an isolated workspace, runs the agent, verifies the exact commit it produced, sends the change through a fresh-context review, opens the pull request, waits for CI, and then picks up the next issue.

Your agents write code. Runmill keeps the engineering loop running.

![Runmill OpenTUI showing a live agent review, verification events, and daemon logs](./assets/runmill-tui.gif)

[Documentation](./docs/README.md) · [Configuration](./docs/configuration.md) · [Daemon operations](./docs/daemon.md)

## Your backlog is the prompt

Coding agents are already pretty good at completing a task once you give them one.

The annoying part is everything around that task.

Someone still has to decide what they should work on next, make sure two agents do not pick up the same issue, create an isolated workspace, run the right checks, review what they produced, open the PR, wait for CI, update the backlog, and then start the whole thing again.

Runmill does that part.

**Queue → Run → Verify → Review → Deliver → Repeat**

```text
queue → claim → implement → verify → fresh review → deliver
  ↑                                                      │
  └──────────────── wait for more work ←─────────────────┘
```

Runmill is not another coding agent and it is not a replacement for CI. It is the deterministic delivery loop around the agents you already use.

### Queue

Runmill watches Linear for eligible work, routes each issue to the right repository, and claims it using a Git-backed lease so two workers cannot accidentally take the same task.

### Run

Every issue gets its own isolated workspace and a bounded task packet.

Codex or Claude Code implements the change within the configured time, cost, and risk limits. Run state is durable, so an interruption does not mean starting from zero.

### Verify

Runmill checks the actual candidate commit, not whatever happens to be in the workspace later.

Required checks run against that commit in a clean checkout. If evidence is missing or stale, the run stops.

### Review

The reviewer starts from fresh context instead of inheriting the implementer's reasoning.

It has to account for every acceptance criterion. Blocking findings go through a bounded fix loop. If Runmill cannot establish enough confidence to continue, it gives the run to a person.

### Deliver

Once the gates pass, Runmill pushes the branch, opens the GitHub pull request, waits for CI, applies the configured merge policy, and updates the backlog.

### Repeat

Then it takes the next issue.

If there is nothing to do, it waits.

That sounds obvious, but it is an important difference from scripts that process one task and terminate. Runmill is meant to keep a real engineering queue moving.

## Agents write code. Deterministic code owns the workflow.

There is one boundary in Runmill that is deliberate:

**The agent can propose and review code. It does not get to own the delivery system.**

Agents do not mutate the backlog, push branches, create pull requests, or merge changes directly. Runmill's deterministic orchestration code owns those effects.

For every issue, Runmill keeps an engineering run containing:

* the issue, repository, and base revision;
* the implementer and reviewer configuration;
* the candidate commit and verification evidence;
* the independent review;
* intended and completed external effects;
* PR, CI, and merge-policy state; and
* why the run continued, retried, stopped, escalated, or entered quarantine.

SQLite is the system of record. `.runmill/log.md` gives you a readable, timestamped journal of completed deliveries and merges.

Runmill does **not** claim that an agent-generated change is correct.

It tells you something much more defensible: exactly what was checked, what was reviewed, which policy ran, and why Runmill allowed the change to continue.

## Quick start

Runmill is not on npm yet.

```bash
git clone https://github.com/mikigraf/runmill.git
cd runmill
npm ci
npm run build
npm link
```

Then, inside the repository you want Runmill to manage:

```bash
runmill config create   # configure GitHub, Linear and your agents
runmill init            # add checks and review rules
runmill doctor          # make sure the environment is ready
runmill next            # see what Runmill would pick up next
runmill daemon --detach # give it the backlog
runmill tui             # watch it work
```

The setup wizard discovers authenticated `gh`, Linear credentials, Codex, and Claude when available. You can use installed CLI subscriptions or API keys.

Secrets are never written to `runmill.yaml`.

For CI or scripted environments:

```bash
runmill config create --defaults
runmill config validate
runmill daemon --once
```

`--once` processes the work that is currently eligible and exits.

Without it, Runmill keeps watching the backlog. By default it checks every 30 seconds while idle.

## Watch it work

`runmill tui` opens the live OpenTUI interface for a running daemon.

You can see what Runmill is working on, where the current issue is in the pipeline, what the agents are doing, verification and review events, recent runs, logs, and pending external effects.

You can start Runmill in the background:

```bash
runmill daemon --detach
```

and open the TUI from another directory:

```bash
runmill tui
```

The TUI talks to the daemon over a user-private `0600` Unix socket. It does not open Runmill's database or guess where your project lives.

It can also ask the daemon to stop safely at the next run boundary.

## Try it without giving it credentials

There is an explicit demo mode with in-memory integrations:

```bash
cd examples/quickstart
RUNMILL_DEMO=1 npx tsx ../../src/cli/main.ts next --dry-run
RUNMILL_DEMO=1 npx tsx ../../src/cli/main.ts daemon --once
```

Runmill never silently replaces a real integration with a fake one.

## Configuration

A minimal `runmill.yaml` looks like this:

```yaml
# yaml-language-server: $schema=./runmill.schema.json
version: 1
autonomy: pr-only

providers:
  implementer:
    implementation: codex
  reviewer:
    implementation: claude

backlog:
  provider: linear
  team: ENG
  eligible_states: [Todo, Ready]
  claim_state: In Progress
  delivered_state: In Review

github:
  repositories:
    - match: { team: ENG }
      repo: acme/platform
      base_branch: main
```

The implementer and reviewer can use different providers or the same one.

For example, Codex can implement and Claude can review. Or Codex can do both. The important part is that the review starts without the implementer's conversation history.

See the [configuration reference](./docs/configuration.md) for checks, budgets, repository routing, risk paths, credentials, and merge policies.

## Start with boring work

Runmill works best when the task has clear acceptance criteria, bounded repository scope, deterministic checks, and a reasonably repeatable definition of done.

Good first workloads include:

* test repairs;
* dependency maintenance;
* narrow bug fixes;
* small refactors;
* type-safety work; and
* code-adjacent maintenance.

Do not start by handing it your company's most ambiguous architectural project.

Connect one Linear team, one GitHub repository, leave Runmill in `pr-only`, and see what happens.

Uncertain runs escalate instead of pretending they are certain.

## Built for unattended runs

A few things become surprisingly important once you stop sitting in front of the agent.

**It actually idles.**
When the Linear queue is empty, Runmill waits for more work instead of terminating.

**Your laptop does not fall asleep halfway through an issue.**
Runmill uses `caffeinate` on macOS or `systemd-inhibit` on Linux while it is running.

**Stopping it does not kill whatever happens to be in flight.**
`SIGINT` and `SIGTERM` request a safe stop at the next run boundary.

**One bad condition cannot churn through your entire backlog.**
Circuit breakers can stop the daemon based on repeated failures, quarantines, escalation rates, or daily spend.

**State survives restarts.**
Leases, transitions, check evidence, and intended external effects are durable.

**You can see when Runmill needs you.**

```bash
runmill list --needs-attention
runmill inspect <run-id>
runmill policy explain <run-id>
```

## How much autonomy do you want?

Runmill has four autonomy modes:

| Mode            | What Runmill can do                                                 |
| --------------- | ------------------------------------------------------------------- |
| `observe`       | Select and plan work without claiming it or changing the repository |
| `pr-only`       | Implement, verify, review, and open a PR, but never merge           |
| `guarded-merge` | Merge eligible low-risk changes after every configured gate passes  |
| `continuous`    | Keep applying guarded merge policy across repeated runs             |

`pr-only` is the default.

The daemon can run continuously in any active mode. The autonomy setting controls what an individual run is allowed to do, not whether Runmill stays alive.

## Evidence before autonomy

Runmill is deliberately conservative about what counts as evidence:

* Git-ref leases prevent duplicate claims.
* Agent workspaces are sandboxed with Seatbelt on macOS or bubblewrap on Linux.
* Required checks run against the exact candidate commit in a clean checkout.
* Reviews start with fresh context and cover every acceptance criterion.
* Sensitive paths and incomplete evidence escalate.
* Deterministic orchestration—not the agent—owns backlog mutations, pushes, PRs, and merges.

The goal is not to pretend autonomous coding is magically safe.

The goal is to make the boundary between **what the model decided** and **what the system allowed** explicit.

## Useful commands

| Command                                            | What it does                                               |
| -------------------------------------------------- | ---------------------------------------------------------- |
| `runmill config create`                            | Configure Runmill from discovered tools and integrations   |
| `runmill config validate`                          | Validate the configuration and check manifest              |
| `runmill config show`                              | Show the resolved configuration                            |
| `runmill doctor`                                   | Check credentials, CLIs, Git, sandboxing, and the host     |
| `runmill next`                                     | Show the next issue and why other candidates were rejected |
| `runmill prepare <issue>`                          | Check whether an issue is ready                            |
| `runmill run [issue]`                              | Process one issue                                          |
| `runmill daemon`                                   | Keep watching the backlog and processing work              |
| `runmill daemon --detach`                          | Run the daemon in the background                           |
| `runmill daemon --once`                            | Process eligible work and exit                             |
| `runmill tui`                                      | Watch the running daemon                                   |
| `runmill list --needs-attention`                   | Find runs waiting for a person                             |
| `runmill inspect <run-id>`                         | Inspect transitions, evidence, and pending effects         |
| `runmill resume <run-id>`                          | Resume a paused run                                        |
| `runmill policy explain <run-id>`                  | Explain why a merge was or was not allowed                 |
| `runmill auth status`                              | Show available credentials                                 |
| `runmill auth login` / `runmill auth logout`       | Manage stored credentials                                  |
| `runmill skills eject` / `runmill skills validate` | Customize or validate review rules                         |
| `runmill state`                                    | Inspect the local state store                              |
| `runmill gc`                                       | Reconcile workspaces left by interrupted runs              |
| `runmill eval validate <suite>`                    | Validate an evaluation suite                               |
| `runmill eval replay <suite>`                      | Replay historical tasks through Runmill                    |
| `runmill feedback`                                 | Open a support issue with diagnostics                      |

Every command supports `--json`, `--quiet`, and `--config <path>`.

Run `runmill --help` for everything else.

## Requirements

* macOS or Linux, arm64 or x64
* Node.js 20.11+
* Git and an authenticated GitHub account
* Codex or Claude Code CLI
* Seatbelt on macOS or bubblewrap on Linux
* `caffeinate` on macOS or `systemd-inhibit` on Linux
* Bun for `runmill tui`

The daemon itself does not require Bun.

Linear is currently the live backlog provider. GitHub handles repositories, pull requests, CI, branch protection, and merges.

## Environment variables

| Variable                         | Purpose                                                     |
| -------------------------------- | ----------------------------------------------------------- |
| `RUNMILL_DEMO=1`                 | Use the bundled in-memory integrations                      |
| `RUNMILL_FAKE_BACKLOG=<file>`    | Load backlog issues from a JSON fixture                     |
| `RUNMILL_SOURCE_REPO=<path>`     | Override the source repository for workspaces               |
| `RUNMILL_DATA_DIR=<path>`        | Override Runmill's state and workspace directory            |
| `RUNMILL_DAEMON_REGISTRY=<path>` | Override daemon discovery, mainly for isolation and testing |

## Documentation

* [Daemon operation](./docs/daemon.md)
* [Configuration](./docs/configuration.md)
* [Run lifecycle and recovery](./docs/lifecycle.md)
* [Verification and check coverage](./docs/verification.md)
* [Autonomy and merge gates](./docs/autonomy.md)
* [Issue leases](./docs/leases.md)
* [Sandboxing](./docs/sandbox.md)
* [Historical evaluation](./docs/evaluation.md)
* [Errors](./docs/errors.md)
* [Contributing](./CONTRIBUTING.md)

## License

MIT. See [LICENSE](./LICENSE).
