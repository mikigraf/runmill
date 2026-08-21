# Support

Runmill is a developer preview maintained on a best-effort basis. There is no production support
SLA yet.

## Before opening an issue

1. Use Node 22 or 24 on macOS or Linux.
2. Run `runmill doctor --explain sandbox` and `runmill doctor --report`.
3. Search the [documentation](./docs/README.md), [error reference](./docs/errors.md), and existing
   [issues](https://github.com/mikigraf/runmill/issues).
4. Reproduce with `pr-only` when the problem involves automatic merge behavior.

`runmill doctor` makes one short provider request per distinct configured provider/model after
authentication passes. This is intentional readiness evidence, uses a small number of tokens, and
may be billable. The diagnostic output reports only the result category, never the model response
or credential material.

The support bundle omits credentials, source, and absolute paths, but review it before posting.

## Where to ask

- Reproducible failures: use the [bug report](https://github.com/mikigraf/runmill/issues/new?template=bug.yml).
- Provider, forge, backlog, sandbox, or platform compatibility: use the
  [integration report](https://github.com/mikigraf/runmill/issues/new?template=integration.yml).
- Product proposals: use the
  [feature request](https://github.com/mikigraf/runmill/issues/new?template=feature.yml).
- Documentation errors: use the
  [documentation report](https://github.com/mikigraf/runmill/issues/new?template=docs.yml).
- Suspected vulnerabilities: follow [SECURITY.md](./SECURITY.md); never file them publicly.

Include the Runmill version, Node version, operating system, sandbox mechanism, exact command, and
the smallest safe reproduction. Do not include tokens, provider keys, private source, or unredacted
agent transcripts.

The [roadmap](./ROADMAP.md) distinguishes current, experimental, planned, and intentionally excluded
work. A roadmap item is not a release commitment.
