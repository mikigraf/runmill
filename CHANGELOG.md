# Changelog

Notable changes to runmill. Format follows [Keep a Changelog](https://keepachangelog.com/1.1.0/);
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

Upgrades should be boring. Anything that requires action on your part appears under
**Upgrade notes** with the exact command to run.

## [Unreleased]

### Added

- `runmill init` — writes `runmill.yaml`, `.runmill/checks.yaml`, and the review skills, inferring
  the repository and base branch from git.
- `runmill prepare <issue>` — scores how ready an issue is to run and names what is missing, so an
  underspecified issue is caught before a run spends money rather than after.
- `runmill inspect <run-id>`, `runmill resume <run-id>`, `runmill policy explain <run-id>` —
  the run introspection and recovery surface.
- `runmill auth status|login|logout`, `runmill skills eject|validate`, `runmill feedback`.
- `runmill doctor --explain <topic>` for sandbox, github, provider, and linear;
  `runmill doctor --report` produces a support bundle with no credentials, source, or absolute paths.
- `docs/errors.md`, generated from the error catalog. CI fails if it drifts.
- CI on macOS and Linux, including a check that the published package contains the binary it declares.

### Fixed

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
- Running with no `runmill.yaml` reported "Referenced file does not exist" and suggested fixes that
  could not apply. It now reports `RM-CONFIG-003` and suggests `runmill init`.
- **The advertised 60-second quickstart demonstrated nothing.** `RUNMILL_DEMO=1` resolved to an
  *empty* in-memory backlog, so the headline command printed "No eligible issue." Demo mode is now
  seeded with the bundled example issues, and the fixture ships in the package.
- The configuration schema's `$id` pointed at `runmill.dev`, the host that does not resolve — so the
  `yaml-language-server` line the README tells you to paste gave no editor validation at all.
- "No eligible issue." did not distinguish a backlog that returned nothing from one whose every
  candidate was rejected. The empty case now names the configured team and how to check the
  credential.

### Upgrade notes

None. This is the first release; there is nothing to migrate from.

Going forward, any change to the state database schema ships with a forward-only migration that
runs automatically, backs the database up first, and refuses to start if the database was written
by a newer runmill than the one you are running. `runmill state` shows both versions.
