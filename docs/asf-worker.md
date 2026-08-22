# ASF worker

Runmill remains fully usable without Autonomous Software Factory (ASF). The normal
`runmill start` command is the standalone backlog-to-PR product and never requires ASF,
ctxlane, an ASF signing key, or the MCP adapter. ASF-related control surfaces are
separate, explicit commands; ordinary startup cannot enter `asf-worker` mode.

> [!IMPORTANT]
> This page documents a worker kernel and reference integration boundary, not a
> production-complete deployment. `runmill service start --mode asf-worker` loads and runs
> an operator-owned composition module; Runmill supplies the trust boundary, control
> transport, and readiness gate around that module, not a finished ASF controller stack.

## Service and MCP commands

| Command                                                                    | Purpose                                                                            |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `runmill service start --mode asf-worker --runtime-module <absolute-path>` | Start the production-gated ASF host with an operator-owned deployment composition  |
| `runmill service status`                                                   | Read authenticated health from an explicitly configured ASF worker service         |
| `runmill service stop`                                                     | Request a graceful stop from the ASF worker without affecting standalone mode      |
| `runmill mcp serve --stdio`                                                | Run the stateless ASF MCP adapter against an explicitly started ASF worker service |

`--mode` accepts only the literal value `asf-worker`; there is no other production mode.
`--runtime-module` may be omitted if `RUNMILL_ASF_RUNTIME_MODULE` is set instead, but the
two may not disagree.

## The runtime module

ASF worker startup is a deployment integration point, not a built-in set of production
controllers. `runmill service start --mode asf-worker --runtime-module <absolute-path>`
loads an operator-owned ESM composition whose named `createAsfWorkerHostOptions(context)`
factory returns the fully configured worker host dependencies: the durable `service`
implementation, control authentication, a `readiness` probe, and repository/config paths.

The entrypoint only accepts a private, root/current-user-owned regular module (no
symlinks, no world/group-writable ancestor directories) in a safe directory, verifies the
file's identity has not changed between open and factory invocation, and rejects any
factory output that is not a plain object built from the exact expected option keys. The
host then independently requires production-readiness and health evidence before it
accepts recovery or control intake — the runtime module cannot self-certify readiness by
returning an arbitrary payload.

## Readiness requirements

The `readiness` callback supplied by the runtime module must return the complete,
versioned canonical `asf.production-readiness-report/v1` evaluator output. `AsfWorkerHost`
refuses to start, recover, or accept control traffic when that report is missing,
malformed, or reports a custom or partial passing checklist instead of the full canonical
check set (`hasCanonicalAsfProductionReadinessChecks`). A separate `health` readiness
domain gates `runmill service status` and `runmill service stop` the same way.

## `RUNMILL_ASF_*` environment variables

| Variable                                                   | Purpose                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `RUNMILL_ASF_RUNTIME_MODULE=<absolute-path>`               | Select the trusted deployment composition for explicit ASF startup   |
| `RUNMILL_ASF_DAEMON_REGISTRY=<absolute-path>`              | Override ASF-only service discovery for start/status/stop/MCP        |
| `RUNMILL_ASF_CONTROL_CONTROLLER_ID=<id>`                   | Identify the trusted controller for explicit ASF MCP/service control |
| `RUNMILL_ASF_CONTROL_KEY_ID=<id>`                          | Select the dedicated ASF local-control authentication key            |
| `RUNMILL_ASF_CONTROL_KEY_FILE=<path>`                      | Read that key from a private root/current-user-owned `0600` file     |
| `RUNMILL_ASF_EVIDENCE_SIGNING_KEY_ID=<id>`                 | Identify the Ed25519 key used to sign ASF work-order evidence        |
| `RUNMILL_ASF_EVIDENCE_SIGNING_KEY_FILE=<path>`             | Read that private Ed25519 signing key from a private regular file    |
| `RUNMILL_ASF_EVIDENCE_SIGNING_KEY_VALID_FROM=<timestamp>`  | Inclusive start of the signing key's validity window                 |
| `RUNMILL_ASF_EVIDENCE_SIGNING_KEY_VALID_UNTIL=<timestamp>` | Exclusive end of the signing key's validity window                   |

None of these variables are read during standalone startup. The evidence-signing and
control-authentication loaders are only invoked from ASF-specific composition and control
code paths, so an unset or unrelated environment never changes standalone behavior.

## Registry and socket isolation

ASF control discovery is isolated from the standalone daemon: it uses
`RUNMILL_ASF_DAEMON_REGISTRY` or `~/.runmill/asf-worker.json`, with a control socket named
`asf-worker.sock`. Standalone commands continue to use `RUNMILL_DAEMON_REGISTRY` or
`daemon.json`/`daemon.sock`, so both services can coexist on one host, and ASF status,
stop, and MCP clients cannot target the standalone daemon by default.

## The ctxlane boundary

Runmill validates and emits the exact published `ctxlane.identity-lease-request/v1` and accepts
full `ctxlane.identity-lease/v1` or `ctxlane.automation-error/v1` response objects. A trusted
authority resolver supplies the following fields during acquisition: a stable
`client_request_id`, signed work-order authorization, `provider` and `profile` UIDs,
`repository`, `workspace`, and `environment` identifiers, caller and host expectations, and
a separate `ctxlane` policy digest.

