<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mikigraf/runmill/main/assets/brand/runmill-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/mikigraf/runmill/main/assets/brand/runmill-mark-light.svg">
    <img src="https://raw.githubusercontent.com/mikigraf/runmill/main/assets/brand/runmill-mark-light.svg" alt="" width="88" height="88">
  </picture>
</p>

<h1 align="center">runmill</h1>

<p align="center">
  <strong>The exit condition for coding agents.</strong>
</p>

<p align="center">
  Runmill turns eligible Linear issues into verified, independently reviewed GitHub pull requests, then takes the next one.
</p>

<p align="center">
  <img alt="Status: developer preview" src="https://img.shields.io/badge/status-developer_preview-FF4D1F?style=flat-square&labelColor=111310">
  <a href="https://github.com/mikigraf/runmill/actions/workflows/ci.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/mikigraf/runmill/ci.yml?branch=main&style=flat-square&label=tests&labelColor=111310"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/github/license/mikigraf/runmill?style=flat-square&label=license&labelColor=111310"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="./docs/README.md">Documentation</a> ·
  <a href="./SECURITY.md">Security</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mikigraf/runmill/main/assets/runmill-tui.png" alt="Runmill processing a Linear issue through implementation, exact-commit verification, independent review, pull request delivery, and CI" width="920">
</p>

<details>
  <summary>Watch the complete delivery loop</summary>
  <p align="center">
    <img src="https://raw.githubusercontent.com/mikigraf/runmill/main/assets/runmill-tui.gif" alt="The Runmill TUI following an issue from claim through pull request delivery" width="920">
  </p>
</details>

> [!IMPORTANT]
> Runmill is a developer preview. Start with `pr-only`. Automatic merge modes are experimental.

Runmill works standalone as a backlog-to-PR product and is also part of
[Autonomous Software Factory (ASF)](./docs/asf-worker.md).

## Quick start

The demo runs one complete delivery loop with bundled integrations and temporary storage. It needs no credentials and leaves your repository alone.

Runmill is not published to npm yet, so install the source preview first:

```bash
git clone https://github.com/mikigraf/runmill.git
cd runmill
npm ci
npm run build
npm link
runmill demo
```

The demo selects a bundled issue, claims it, runs a simulated coding agent, verifies the candidate in a real Git repository, reviews it with fresh context, and delivers a simulated pull request.

## What happens during a run

1. **Claim.** Runmill selects an eligible Linear issue, maps it to a repository, and acquires a durable lease.
2. **Implement.** Codex or Claude Code works inside an isolated workspace with an enforced write scope.
3. **Verify.** Every required check runs against the exact candidate commit in a clean checkout.
4. **Review locally.** A new agent context reads the task and exact candidate, accounts for each acceptance criterion, and returns line-level findings.
5. **Deliver.** Runmill pushes the branch, opens the GitHub pull request, and reconciles CI and branch protection for that candidate SHA.
6. **Review the PR evidence.** Another fresh review receives the exact candidate plus Runmill's PR identity and CI verdicts.
7. **Repeat.** The daemon takes the next eligible issue, waits when the queue is empty, or escalates with a named reason.

```text
Backlog → Claim → Implement → Verify → Review → Pull request → CI → PR review → Repeat
```

The agents write and review code. Runmill controls backlog changes, repository effects, pull requests, and merge decisions.

## Why Runmill exists

### One issue has one owner

Git-ref leases prevent two workers from claiming the same issue. A worker that loses its lease is fenced out before another external mutation.

### A green command needs proof

Runmill ties every check result to the candidate commit. Merge modes require machine-readable test evidence and reject missing tests, undeclared skips, dirty worktrees, and zero-test passes. The generated `pr-only` policy may label a passing command `unproven` when setup cannot safely infer a reporter; that evidence can open a PR for a person, but it cannot authorize an automatic merge.

### Review starts clean

The reviewer receives the issue, acceptance criteria, and exact candidate checkout without the implementer's conversation history. Its workspace is read-only except for one pre-created JSON verdict file. After the push, PR review also receives orchestrator-owned PR identity and CI verdicts tied to the same SHA. Its structured verdict is checked against the full task and the paths that changed.

### Authority stays outside the model

Deterministic code owns pushes, pull requests, issue transitions, and merges. Stale, incomplete, contradictory, or unreadable evidence stops the run for a person.

## Support

