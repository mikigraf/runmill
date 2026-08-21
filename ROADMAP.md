# Roadmap

Runmill is a developer preview. This roadmap describes direction, not delivery dates or support
commitments.

## Available

- Linear as the backlog and GitHub as the forge.
- Codex and Claude Code as implementers or independent reviewers.
- One isolated workspace per issue on macOS Seatbelt or Linux bubblewrap.
- Exact-candidate verification, fresh-context review, durable lease records, and explicit manual
  reconciliation after an abrupt process death.
- `observe` and `pr-only` delivery, with `pr-only` the recommended operating mode.
- A background daemon, control socket, Markdown run log, and optional OpenTUI dashboard.

## Experimental

- `guarded-merge` and `continuous`; automatic merge needs explicit evaluation against repository
  rules, classic branch protection, CI timing, and failure recovery.
- The TUI on Bun. The Node path needs Node 26.4+ with experimental FFI and is not part of the
  supported Node 22/24 daemon baseline.
- Evaluation replay as evidence for increasing autonomy.

## Planned

- A GitHub Issues backlog adapter with the same exact-target and pagination guarantees as Linear.
- Merge-queue-aware delivery.
- Dependency-stack delivery with retarget, rebase, and exact-evidence invalidation.
- Additional coding agents and review providers.
- Additional Git forges and backlog systems.
- A credential broker that keeps provider secrets outside agent-spawned processes.
- Stronger automatic-merge evaluation and a documented promotion path out of experimental status.
- Standalone or prebuilt TUI distribution without a second runtime surprise.
- Windows enforcement after a native sandbox boundary and CI coverage exist.
- Multi-host coordination after leases and side-effect reconciliation have public compatibility
  tests.
- Hosted workers only after operator policy, credential isolation, and tenancy boundaries are
  designed and audited.

## Explicitly out of scope

- Letting a model directly mutate the backlog, push branches, open or merge pull requests, or widen
  its own authority.
- Replacing repository CI, branch protection, or human review requirements.
- Claiming that model-generated code is correct without exact-commit evidence.
- Silently falling back to unsandboxed execution when enforcement is unavailable.
- Supporting arbitrary untrusted workloads on platforms without an enforceable sandbox boundary.
