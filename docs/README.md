<p align="center">
  <img src="https://raw.githubusercontent.com/mikigraf/runmill/main/assets/brand/runmill-mark-light.svg" alt="" width="64" height="64">
</p>

# Runmill documentation

Runmill runs the delivery loop around Codex and Claude Code. It picks an eligible Linear issue, claims it, runs the agent in an isolated workspace, verifies the exact candidate commit, gets an independent review, opens the GitHub pull request, and goes back to the queue.

```text
Backlog → Claim → Implement → Verify → Review → Pull request → CI → PR review → Repeat
```

> [!IMPORTANT]
> Runmill is a developer preview. Use `pr-only` while evaluating it. `guarded-merge` and `continuous` are experimental.

## Start here

| Goal | Read or run |
| --- | --- |
| See the loop without credentials | `runmill demo` |
| Connect a repository | [Installation and setup](../README.md#install-and-connect-a-repository) |
| Configure teams, repositories, agents, and checks | [Configuration](./configuration.md) |
| Leave Runmill working in the background | [Daemon operations](./daemon.md) |
| Find out why the host is blocked | `runmill doctor`, then [Errors](./errors.md) |

`runmill init` writes any missing setup files and runs doctor straight away, before it suggests
the next command. The provider readiness check sends one small, possibly billable request to each
distinct configured provider/model inside Runmill's real sandbox. Being signed in is not taken as
proof that the agent can run.

Setup also needs at least one real verification command. Init only picks up scripts that exist in
a locked npm project, and blocks on `checks: []` for an ecosystem it doesn't know. Run `npm ci` in
the source checkout first. Doctor checks that what is installed matches the lockfile, without
installing anything or filling a cache. Exact-commit checks then reuse that tree read-only, and
verification never gets network access.

Operator policy lives outside the repository, in the OS user-config directory. The repository keeps its check manifest and review instructions under `.runmill/`. Changes to repository content can only make the effective policy stricter.

## Follow one run

| Stage | What Runmill owns | Documentation |
| --- | --- | --- |
| Claim | Eligibility, repository routing, and one durable owner | [Leases](./leases.md) |
| Implement | Workspace creation, sandbox boundary, budgets, and agent context | [Lifecycle](./lifecycle.md), [Sandbox](./sandbox.md) |
| Verify | Required checks tied to one commit and tree | [Verification](./verification.md) |
| Review | Fresh context, acceptance criteria, findings, and bounded fixes | [Lifecycle](./lifecycle.md) |
| Deliver | Pushes, pull requests, CI reconciliation, and merge policy | [Autonomy](./autonomy.md) |
| Repeat | Idle polling, crash inspection, explicit recovery, circuit breakers, and operator controls | [Daemon operations](./daemon.md) |

One run means one issue, one lease, one isolated implementation, one evidence bundle, and one delivery decision. Runmill stores every transition, along with the reason for any retry, refusal, quarantine, or escalation.

## The rules behind the loop

### External effects belong to the orchestrator

Agents propose and inspect changes. Ordinary deterministic code handles issue transitions, pushes, pull requests, and merges. An agent can add a required check. It cannot remove one or widen its own authority.

### Evidence describes the exact candidate

A passing command is not enough if a check was missing, skipped without permission, ran against a different tree, or found no tests. Runmill records coverage and ties the result to the commit that may be delivered.

### Review gets fresh context

The reviewer sees the task, the acceptance criteria, and a checkout of the exact candidate, but not
the implementer's conversation. After the push, the PR review also gets the PR details and CI
results that the orchestrator recorded for the same SHA. Runmill checks its verdict against the
changed paths and the full list of acceptance criteria.

### Uncertainty stops the run

If branch protection can't be read, evidence is stale, a sandbox probe fails, the lease is lost, or review output is malformed, the issue goes to a person. `pr-only` stays the default. Automatic merge needs both an experimental mode and `experimental.automatic_merge: true`.

## Operate and inspect

```bash
runmill start
runmill status
runmill tui
runmill list --needs-attention
runmill inspect <run-id>
runmill policy explain <run-id>
runmill stop
```

The TUI is optional. It needs Bun, or Node 26.4+ with experimental FFI. The daemon and CLI support Node 22 and 24.

## Reference

| Page | Contents |
| --- | --- |
| [Configuration](./configuration.md) | Operator policy, repository checks, defaults, and examples |
| [Errors](./errors.md) | Every error code, its cause, and a concrete fix |
| [Evaluation](./evaluation.md) | Replay against repository history and refusal accuracy |
| [`runmill.schema.json`](../runmill.schema.json) | Editor validation and autocomplete |
| [Security policy](../SECURITY.md) | Supported versions, private reporting, and threat boundary |
| [Support](../SUPPORT.md) | Setup help, diagnostic reports, and issue routing |
| [Releasing](./releasing.md) | Trusted publishing, provenance, signed tags, and the maintainer release gate |
| [ASF worker](./asf-worker.md) | The explicit Autonomous Software Factory integration, composed by the operator |

Runtime and development dependencies are pinned. Use `npm ci` when working from source.