| Surface                           | Current support                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Backlog                           | Linear                                                                                                                                         |
| Repository, pull requests, and CI | GitHub                                                                                                                                         |
| Coding agents                     | Codex CLI and Claude Code with a subscription session. Provider API keys are not yet supported inside the sandbox.                             |
| Agent roles                       | Either provider can implement or review. The reviewer always starts with fresh context.                                                        |
| Node.js                           | 22 or 24                                                                                                                                       |
| Host                              | macOS on arm64/x64, Linux on arm64/x64                                                                                                         |
| Sandbox                           | Seatbelt on macOS, bubblewrap on Linux                                                                                                         |
| Provider network                  | `proxy` currently permits unrestricted egress; hostname filtering is not implemented. `network_allowlist` is rejected until it is enforceable. |
| TUI                               | Bun, or Node 26.4+ with experimental FFI. The daemon and other commands run on Node 22 or 24.                                                  |
| Windows                           | Unsupported                                                                                                                                    |

`runmill doctor` checks Git, candidate commit identity and signing, local verification commands and locked dependencies, the configured GitHub repositories and base branches, Linear access, the configured agents, and the platform isolation mechanism. The GitHub check uses the exact credential Runmill will use and requires read and push access for every configured repository plus read access to every configured base branch. The provenance check creates a real candidate commit in a disposable repository, so a missing identity or unusable signer fails before Runmill claims an issue. Provider authentication and provider execution are separate checks: after authentication passes, doctor sends one short, one-turn request for each distinct configured provider/model inside the same sandbox used for real work. These requests use a small number of tokens and may be billable.

### Credential boundary

| Credential                           | Status                                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex or Claude subscription session | Experimental. Each run uses a disposable private copy, so tools cannot modify the real provider config. They can still read the copied credential. Use a dedicated subscription and stay in `pr-only`. |
| Provider API key                     | Unsupported until Runmill has a host-side credential broker. Provider keys are stripped from the agent and its tool subprocesses.                                                                      |
| GitHub and Linear credentials        | Supported. They stay in orchestrator-side adapters and never enter the agent process.                                                                                                                  |

## Install and connect a repository

Run the setup inside the repository you want Runmill to manage:

```bash
runmill init
runmill next
runmill start
```

`init` discovers existing GitHub and Linear access plus installed Codex and Claude CLIs. It never asks for GitHub or Linear secrets in an echoed terminal question: GitHub sign-in is delegated to `gh`, while Linear uses a preconfigured environment value or the stdin-only macOS keychain command. Init creates missing files, preserves existing ones, and then runs the full doctor check—including the small provider request—before it suggests `next` or `start`. If readiness fails, setup stops with the failed check and a fix. Use `runmill init --defaults` for a non-interactive setup.

For npm projects, run `npm ci` in the source checkout first. Init adds only verification scripts that actually exist in `package.json`; it does not guess `npm test` for another ecosystem. Doctor fetches the configured remote base without moving your local branch, reads the check manifest from that exact commit, and blocks when the local install would not work in the live workspace. It never runs an installer or warms the cache. Live checks reuse a lockfile-matching, read-only dependency cache, so the exact-commit verification checkout never installs packages or opens network access. If no safe check can be inferred, setup stops until you edit `.runmill/checks.yaml`.

Operator policy lives in your OS user-config directory. The repository keeps only its required checks and review instructions under `.runmill/`. Repository content can make a run stricter, but it cannot grant itself more authority.

Once the daemon is running:

```bash
runmill status
runmill tui
runmill stop
```

The TUI connects through a user-private local socket, so it can be opened from another directory. `runmill daemon` remains available for advanced foreground, one-shot, polling, and breaker options.

See [configuration](./docs/configuration.md) for single-repository routing, workflow states, checks, budgets, credentials, network policy, and risk paths.

## Autonomy

| Mode            | Maturity                       | Runmill may                                                         |
| --------------- | ------------------------------ | ------------------------------------------------------------------- |
| `observe`       | Developer preview              | Select and plan work without claiming it or changing the repository |
| `pr-only`       | Developer preview, recommended | Implement, verify, review, and open a pull request                  |
| `guarded-merge` | Experimental                   | Merge eligible low-risk changes after every configured gate passes  |
| `continuous`    | Experimental                   | Keep applying guarded merge policy across repeated runs             |

`pr-only` is the default. Automatic merge also requires `experimental.automatic_merge: true`, so changing the autonomy mode alone cannot enable it.

## Go deeper

