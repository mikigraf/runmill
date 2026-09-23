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
  Runmill takes a Linear issue, has an agent implement it, checks and reviews the result, opens a GitHub pull request, and moves on to the next issue.
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

The demo runs one full delivery loop using bundled integrations and temporary storage. It needs no credentials and does not touch your repository.

Runmill is not published to npm yet, so install the source preview first:

```bash
git clone https://github.com/mikigraf/runmill.git
cd runmill
npm ci
npm run build
npm link
runmill demo
```

The demo picks a bundled issue, claims it, runs a simulated coding agent, verifies the result in a real Git repository, reviews it with a fresh agent, and opens a simulated pull request.

## What happens during a run

1. **Claim.** Runmill picks an eligible Linear issue, maps it to a repository, and takes a durable lease on it.
2. **Implement.** Codex or Claude Code works inside an isolated workspace with an enforced write scope.
3. **Verify.** Every required check runs against the exact candidate commit in a clean checkout.
4. **Review locally.** A fresh agent reads the task and the exact candidate commit, checks each acceptance criterion, and returns line-level findings.
5. **Deliver.** Runmill pushes the branch, opens the GitHub pull request, and checks CI and branch protection for that exact SHA.
6. **Review the PR evidence.** A second fresh review gets the same commit plus the PR details and CI results that Runmill recorded.
7. **Repeat.** The daemon takes the next eligible issue, waits if the queue is empty, or hands the issue to a person with a stated reason.

```text
Backlog → Claim → Implement → Verify → Review → Pull request → CI → PR review → Repeat
```

The agents write and review code. Runmill controls backlog changes, repository effects, pull requests, and merge decisions.

You can check signed delivery evidence on another machine that has no Runmill state:

```bash
runmill evidence verify evidence.json --trust trusted-signers.json --expectations candidate-facts.json
```

Add `--artifacts-dir` to also re-hash the artifact files, not just the signed statement.

## Why Runmill exists

### One issue has one owner

Leases stored as Git refs stop two workers from claiming the same issue. A worker that loses its lease is blocked before it can make another external change.

### A green command needs proof

Runmill ties every check result to the candidate commit. Merge modes need machine-readable test results and reject missing tests, undeclared skips, dirty worktrees, and runs that pass with zero tests. If setup cannot work out a test reporter, the generated `pr-only` policy may mark a passing command `unproven`. That is enough to open a PR for a person to review, but not enough for an automatic merge.

### Review starts clean

The reviewer gets the issue, the acceptance criteria, and a checkout of the exact candidate, but not the implementer's conversation. Its workspace is read-only apart from one JSON file for its verdict. After the push, the PR review also gets the PR details and CI results that the orchestrator recorded for the same SHA. Runmill checks the verdict against the full task and the list of changed paths.

### Authority stays outside the model

Pushes, pull requests, issue transitions, and merges are done by ordinary code, not by the model. If evidence is stale, incomplete, contradictory, or unreadable, the run stops and waits for a person.

## Support

| Surface                           | Current support                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Backlog                           | Linear                                                                                                                                         |
| Repository, pull requests, and CI | GitHub                                                                                                                                         |
| Coding agents                     | Codex CLI and Claude Code with a subscription session. Provider API keys are not yet supported inside the sandbox.                             |
| Agent roles                       | Either provider can implement or review. The reviewer always starts with fresh context.                                                        |
| Node.js                           | 22 or 24                                                                                                                                       |
| Git                               | 2.45 or newer; exact policy reads require fail-closed `--no-lazy-fetch` support.                                                               |
| Host utilities/read-only flows   | macOS on arm64/x64 and Linux on arm64/x64                                                                                                      |
| Agent execution backend           | Currently fails closed on every host. Darwin awaits lifecycle containment; Linux awaits complete descriptor-bound bubblewrap qualification.    |
| Provider network                  | `proxy` currently permits unrestricted egress; hostname filtering is not implemented. `network_allowlist` is rejected until it is enforceable. |
| TUI                               | Bun, or Node 26.4+ with experimental FFI. The daemon and other commands run on Node 22 or 24.                                                  |
| Windows                           | Unsupported                                                                                                                                    |

`runmill doctor` checks Git, the commit identity and signing setup, local verification commands and locked dependencies, configured remotes, credentials, and the platform sandbox. The provenance check makes a real commit in a throwaway repository, so a missing identity or broken signer shows up before Runmill claims an issue. Provider sign-in and a one-turn test run are separate checks. Neither runs until a production sandbox exists, so doctor currently stops at that point.

### Credential boundary

| Credential                           | Status                                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex or Claude subscription session | Experimental. Each run gets a private throwaway copy, so tools cannot change the real provider config. They can still read the copied credential. Use a dedicated subscription and stay in `pr-only`.           |
| Provider API key                     | Unsupported until Runmill has a host-side credential broker. Provider keys are removed from the agent and its tool subprocesses.                                                                        |
| GitHub and Linear credentials        | Supported. They stay in orchestrator-side adapters and never enter the agent process.                                                                                                                  |

