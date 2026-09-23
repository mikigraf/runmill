# Changelog

Notable changes to runmill. Format follows [Keep a Changelog](https://keepachangelog.com/1.1.0/);
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

Upgrades should be boring. If one needs you to do something, it is listed under
**Upgrade notes** with the exact command to run.

## [Unreleased]

Changes queued for the first developer-preview release.

### Added

- `runmill eval validate` and `runmill eval replay`: the evaluation harness. It replays a suite of
  tasks taken from your own history through the real selection and orchestration path, and
  reports pass rates with 95% confidence intervals. Refusal accuracy is reported separately and
  sets the exit code by itself. A harness that stops escalating has regressed, whatever the
  aggregate says. `eval validate` rejects a suite where every task expects success.
- `runmill gc`, which reconciles workspaces left behind by crashed runs.
- The `PR_REVIEW` stage. It used to ship as scaffolding and never ran.
- `docs/`, covering the mechanisms the CLI can't explain by itself: the coverage contract, the
  lease model, the seven merge gates, the sandbox, the run lifecycle, and a full configuration
  reference. `test/docs/contract.test.ts` fails if a doc cites a command, flag, error code, source
  file, or link that does not exist.
- The check manifest is now actually loaded. `runmill init` wrote `.runmill/checks.yaml` and
  `verification.manifest` pointed at it, but nothing read it. Checks came only from operator
  policy, so `declared_skips` was never parsed and there was no way to declare a skip.
- `runmill config validate` also validates the check manifest and names the check that fails.
- `runmill init`. It writes an operator-owned policy outside the repository, plus
  `.runmill/checks.yaml` and review skills inside it, and reads the repository and base branch
  from git. Running it again keeps every existing file and only restores missing ones.
- `runmill prepare <issue>`. It scores how ready an issue is and names what is missing, so you
  catch an underspecified issue before a run spends money on it.
- `runmill inspect <run-id>`, `runmill policy explain <run-id>`, `runmill effects list|resolve`,
  and `runmill leases list|resolve` for inspecting runs and recovering explicitly.
  `runmill resume` stays as a compatibility diagnostic that refuses to continue from a checkpoint.
  The developer preview does not claim it can continue a stopped agent or state-machine checkpoint.
- `runmill auth status|login|logout`, `runmill skills eject|validate`, `runmill feedback`.
- `runmill doctor --explain <topic>` for sandbox, github, provider, and linear;
  `runmill doctor --report` produces a support bundle with no credentials, source, or absolute paths.
- `docs/errors.md`, generated from the error catalog. CI fails if it drifts.
- CI on macOS and Linux, including a check that the published package contains the binary it
  declares.

### Changed

During preview development, `provider:` and `review.provider:` were replaced by a single
`providers:` block. A file that still uses the old shape is rejected by name and the replacement
is printed. It is never silently parsed to defaults.

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
`merge_blocking_severities`) stays where it is. `runmill init` writes the new shape when there is
no operator policy yet, and never overwrites an existing one.

### Fixed

- **The safe git-isolation default never applied to a single real run.** `WorkspaceManager`
  documents `clone` as its default. A linked worktree's `.git` is a file pointing into the parent
  repository, so the object store, config, and hooks are shared. Giving the sandbox write access
  to that hands an agent `.git/hooks/pre-commit` and code execution in the orchestrator's context.
  `parseConfig` defaulted to `separate-git-dir` and the orchestrator passed it through, so the
  documented default was dead code. Both now use `clone`, and a test fails if they drift apart.
- **A failed clone was ignored.** Workspace creation used the non-throwing `run` for the clone
  while every other call used `runGit`, so a failure showed up three steps later as a confusing
  `git config` error. It also cloned from the directory runmill was invoked in instead of the
  repository root, which broke whenever runmill ran from a subdirectory.
- **The published package contained no code.** `bin` pointed at `dist/cli/main.js` with no build
  step at pack time, so `npm i -g runmill` installed a package whose only executable was absent.
- **The installed binary silently did nothing.** The entrypoint guard compared `import.meta.url`
  with `process.argv[1]`, which is the `node_modules/.bin` symlink once installed. The two never
  matched, nothing parsed, and the process exited 0 with no output.
- **8 of 19 error codes cited commands that did not exist.** Each remediation has now been
  implemented or removed, and `test/cli/contract.test.ts` fails if that regresses.
- **Every error's docs link was dead.** `runmill.dev` does not resolve; links now point at the
  repository.
- `doctor --check <unknown>` matched nothing and reported `overall: PASS`, telling developers their
  setup was fine when nothing had been checked. It now fails and lists the available check ids.
- Running with no operator policy reported "Referenced file does not exist" and suggested fixes
  that did not apply. It now reports `RM-CONFIG-003` and suggests `runmill init`.
- **The advertised 60-second quickstart demonstrated nothing.** `RUNMILL_DEMO=1` resolved to an
  *empty* in-memory backlog, so the headline command printed "No eligible issue." Demo mode is now
  seeded with the bundled example issues, and the fixture ships in the package.
- The configuration schema's `$id` pointed at `runmill.dev`, which does not resolve. The
  `yaml-language-server` line the README tells you to paste gave no editor validation at all.
- "No eligible issue." looked the same whether the backlog returned nothing or every candidate
  was rejected. The empty case now names the configured team and tells you how to check the
  credential.

### Upgrade notes

None. Runmill has not published its first release, so there is no supported version to migrate
from yet.

From now on, every change to the state database schema ships with a forward-only migration. It
runs automatically, backs up the database first, and refuses to start if a newer runmill than the
one you are running wrote the database. `runmill state` shows both versions.
