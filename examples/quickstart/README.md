# Quickstart fixture

This directory is sample input for read-only CLI exploration and tests. It is not a policy to copy
into a live repository unchanged.

Its operator policy contains only `git diff --check`, because the fixture has no application or
test framework. `runmill init` inspects a real locked npm project's scripts; for an unknown
ecosystem it blocks with `checks: []` until the operator declares the repository's actual checks.

From the Runmill source checkout:

```bash
npm ci
npm run build
node dist/cli/main.js demo
```

`runmill demo` creates a temporary Git repository, runs the complete simulated delivery loop, and
removes it afterwards. It needs no GitHub, Linear, Codex, or Claude credentials and does not touch
the current repository.

To connect a real checkout, install the CLI and run `runmill init` from that repository. Init writes
operator policy outside the repository and adds only the review/check files the project is missing.