Runmill fencing and Runmill policy are never sent as ctxlane fields; full attribution is
protected and persisted within Runmill's own envelope. Duplicate JSON members in ctxlane
objects fail closed — the ctxlane boundary rejects any message with repeated field names.

ctxlane publishes no supported `service` or `listener` wire protocol or lifecycle request
protocol today. `CtxlaneUnixAutomationClient` is therefore an explicitly
`development-only-unqualified` newline-delimited `SOCK_STREAM` fixture transport. Its path
ownership checks do not provide ctxlane's required peer-process, credential, or cgroup binding,
and no production composition may treat it as trusted. Renewal, close, and revoke operations
require a mandatory, operator-supplied in-process `CtxlaneLeaseLifecycleClient`; that adapter
must encapsulate ctxlane's begin-renewal, acknowledgement, and final active inspection sequence.
Real ctxlane production qualification remains blocked until the authenticated transport and
complete lifecycle path are published and implemented.

## Reference composition

The `createAsfReferenceWorkerHostOptions()` factory and `inspectAsfReferenceComposition()`
introspection function are available from `dist/asf/reference-composition.js`. This
composition is classified as a `reference-integration-boundary` with `productionQualified:
false`. It wires the real `AsfPrDeliveryRunner` and `AsfWorkerService` only when every
listed operator port is supplied; it refuses startup before recovery and control intake
otherwise. Startup coordinates shutdown reconciliation, identity retirement, and resource
cleanup in order, and remains not production qualified.

| Operator Port Group                     | Required Ports                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| Recovery/resource lifecycle             | recovery intake, resource lifecycle, lease recovery                                   |
| Provider/identity/tooling               | provider endpoint, identity resolver, tool registry                                   |
| Verification/review                     | review authority, evidence validator                                                  |
| GitHub/CI/reconciliation                | GitHub API, CI orchestrator, reconciliation sink                                      |
| Evidence/control/observability/shutdown | evidence store, control transport, health probe, telemetry sink, shutdown coordinator |

The required telemetry port receives only the fixed, low-cardinality signals defined in
`dist/asf/telemetry.js`: attribute values come from closed enumerations, and unknown fields or
values are rejected. The seam is non-authoritative: exporter and recorder failures — synchronous
or asynchronous — are dropped and can never change admission, execution, recovery, or shutdown
outcomes, nor surface as background errors or unhandled rejections. This is only an initial
OpenTelemetry adapter seam over a worker-kernel observability surface, not a full OTel SDK
integration and not completion of PRD section 23 (the full ASF production telemetry program).

Spans are emitted atomically as already-completed spans: each signal is a single record carrying
only a `duration_ms` for a finished operation, with no separate start/end or in-progress phase
events, and the monotonic clock origin stays private. An OpenTelemetry adapter maps each record to
one completed span at export time. The measured service lifecycle span covers object construction
through worker drain — it is not host-ready uptime and does not include full reference-composition
shutdown. Every run execution emits the `runmill.asf.run.invocations` counter exactly once,
whichever disposition (`terminal`, `durable-pause`, `retry`, `lease-lost`, `unexpected-error`) the
dispatch reaches.

## Qualification manifest and preflight

`dist/asf/qualification.js` exports `evaluateAsfQualificationPreflight`, a pure,
non-authorizing prerequisite evaluation for explicit qualification runs, alongside frozen
manifest constants for the profile, applicability list, and cold-start case matrix. The
API has no filesystem, credential, process, socket, or network effects, takes no live
action, and its result can never grant authority or authorize startup:
`productionQualified` is always `false` in every result, including `ready-to-run` ones.

The PR-only profile (`asf.pr-only-qualification-profile/v1`) applies exactly 15 of the 17
catalog checkpoint kinds; the two merge checkpoints (`merge-queue-candidate-state` and
`merge-intent-observation`) are `not-applicable` with reason
`pr-only-profile-prohibits-merge`, because the profile prohibits merging. The
`process-cold-start` matrix is the deterministic product of those 15 applicable checkpoints
and the `before`/`after` boundaries — exactly 30 cases. Each boundary is a worker
process restart around the checkpoint only; `process-cold-start` is not a host reboot, and
the preflight makes no host-reboot claim.

Per-target behavior:

- `ctxlane` and `integrated` are hard-blocked today: the preflight always adds
  `ctxlane.authenticated-service-unavailable` and `ctxlane.lifecycle-unavailable` (plus
  `integrated.reference-path-unavailable` for `integrated`), so they can never reach
  `ready-to-run` until the authenticated ctxlane transport and lifecycle path exist.
- `github-protected` can only become syntactically ready-to-run, and only with explicit
  private bindings: `execute: true`, a caller-asserted `platform: "linux"`, a valid
  explicit private `owner/repo` with `privateRepository: true`, distinct absolute
  `tokenFile` and `outputPath` files, and an `acknowledgement` that repeats the repository
  exactly. A `ready-to-run` decision still performs no live GitHub action: the preflight
  does not verify credentials, permissions, or branch protection, and does not execute a
  pilot.
- Every target additionally requires `execute: true` and `platform: "linux"`; anything
  else fails closed with `execution-not-explicitly-authorized` or `platform-not-linux`.

The reference composition is intended for integration testing and operator training. Standalone
`runmill start` never imports this path and does not load reference composition.
