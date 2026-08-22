# Vendored ctxlane v1 fixtures

The files under `schemas/` and `examples/` in this directory are byte-identical
copies of the published, controller-neutral ctxlane automation identity
contracts. They are test fixtures only: Runmill does not implement or embed a
ctxlane server, and this directory is never read at runtime.

Source: `schemas/` and `schemas/examples/` in the sibling `ctxlane` publication
tree (locally available at `Coding Agent Profiles/schemas` at the time these
files were vendored; upstream is `github.com/mikigraf/ctxlane`, see each
schema's `$id`). Vendored 2026-08-22.

Files:

- `schemas/ctxlane.work-order-authorization.v1.schema.json`
- `schemas/ctxlane.identity-lease-request.v1.schema.json`
- `schemas/ctxlane.identity-lease.v1.schema.json`
- `schemas/ctxlane.automation-error.v1.schema.json`
- `examples/work-order-authorization.v1.json`
- `examples/identity-lease-request.v1.json`
- `examples/identity-lease-active.v1.json`
- `examples/identity-lease-refused.v1.json`
- `examples/automation-error.v1.json`
- `examples/work-order-signing-vector.v1.json` — public Ed25519 test key,
  canonical signing bytes, and signature/digest vector. Contains no private
  key; see the file's own `warning` field.

Do not hand-edit these files. If ctxlane publishes a new v1 revision, replace
the file wholesale from the upstream source and re-run
`test/identity/ctxlane-broker.test.ts`, which asserts Runmill's zod contracts
in `src/identity/ctxlane-contracts.ts` accept every vendored example and
reject deliberate mutations of it.

ctxlane has not published a renewal, close, or revocation wire contract as of
this vendoring. Runmill's lease renewal/close/revoke transport in
`src/identity/ctxlane-broker.ts` is therefore a Runmill-owned convention, not
a ctxlane contract, and is named and documented as such (see
`docs/asf-worker.md`).
