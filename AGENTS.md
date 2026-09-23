# Working on Runmill

These are the rules for coding agents and other automated contributors. If you are a person, read
[CONTRIBUTING.md](./CONTRIBUTING.md) as well.

## Setup and checks

```bash
npm ci
npm run check
```

Use Node 22 or 24 and Git 2.45 or newer. `npm test` runs offline and skips `test/live/`. Only run
the live suites when the task actually needs real credentials and remotes. Run
`npm run package:check` after you change package metadata, build output, the CLI entrypoint, or
bundled fixtures.

## Architectural invariants

- The orchestrator performs every external side effect and makes every policy decision. Agents and
  adapters return proposals or observations. They never gain authority.
- If evidence is missing, unknown, stale, or contradictory, fail closed.
- Verification and review evidence belongs to one exact candidate commit.
- A fake must be at least as strict as the production adapter it stands in for.
- Code that depends on time uses the injected `Clock`. Code that runs processes goes through
  `platform/process.ts`.
- Inputs the repository controls can narrow operator authority. They can never widen it.
- Never commit credentials, support bundles, generated runtime state, or `.runmill/state/`.

## Tests and documentation

- A governance change needs a negative or refusal test. A passing happy path is not enough.
- A sandbox test has to plant a resource, show it is readable outside the sandbox, and show it is
  denied inside. Test Seatbelt and bubblewrap separately; passing on one says nothing about the
  other.
- Every remediation command Runmill prints must exist and stay covered by the CLI contract tests.
- After changing the error catalog, run `npm run docs:errors` and include the regenerated file.
- Keep public exit codes, JSON output contracts, and forward-only state migrations stable.

Keep patches small and on-task. In a dirty worktree, don't overwrite work that isn't yours. Don't
publish, release, merge, or change external repository settings unless the task says you may.
