# Contributing

## Setup

```bash
git clone https://github.com/mikigraf/runmill.git
cd runmill
npm ci
npm run check
```

You need Node 22 or 24, Git 2.45 or newer, and macOS or Linux. Sandbox tests need Seatbelt (built
into macOS) or bubblewrap (`apt-get install bubblewrap`). `package.json` pins npm 11.15.0; use that
version when you regenerate `package-lock.json`.

## The loop you will be working in

```bash
npm run check           # lint, types, coverage-gated tests, generated docs
npm test                # offline tests without coverage, network, or credentials
npm run package:check   # pack, clean-install, and execute the release artifact
npm run docs:errors     # regenerate docs/errors.md after touching the catalog
```

`npm test` leaves out `test/live/` on purpose, because those tests use real credentials and real
remotes. Run them deliberately:

```bash
npx vitest run --config vitest.live.config.ts
```

A live suite that needs a credential skips itself when the credential isn't there. Provider
execution suites also stay skipped until a qualified production sandbox backend exists. The live
config tells you which prerequisite is missing.

## How the layers fit

```
cli/          argument parsing and rendering. No policy.
factory.ts    resolves the three external boundaries, reports which are live
queue/        selection, eligibility, repository mapping, the git-ref lease
orchestrator/ the state machine. Owns every side effect.
agent/        provider boundary + the normalized event stream
workspace/    per-run isolation and the OS sandbox
verification/ the coverage contract
review/       schema-validated findings
pr/           forge boundary and CI reconciliation
state/        SQLite, migrations, the side-effect outbox
testing/      in-memory implementations of every boundary
```

The codebase is built around three rules. Here is why each one exists.

**The orchestrator owns side effects.** If you catch yourself handing the agent a credential or
letting an adapter make a policy decision, the design has drifted.

**Fakes must never be more permissive than the real thing.** `FakeForgeAdapter` defaults
`canWriteBranchProtection` to `true` because `GitHubForgeAdapter` fails closed to `true` when it
can't tell. If the fake defaulted to `false`, every merge test would exercise a branch production
can never reach. That is exactly how a reviewer bug shipped once already.

**Everything runmill tells a developer to run must exist.** `test/cli/contract.test.ts` checks
that every command cited in the error catalog and the README resolves. If you add a fix line, add
the command too.

## Tests

Write the test first. Beyond that:

- If you touch a governance gate, add a case proving it *refuses*. The paths where Runmill declines
  to merge are the valuable half of the product.
- Anything time-dependent takes the injected `Clock`. `FakeClock` can jump forward by minutes,
  simulate a laptop going to sleep, and give a skewed clock for cross-host lease tests.
- Anything that spawns a process goes through `platform/process.ts`.

## Commits

`<type>: <description>`, types: feat, fix, refactor, docs, test, chore, perf, ci.

If the diff doesn't make the *why* obvious, explain it in the body. For some of these decisions,
the commit history is the only record we have.

## Filing a bug

`runmill doctor --report` produces a bundle with no credentials, no source, and no absolute paths.
Paste it into the issue.

## Verifying the Linux sandbox

Half the supported platforms are Linux, where the sandbox is bubblewrap. That is
a different mechanism from macOS Seatbelt, with its own flags, failure modes, and
enforcement limits. If you only develop on a Mac, that half never gets exercised.

```bash
npm run verify:linux            # full suite on Linux, in Docker
npm run verify:linux sandbox    # just the sandbox enforcement tests
```

This needs Docker. It runs `--privileged` because bubblewrap has to create user
namespaces, and nested containers can't do that by default. The sandbox needs the
same kernel feature inside the container as it does on a real host.

Don't gate a sandbox test to one platform. The enforcement tests were once written
as `it.runIf(onMac)`, which meant nothing, anywhere, verified bubblewrap's
containment. Gate on whether a mechanism exists (`detectMechanism() !== "none"`)
instead.

Make sure a negative test actually proves something. `DENIES reading a credential path`
used to read the developer's real `~/.ssh/id_rsa`. On a machine without that file
it passed because `cat` found nothing, which told us nothing about the sandbox.
Plant the secret, confirm it is readable outside, then assert that it is denied
inside.

## Releasing

The package isn't published yet. Don't publish it from a development machine. Before a release PR
is approved, run the same gates CI runs:

```bash
npm ci
npm run check
npm run package:check
npm run verify:linux
```

`prepublishOnly` repeats `check` and the package smoke test. The smoke test builds the tarball,
enforces its size budget, installs it into an empty prefix, and runs `runmill --version`. The
release artifact has to pass, and the working tree passing doesn't count.

Once the npm package and repository environments are configured, releases go out through a
reviewed GitHub release and npm trusted publishing with provenance. Maintainers must follow the
full [release checklist](./docs/releasing.md). Until its one-time external setup is done, the
workflow has no permission to publish.

`npm link` does not replace `npm run package:check`. It symlinks the working copy, so it can pass
even when `files` leaves out something the tarball needs.
