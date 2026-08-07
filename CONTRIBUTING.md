# Contributing

## Setup

```bash
git clone https://github.com/mikigraf/runmill.git
cd runmill && npm install
npm test
```

Node 20.11+, git, and macOS or Linux. Sandbox tests need Seatbelt (built into macOS) or
bubblewrap (`apt-get install bubblewrap`).

## The loop you will be working in

```bash
npm test              # 240+ tests, no network, no credentials
npm run typecheck     # strict, and strict about it
npm run docs:errors   # regenerate docs/errors.md after touching the catalog
```

`npm test` deliberately excludes `test/live/`, which talks to real credentials and real remotes.
Run those on purpose:

```bash
npx vitest run --config vitest.live.config.ts
```

Each live suite skips itself when its credential is absent, so it is safe to run anywhere. It
simply reports less.

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

Three rules the codebase is built around, and the reasoning behind each:

**The orchestrator owns side effects.** If you find yourself giving the agent a credential or
letting an adapter make a policy decision, the design has drifted.

**Fakes must never be more permissive than the real thing.** `FakeForgeAdapter` defaults
`canWriteBranchProtection` to `true` because `GitHubForgeAdapter` fails closed to `true` when it
cannot determine the answer. A fake that defaulted to `false` would make every merge test exercise
a branch production cannot reach — which is exactly how a reviewer bug shipped once already.

**Everything runmill tells a developer to run must exist.** `test/cli/contract.test.ts` asserts
that every command cited by the error catalog and the README resolves. Add a fix line, add the
command.

## Tests

Write the test first. Beyond that:

- If you touch a governance gate, add a case proving it *refuses*. The valuable half of this
  product is the paths where it declines to merge.
- Anything time-dependent takes the injected `Clock`. `FakeClock` can advance minutes, simulate a
  laptop suspend, and produce a skewed view for cross-host lease tests.
- Anything spawning a process goes through `platform/process.ts`.

## Commits

`<type>: <description>`, types: feat, fix, refactor, docs, test, chore, perf, ci.

Explain *why* in the body when the why is not obvious from the diff. The commit history is the
only place some of these decisions are recorded.

## Filing a bug

`runmill doctor --report` produces a bundle with no credentials, no source, and no absolute paths.
Paste it into the issue.
