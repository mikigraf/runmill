<p align="center">
  <img src="https://raw.githubusercontent.com/mikigraf/runmill/main/assets/brand/runmill-mark-light.svg" alt="" width="64" height="64">
</p>

# Runmill documentation

Runmill owns the delivery loop around Codex and Claude Code. It selects eligible Linear issues, claims one, runs the agent in an isolated workspace, verifies the exact candidate, starts an independent review, opens the GitHub pull request, and returns to the queue.

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

`runmill init` writes the missing setup files and immediately runs doctor before it suggests the
next command. Provider readiness includes one small, potentially billable request for each
distinct configured provider/model inside Runmill's real sandbox; authentication status alone is
not treated as proof that the agent can run.

Setup also requires at least one real verification command. Init infers only scripts that exist in
a locked npm project and blocks on `checks: []` for an unknown ecosystem. Run `npm ci` in the
source checkout first. Doctor proves the installed inventory matches the lockfile without installing
or warming a cache; exact-commit checks then reuse that matching tree read-only and never enable
network access inside verification.

Operator policy lives outside the repository in the OS user-config directory. The repository keeps its check manifest and review instructions under `.runmill/`. The effective policy only gets stricter when repository content changes.

## Follow one run

| Stage | What Runmill owns | Documentation |
| --- | --- | --- |
| Claim | Eligibility, repository routing, and one durable owner | [Leases](./leases.md) |
| Implement | Workspace creation, sandbox boundary, budgets, and agent context | [Lifecycle](./lifecycle.md), [Sandbox](./sandbox.md) |
| Verify | Required checks tied to one commit and tree | [Verification](./verification.md) |
| Review | Fresh context, acceptance criteria, findings, and bounded fixes | [Lifecycle](./lifecycle.md) |
| Deliver | Pushes, pull requests, CI reconciliation, and merge policy | [Autonomy](./autonomy.md) |
| Repeat | Idle polling, crash inspection, explicit recovery, circuit breakers, and operator controls | [Daemon operations](./daemon.md) |

An engineering run covers one issue, one lease, one isolated implementation, one evidence bundle, and one delivery decision. Runmill stores every transition plus the reason for a retry, refusal, quarantine, or escalation.

## The rules behind the loop

### External effects belong to the orchestrator

Agents propose and inspect changes. Deterministic code handles issue transitions, pushes, pull requests, and merges. An agent can add a required check, but it cannot remove one or widen its own authority.

### Evidence describes the exact candidate

A passing command is insufficient when a check was missing, skipped without permission, ran against another tree, or discovered no tests. Runmill records coverage and binds the result to the commit that may be delivered.

### Review gets fresh context

The reviewer sees the task, acceptance criteria, and exact candidate checkout without the
implementer's conversation. After the push, PR review also receives orchestrator-owned PR identity
and CI verdicts tied to the same SHA. Its verdict is checked against changed paths and the complete
acceptance-criteria list.

### Uncertainty stops the run

Unreadable branch protection, stale evidence, a failed sandbox probe, lease loss, or malformed review output sends the issue to a person. `pr-only` remains the default. Automatic merge needs both an experimental mode and `experimental.automatic_merge: true`.

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

Runtime and development dependencies are pinned. Use `npm ci` when working from source.
