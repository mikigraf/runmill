# Changelog

Notable changes to runmill. Format follows [Keep a Changelog](https://keepachangelog.com/1.1.0/);
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

Upgrades should be boring. Anything that requires action on your part appears under
**Upgrade notes** with the exact command to run.

## [Unreleased]

Changes queued for the first developer-preview release.

### Added

- `runmill eval validate` and `runmill eval replay` — the evaluation harness. Replays a suite of
  tasks derived from your own history through the real selection and orchestration path, and
  reports pass rates with 95% confidence intervals. Refusal accuracy is reported separately and
  decides the exit code on its own: a harness that stops escalating has regressed no matter what
  the aggregate says. `eval validate` rejects a suite in which every task expects success.
- `runmill gc` — reconcile workspaces left behind by crashed runs.
- The `PR_REVIEW` stage, which previously shipped as scaffolding and never ran.
- `docs/` — conceptual documentation for the mechanisms the CLI cannot explain on its own:
  the coverage contract, the lease model, the seven merge gates, the sandbox, the run lifecycle,
  and a full configuration reference. `test/docs/contract.test.ts` fails if a doc cites a command,
  flag, error code, source file, or link that does not exist.
- The check manifest is now actually loaded. `.runmill/checks.yaml` was written by `runmill init`
  and pointed at by `verification.manifest`, but nothing read it: checks came only from
  operator policy. `declared_skips` therefore never parsed, so declaring a skip was impossible.
- `runmill config validate` validates the check manifest too, naming the offending check.
- `runmill init` — writes an operator-owned policy outside the repository plus
  `.runmill/checks.yaml` and review skills in the repository, inferring the repository and base
  branch from git. Re-running it preserves every existing file and repairs only missing assets.
- `runmill prepare <issue>` — scores how ready an issue is to run and names what is missing, so an
  underspecified issue is caught before a run spends money rather than after.
- `runmill inspect <run-id>`, `runmill policy explain <run-id>`, `runmill effects list|resolve`,
  and `runmill leases list|resolve` — the run introspection and explicit recovery surface.
  `runmill resume` remains as a compatibility diagnostic that refuses checkpoint continuation;
  the developer preview does not claim it can continue a stopped agent or state-machine checkpoint.
- `runmill auth status|login|logout`, `runmill skills eject|validate`, `runmill feedback`.
- `runmill doctor --explain <topic>` for sandbox, github, provider, and linear;
  `runmill doctor --report` produces a support bundle with no credentials, source, or absolute paths.
- `docs/errors.md`, generated from the error catalog. CI fails if it drifts.
- CI on macOS and Linux, including a check that the published package contains the binary it declares.

### Changed

During preview development, `provider:` and `review.provider:` were replaced by one `providers:`
block. A file using the old shape is rejected by name, with the replacement printed, rather than
parsed to defaults.

```yaml
providers:
  max_turns: 80              # was provider.max_turns
  timeout_minutes: 120       # was provider.timeout_minutes
  implementer:
    implementation: codex    # was provider.implementation
    model: <id>              # was provider.model
  reviewer:
    implementation: inherit  # was review.provider
    model: <id>              # was review.model
```

Everything else under `review:` (skills, `max_fix_iterations`,
`merge_blocking_severities`) stays where it is. `runmill init` creates the new shape when no
operator policy exists and never overwrites an existing policy.

### Fixed

- **The safe git-isolation default never applied to a single real run.** `WorkspaceManager`
  documents `clone` as its default, because a linked worktree's `.git` is a file into the parent
  repository — so the object store, config, and hooks are shared, and granting the sandbox write
  access hands an agent `.git/hooks/pre-commit` and code execution in the orchestrator's context.
  `parseConfig` defaulted to `separate-git-dir` and the orchestrator passed it through, so the
  documented default was dead code. Now `clone` in both, with a test that fails if they drift.
- **A failed clone was ignored.** Workspace creation used the non-throwing `run` for the clone
  while every other call used `runGit`, so a failure surfaced three steps later as a confusing
  `git config` error. It also cloned from the invocation directory rather than the repository
  root, which fails whenever runmill is run from a subdirectory.
- **The published package contained no code.** `bin` pointed at `dist/cli/main.js` with no build
  step at pack time, so `npm i -g runmill` installed a package whose only executable was absent.
- **The installed binary silently did nothing.** The entrypoint guard compared `import.meta.url`
  against `process.argv[1]`, which is the `node_modules/.bin` symlink once installed — so the two
  never matched, nothing parsed, and the process exited 0 with no output.
- **8 of 19 error codes cited commands that did not exist.** Every remediation is now either
  implemented or removed, and `test/cli/contract.test.ts` fails if that regresses.
- **Every error's docs link was dead.** `runmill.dev` does not resolve; links now point at the
  repository.
- `doctor --check <unknown>` matched nothing and reported `overall: PASS`, telling developers their
  setup was fine when nothing had been checked. It now fails with the available check ids.
- Running with no operator policy reported "Referenced file does not exist" and suggested fixes
  that could not apply. It now reports `RM-CONFIG-003` and suggests `runmill init`.
- **The advertised 60-second quickstart demonstrated nothing.** `RUNMILL_DEMO=1` resolved to an
  *empty* in-memory backlog, so the headline command printed "No eligible issue." Demo mode is now
  seeded with the bundled example issues, and the fixture ships in the package.
- The configuration schema's `$id` pointed at `runmill.dev`, the host that does not resolve — so the
  `yaml-language-server` line the README tells you to paste gave no editor validation at all.
- "No eligible issue." did not distinguish a backlog that returned nothing from one whose every
  candidate was rejected. The empty case now names the configured team and how to check the
  credential.

### Upgrade notes

None. Runmill has not published its first release, so there is no supported version to migrate
from yet.

Going forward, any change to the state database schema ships with a forward-only migration that
runs automatically, backs the database up first, and refuses to start if the database was written
by a newer runmill than the one you are running. `runmill state` shows both versions.
