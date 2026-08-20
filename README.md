# Runmill

*The delivery loop for autonomous software factories.*

**Turn your backlog into reviewed pull requests.**

Runmill keeps Codex and Claude Code working through eligible Linear issues without someone
prompting, monitoring, and restarting them after every task.

For each issue, Runmill creates an isolated workspace, runs the coding agent, verifies the exact
commit it produced, starts an independent review with fresh context, opens the GitHub pull request,
waits for CI, and decides what may happen next.

```text
Linear issue
    ↓
claim → implement → verify → independent review → GitHub PR → CI
    ↑                                                       ↓
    └──────────── wait for the next eligible issue ─────────┘
```

**The agent writes code. Runmill owns the delivery process.**

Runmill, not the model, controls backlog mutations, repository effects, pull requests, and merge
decisions. If required evidence is missing, stale, contradictory, or impossible to establish, the
run stops for a person.

![Runmill OpenTUI showing a live agent review, verification events, and daemon logs](./assets/runmill-tui.gif)

[Documentation](./docs/README.md) · [Configuration](./docs/configuration.md) · [Daemon operations](./docs/daemon.md)

## The engineering loop around your coding agents

Coding agents can implement a well-scoped task. The surrounding workflow still needs an owner:

- selecting the next eligible issue
- preventing two workers from claiming the same task
- creating an isolated workspace
- providing bounded repository context
- verifying the resulting commit
- reviewing it independently
- opening the pull request
- waiting for CI and branch protection
- recovering from crashes and ambiguous external operations
- stopping when repeated failures indicate a systemic problem

Runmill owns that workflow as a durable, deterministic state machine.

**Queue → Run → Verify → Review → Deliver → Repeat**

It is not another coding agent and it does not replace CI. It is the delivery system around Codex
and Claude Code.

## Why Runmill

- **Backlog-driven:** continuously processes eligible Linear issues
- **Provider-neutral:** use Codex, Claude Code, or one to review the other
- **Isolated:** every issue runs in a dedicated sandboxed workspace
- **Verifiable:** required checks run against the exact candidate commit
- **Independently reviewed:** reviewers receive fresh context rather than the implementer's narrative
- **Durable:** state, evidence, leases, and intended side effects survive restarts
- **Fail-closed:** missing or unknown evidence stops the run
- **Governed:** deterministic code, not the agent, owns external effects and merge authority
- **Human-aware:** ambiguous, risky, or exhausted runs escalate with a named reason

Runmill does not claim an agent-generated change is correct. It records what was checked, what was
reviewed, which policy ran, and why the change was allowed to continue.

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
