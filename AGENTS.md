# Working on Runmill

This file is the short contract for coding agents and automated contributors. Human contributors
should also read [CONTRIBUTING.md](./CONTRIBUTING.md).

## Setup and checks

```bash
npm ci
npm run check
```

Use Node 22 or 24. `npm test` is offline and excludes `test/live/`. Run live suites only when the
task explicitly requires real credentials and remotes. Run `npm run package:check` after changing
package metadata, build output, the CLI entrypoint, or bundled fixtures.

## Architectural invariants

- The orchestrator owns every external side effect and policy decision. Agents and adapters return
  proposals or observations; they do not acquire authority.
- Missing, unknown, stale, or contradictory evidence fails closed.
- Verification and review evidence is bound to the exact candidate commit.
- Fakes must be at least as restrictive as the production adapter they represent.
- Time-dependent code uses the injected `Clock`; process execution uses `platform/process.ts`.
- Repository-controlled inputs may narrow operator authority, never widen it.
- Never commit credentials, support bundles, generated runtime state, or `.runmill/state/`.

## Tests and documentation

- Governance changes need a negative or refusal test, not only a successful path.
- Sandbox tests must prove a planted resource is accessible outside and denied inside. Exercise both
  Seatbelt and bubblewrap mechanisms; do not infer one from the other.
- Every remediation command printed by Runmill must exist and remain covered by the CLI contracts.
- Run `npm run docs:errors` after changing the error catalog and include the generated update.
- Preserve public exit codes, JSON output contracts, and forward-only state migrations.

Keep patches scoped. Do not overwrite unrelated work in a dirty worktree, and do not publish,
release, merge, or change external repository settings unless the task explicitly authorizes it.
