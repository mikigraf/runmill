# Support

Runmill is a developer preview, maintained on a best-effort basis. There is no production support
SLA yet.

## Before opening an issue

1. Use Node 22 or 24 on macOS or Linux.
2. Run `runmill doctor --explain sandbox` and `runmill doctor --report`.
3. Search the [documentation](./docs/README.md), [error reference](./docs/errors.md), and existing
   [issues](https://github.com/mikigraf/runmill/issues).
4. If the problem involves automatic merge, reproduce it with `pr-only`.

Once authentication passes, `runmill doctor` sends one short request to each distinct configured
provider/model. We do this on purpose as readiness evidence. It uses a few tokens and may be
billable. The diagnostic output reports only the result category. It never includes the model's
response or any credential material.

The support bundle leaves out credentials, source, and absolute paths. Read it before you post it
anyway.

## Where to ask

- Reproducible failures go in a [bug report](https://github.com/mikigraf/runmill/issues/new?template=bug.yml).
- Provider, forge, backlog, sandbox, or platform compatibility problems go in an
  [integration report](https://github.com/mikigraf/runmill/issues/new?template=integration.yml).
- Product proposals go in a
  [feature request](https://github.com/mikigraf/runmill/issues/new?template=feature.yml).
- Documentation mistakes go in a
  [documentation report](https://github.com/mikigraf/runmill/issues/new?template=docs.yml).
- For a suspected vulnerability, follow [SECURITY.md](./SECURITY.md). Never file it publicly.

Include the Runmill version, Node version, operating system, sandbox mechanism, the exact command,
and the smallest reproduction you can safely share. Leave out tokens, provider keys, private
source, and unredacted agent transcripts.

The [roadmap](./ROADMAP.md) separates work that is current, experimental, planned, or deliberately
out of scope. Something being on the roadmap does not mean we have committed to ship it.
