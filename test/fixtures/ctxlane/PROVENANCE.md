# Vendored ctxlane v1 fixtures

The files under `schemas/` and `examples/` in this directory are byte-identical
copies of the published, controller-neutral ctxlane automation identity
contracts. They are test fixtures only: Runmill does not implement or embed a
ctxlane server, and this directory is never read at runtime.

Source: `schemas/` and `schemas/examples/` in the sibling `ctxlane` publication
tree (locally available at `Coding Agent Profiles/schemas` at the time these
files were vendored; upstream is `github.com/mikigraf/ctxlane`, see each
schema's `$id`). Vendored 2026-08-25. The private lifecycle schema pair below
is included as contract material only; Runmill does not yet serialize or
execute lifecycle mutations.

Files:

- `schemas/ctxlane.work-order-authorization.v1.schema.json`
- `schemas/ctxlane.identity-lease-request.v1.schema.json`
- `schemas/ctxlane.identity-lease.v1.schema.json`
- `schemas/ctxlane.identity-lease-lifecycle-private-request.v1.schema.json`
- `schemas/ctxlane.identity-lease-lifecycle-private-response.v1.schema.json`
- `schemas/ctxlane.automation-error.v1.schema.json`
- `schemas/ctxlane.identity-lease-close-receipt.v1.schema.json`
- `schemas/ctxlane.identity-lease-close.v1.schema.json`
- `schemas/ctxlane.identity-lease-inspect-receipt.v1.schema.json`
- `schemas/ctxlane.identity-lease-inspect.v1.schema.json`
- `schemas/ctxlane.identity-lease-renew-acknowledgement.v1.schema.json`
- `schemas/ctxlane.identity-lease-renew-receipt.v1.schema.json`
- `schemas/ctxlane.identity-lease-renew.v1.schema.json`
- `schemas/ctxlane.identity-lease-revoke-receipt.v1.schema.json`
- `schemas/ctxlane.identity-lease-revoke.v1.schema.json`
- `schemas/ctxlane.lease-view.v1.schema.json`
- `schemas/ctxlane.profile-list.v1.schema.json`
- `schemas/ctxlane.service-health.v1.schema.json`
- `schemas/ctxlane.automation-readiness.v1.schema.json`
- `examples/work-order-authorization.v1.json`
- `examples/identity-lease-request.v1.json`
- `examples/identity-lease-active.v1.json`
- `examples/identity-lease-refused.v1.json`
- `examples/automation-error.v1.json`
- `examples/work-order-signing-vector.v1.json` — public Ed25519 test key,
  canonical signing bytes, and signature/digest vector. Contains no private
  key; see the file's own `warning` field.
- `examples/lease-close-receipt.v1.json`
- `examples/lease-close-request.v1.json`
- `examples/lease-inspect-receipt.v1.json`
- `examples/lease-inspect-request.v1.json`
- `examples/lease-renew-acknowledgement.v1.json`
- `examples/lease-renew-receipt.v1.json`
- `examples/lease-renew-request.v1.json`
- `examples/lease-revoke-receipt.v1.json`
- `examples/lease-revoke-request.v1.json`
- `examples/lease-view-active.v1.json`
- `examples/lease-view-per-lease-isolated.v1.json`
- `examples/lease-view-closed.v1.json`
- `examples/lease-view-refused.v1.json`
- `examples/lease-view-renewing.v1.json`
- `examples/lease-view-revoked.v1.json`
- `examples/profile-list.v1.json`
- `examples/service-health.v1.json`
- `examples/automation-readiness-ready.v1.json`
- `examples/automation-readiness-not-ready.v1.json`
- `examples/automation-readiness-development-exception.v1.json`

Private lifecycle schema digests (SHA-256):

- `schemas/ctxlane.identity-lease-lifecycle-private-request.v1.schema.json`:
  `33d89497c7fb6eac63ca12c0591f5aba2f368fcb4b898b5fe8d6d3618a2e6936`
- `schemas/ctxlane.identity-lease-lifecycle-private-response.v1.schema.json`:
  `7300f9099e0a2dc3342f548bcd6facddf2bbe29bd7a7c69d4b3d0d40afd087a6`

The ctxlane publication tree currently supplies no private lifecycle envelope
examples, so none are invented or vendored. The public renew, close, revoke,
and renewal-acknowledgement schemas/examples listed above remain byte-identical
fixtures and do not authorize lifecycle transitions.

Do not hand-edit these files. If ctxlane publishes a new v1 revision, replace
the file wholesale from the upstream source and re-run
`test/identity/ctxlane-broker.test.ts`, which asserts Runmill's zod contracts
in `src/identity/ctxlane-contracts.ts` accept every vendored example and
reject deliberate mutations of it. The lifecycle parameter and capability-free
view/receipt contracts are public data shapes; they do not grant authority.
Runmill's protected renewal, close, and revoke boundary still requires a
private authenticated response carrying the execution handle and fencing
generation, so a `ctxlane.lease-view/v1` receipt is never promoted into an
identity lease.

The private authenticated lifecycle channel and provider harness remain
unqualified. Runmill's `CtxlaneLeaseLifecycleClient` is therefore still an
operator-supplied in-process seam, even though its deployment may serialize
the exact lifecycle parameter objects documented by ctxlane.