| Topic                                    | Documentation                          |
| ---------------------------------------- | -------------------------------------- |
| Run states, recovery, and side effects   | [Lifecycle](./docs/lifecycle.md)       |
| Exact-commit evidence and check coverage | [Verification](./docs/verification.md) |
| Merge gates and authority                | [Autonomy](./docs/autonomy.md)         |
| Sandbox controls and platform gaps       | [Sandbox](./docs/sandbox.md)           |
| Durable claims across workers            | [Leases](./docs/leases.md)             |
| Background operation, TUI, and logs      | [Daemon operations](./docs/daemon.md)  |
| Historical replay and refusal accuracy   | [Evaluation](./docs/evaluation.md)     |
| Error codes and fixes                    | [Errors](./docs/errors.md)             |

For bugs and accepted feature work, use [GitHub Issues](https://github.com/mikigraf/runmill/issues). Read [SUPPORT.md](./SUPPORT.md) for setup help and diagnostic bundles. Changes are welcome through [CONTRIBUTING.md](./CONTRIBUTING.md).

Runmill is available under the [MIT License](./LICENSE).

<details>
  <summary>Command and environment reference</summary>

| Command                                                          | Purpose                                                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `runmill doctor`                                                 | Prove that this host, sandbox, credentials, and provider setup can run                                          |
| `runmill demo`                                                   | Run the zero-credential delivery loop in temporary storage                                                      |
| `runmill next`                                                   | Show the next issue and explain every rejection                                                                 |
| `runmill prepare <issue>`                                        | Score whether an issue is ready                                                                                 |
| `runmill run [issue]`                                            | Process one issue                                                                                               |
| `runmill start`                                                  | Start the background delivery loop                                                                              |
| `runmill status`                                                 | Inspect the background daemon                                                                                   |
| `runmill stop`                                                   | Request a safe stop at the next run boundary                                                                    |
| `runmill daemon`                                                 | Run foreground, one-shot, polling, and breaker modes                                                            |
| `runmill tui`                                                    | Open the terminal interface                                                                                     |
| `runmill list --needs-attention`                                 | Find runs waiting for a person                                                                                  |
| `runmill inspect <run-id>`                                       | Show transitions, evidence, and pending effects                                                                 |
| `runmill resume <run-id>`                                        | Explain why checkpoint continuation is unavailable in the preview; never changes state                          |
| `runmill effects list`                                           | Show ambiguous GitHub or backlog mutations that block new runs                                                  |
| `runmill effects resolve <key> --outcome <applied\|not-applied>` | Record an outcome verified in the remote system                                                                 |
| `runmill leases list`                                            | Show local lease rows left by interrupted runs                                                                  |
| `runmill leases resolve <issue> --confirm-remote-cleared`        | Clear a local row after the exact remote ref is gone                                                            |
| `runmill policy explain <run-id>`                                | Explain a delivery or merge decision                                                                            |
| `runmill init`                                                   | Configure Runmill and add missing repository files                                                              |
| `runmill config create`                                          | Legacy configuration-only setup. New installations should use `runmill init`.                                   |
| `runmill config validate`                                        | Validate operator policy and repository checks                                                                  |
| `runmill config show`                                            | Print the resolved policy with defaults                                                                         |
| `runmill auth status`                                            | Show which credentials currently resolve                                                                        |
| `runmill auth login <system>`                                    | Read a credential from redirected stdin and store it in the macOS keychain; secret command options are rejected |
| `runmill auth logout <system>`                                   | Remove a stored credential                                                                                      |
| `runmill skills eject`                                           | Write editable copies of the built-in review skills                                                             |
| `runmill skills validate`                                        | Validate configured review skills                                                                               |
| `runmill state`                                                  | Inspect the state store                                                                                         |
| `runmill gc`                                                     | Reconcile workspaces left by interrupted runs                                                                   |
| `runmill eval validate <suite>`                                  | Validate an evaluation suite                                                                                    |
| `runmill eval replay <suite>`                                    | Replay tasks with GitHub and backlog effects kept in memory                                                     |
| `runmill feedback`                                               | Open a support issue or print a redacted bundle                                                                 |

| Variable                         | Purpose                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| `RUNMILL_DEMO=1`                 | Use bundled in-memory integrations for source-level examples and tests |
| `RUNMILL_FAKE_BACKLOG=<file>`    | Load backlog issues from an explicit JSON fixture                      |
| `RUNMILL_SOURCE_REPO=<path>`     | Override the source repository used for workspaces                     |
| `RUNMILL_DATA_DIR=<path>`        | Override the machine-state directory                                   |
| `RUNMILL_DAEMON_REGISTRY=<path>` | Override daemon discovery                                              |

Every command accepts `--json`, `--quiet`, and `--config <path>`.

</details>