## Install and connect a repository

Run the setup inside the repository you want Runmill to manage:

```bash
runmill init
runmill next
runmill start
```

`init` finds the GitHub and Linear access you already have. It never asks you to type a GitHub or Linear secret at a visible prompt: GitHub sign-in goes through `gh`, and Linear uses an existing environment variable or the stdin-only macOS keychain command. Init creates missing files and leaves existing ones alone. Before running doctor, it checks that the configured sandbox is the exact qualified backend Runmill was built with. No local backend is production-qualified yet, so init writes a `native` policy and then stops at that check; the provider CLI, sign-in, and request probes never run. Use `runmill init --defaults` for non-interactive setup.

For npm projects, run `npm ci` in the source checkout first. Init only adds verification scripts that exist in `package.json`; it does not guess `npm test` for other ecosystems. Doctor fetches the configured remote base without moving your local branch, reads the check manifest from that commit, and blocks if your local install would not work in the live workspace. It never runs an installer or fills a cache. Live checks reuse a read-only dependency cache that matches the lockfile, so the verification checkout never installs packages or uses the network. If init cannot find a safe check, setup stops until you edit `.runmill/checks.yaml`.

Operator policy lives in your OS user-config directory. The repository only keeps its required checks and review instructions, under `.runmill/`. Repository content can make a run stricter, but it cannot give itself more authority.

Once the daemon is running:

```bash
runmill status
runmill tui
runmill stop
```

The TUI connects through a local socket that only your user can reach, so you can open it from any directory. `runmill daemon` is still there for foreground, one-shot, polling, and breaker options.

See [configuration](./docs/configuration.md) for single-repository routing, workflow states, checks, budgets, credentials, network policy, and risk paths.

## Autonomy

| Mode            | Maturity                       | Runmill may                                                         |
| --------------- | ------------------------------ | ------------------------------------------------------------------- |
| `observe`       | Developer preview              | Select and plan work without claiming it or changing the repository |
| `pr-only`       | Developer preview, recommended | Implement, verify, review, and open a pull request                  |
| `guarded-merge` | Experimental                   | Merge eligible low-risk changes after every configured gate passes  |
| `continuous`    | Experimental                   | Keep applying guarded merge policy across repeated runs             |

`pr-only` is the default. Automatic merge also needs `experimental.automatic_merge: true`, so changing the autonomy mode alone does not turn it on.

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

Report bugs and accepted feature work in [GitHub Issues](https://github.com/mikigraf/runmill/issues). See [SUPPORT.md](./SUPPORT.md) for setup help and diagnostic bundles, and [CONTRIBUTING.md](./CONTRIBUTING.md) to send changes.

Runmill is available under the [MIT License](./LICENSE).

<details>
  <summary>Command and environment reference</summary>

| Command                                                          | Purpose                                                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `runmill doctor`                                                 | Check that this host, sandbox, credentials, and provider setup can run                                          |
| `runmill demo`                                                   | Run the zero-credential delivery loop in temporary storage                                                      |
| `runmill next`                                                   | Show the next issue and explain every rejection                                                                 |
| `runmill prepare <issue>`                                        | Score whether an issue is ready                                                                                 |
| `runmill run [issue]`                                            | Process one issue                                                                                               |
| `runmill start`                                                  | Start the background delivery loop (refuses to create one in `observe` mode)                                    |
| `runmill status`                                                 | Inspect the background daemon                                                                                   |
| `runmill stop`                                                   | Request a safe stop at the next run boundary                                                                    |
| `runmill daemon`                                                 | Run foreground, one-shot, polling, and breaker modes (refuses to start in `observe` mode)                       |
| `runmill tui`                                                    | Open the terminal interface                                                                                     |
| `runmill list --needs-attention`                                 | Find runs waiting for a person                                                                                  |
| `runmill inspect <run-id>`                                       | Show transitions, evidence, and pending effects                                                                 |
| `runmill resume <run-id>`                                        | Explain why resuming from a checkpoint is not available in the preview; never changes state                     |
| `runmill effects list`                                           | Show ambiguous GitHub or backlog mutations that block new runs                                                  |
| `runmill effects resolve <key> --outcome <applied\|not-applied>` | Record an outcome verified in the remote system                                                                 |
| `runmill leases list`                                            | Show local lease rows left by interrupted runs                                                                  |
| `runmill leases resolve <issue> --confirm-remote-cleared`        | Clear a local row after the exact remote ref is gone                                                            |
| `runmill policy explain <run-id>`                                | Show persisted policy decisions; report `unknown` when no decision evidence exists                              |
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
