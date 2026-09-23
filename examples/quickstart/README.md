# Quickstart fixture

This directory is sample input for tests and for poking at the CLI read-only. Don't copy it into a
live repository as your policy without changing it.

Its operator policy runs only `git diff --check`, because the fixture has no application or test
framework. `runmill init` looks at the scripts of a real, locked npm project. For an ecosystem it
doesn't recognize, it blocks with `checks: []` until the operator declares the repository's real
checks.

From the Runmill source checkout:

```bash
npm ci
npm run build
node dist/cli/main.js demo
```

`runmill demo` creates a temporary Git repository, runs the full simulated delivery loop, and
deletes the repository afterwards. It needs no GitHub, Linear, Codex, or Claude credentials and
leaves the current repository alone.

To connect a real checkout, install the CLI and run `runmill init` from that repository. Init writes
the operator policy outside the repository and only adds the review/check files the project is
missing.
