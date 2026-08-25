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
| `runmill service start --mode asf-worker --config <path> --observation <path> --observation-key <path> --observation-key-id <id> --runtime-module <absolute-path>` | Start the production-gated ASF host with an operator-owned deployment composition and process-owned signed readiness gate |
| `runmill service doctor --config <path> --observation <path> --observation-key <path> --observation-key-id <id>` | Verify a signed live-readiness observation and evaluate the explicit production-mode config |
| `runmill service status`                                                   | Read authenticated health from an explicitly configured ASF worker service         |
| `runmill service stop`                                                     | Request a graceful stop from the ASF worker without affecting standalone mode      |
| `runmill mcp serve --stdio`                                                | Run the stateless ASF MCP adapter against an explicitly started ASF worker service |

`service doctor` is read-only. It accepts the global `--config <path>` JSON production-mode
document and, when available, a signed `--observation <path>` live-readiness envelope plus the
matching trusted Ed25519 `--observation-key <path>` and `--observation-key-id <id>`. It never
opens the Runmill state store, binds a socket, loads a runtime module, or reads credentials.
An ASF configuration without a signed observation is refused; unsigned, digest-mismatched, and
wrong-key observations are rejected before evaluation. A passing report is still readiness
evidence only and does not set `productionQualified`.

The MCP adapter includes `runmill_lookup_submission`, which accepts an idempotency key
plus exact payload and envelope digests for lost-response recovery. A mismatch is returned
as an indistinguishable `not-found` result and never reveals another run.

`--mode` accepts only the literal value `asf-worker`; there is no other production mode.
When supplied, `--config <path>` (or the global `--config` before `service`) reads and validates
the declarative `runmill.production-mode/v1` document before importing the runtime module. The
trusted module receives the exact absolute path in `context.productionConfigPath`, and its
returned `configPath` must match it. This is a fail-closed configuration handoff; it does not
construct the missing first-party composition, so a runtime module remains mandatory.
For this production-gated path, `--observation`, `--observation-key`, and
`--observation-key-id` are also required. The host re-reads and verifies the signed observation
against the pinned public key and process-owned parsed config before recovery and before every
authority-bearing request; the runtime module cannot supply or replace that binding. Omitting
`--config` leaves the advanced runtime-module API, which remains unqualified and is not a
production deployment.
`--runtime-module` may be omitted if `RUNMILL_ASF_RUNTIME_MODULE` is set instead, but the
two may not disagree.

## Sample declarative configuration

The package includes [`examples/asf-worker/production-mode.json`](../examples/asf-worker/production-mode.json),
a schema-valid, credential-free placeholder document. Copy it to an operator-owned path, replace
the `replace-with-*` identifiers, and set private Unix endpoints appropriate for the host. The
sample is intentionally not a deployment: it contains no credentials or live observation, and
`service doctor` refuses it until explicit readiness evidence is supplied. It does not provide a
ctxlane service, provider harness, sandbox, GitHub authorization, evidence signer, or runtime
composition. The package also includes
[`examples/asf-worker/first-party-composition-manifest.json`](../examples/asf-worker/first-party-composition-manifest.json),
which is a machine-readable description of that boundary. It intentionally reports
`availability: "runtime-module-required"`; it is not an executable composition. Its closed
`blockingReasons` list names the missing executable graph, ctxlane authenticated transport and
authority-bearing lifecycle channel, provider harness, and live qualification; it is diagnostic
only. A first-party composition is
still a release requirement; the shipped reference composition remains `productionQualified: false`.

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
host then independently verifies the signed readiness observation and evaluates it against the
process-owned production config before it accepts recovery or control intake. A module's
readiness callback remains a compatibility probe and cannot grant authority by returning a
fabricated all-passed report. The advanced runtime-module API without this binding remains an
explicit qualification gap, not production authority, and the reference composition remains
`productionQualified: false`.

## Readiness requirements

The `readiness` callback supplied by the runtime module must return the complete,
versioned canonical `asf.production-readiness-report/v1` evaluator output. The explicit production
startup path independently evaluates the signed observation, so this callback is a compatibility
probe rather than the source of production authority. `AsfWorkerHost`
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

The ASF-only `createAsfCtxlaneIdentityController()` factory assembles the real
ctxlane broker and Runmill identity lifecycle around those explicit operator-owned
ports. The credential-free reference qualification test also drives the assembled
runner through the provider harness, sandbox/tool gateway, exact candidate-bound
local verification and review, deterministic GitHub/CI effects, pull-request
delivery, deterministic signed attempt evidence finalization, terminal resource
cleanup, signed terminal evidence, and `run.completed` — every stage through
in-process, credential-free adapters. This is composition evidence only. It does
not make the reference composition production-qualified (`productionQualified`
remains `false`), and the `integrated` qualification preflight remains `blocked`
on the authenticated ctxlane service and lifecycle channel and on operator-owned
live deployment, GitHub, and CI qualification.

Runmill fencing and Runmill policy are never sent as ctxlane fields; full attribution is
protected and persisted within Runmill's own envelope. Duplicate JSON members in ctxlane
objects fail closed — the ctxlane boundary rejects any message with repeated field names.

ctxlane now publishes the lifecycle parameter objects for renew, inspect, revoke, and close,
the renewal acknowledgement, and capability-free `ctxlane.lease-view/v1` receipts. Runmill
vendors those exact files and validates them byte-for-byte against the sibling publication tree.
The public receipts are data views, not authority: they omit the execution handle and fencing
generation. The authenticated private lifecycle response still has to carry that protected
binding for Runmill's renewal and retirement checks.

ctxlane also publishes the capability-free `ctxlane.profile-list/v1` projection. Runmill vendors
that exact file and validates it strictly, member for member: each listed profile must carry a
well-formed profile UID and provider-namespaced profile reference, a provider and an auth mode
that provider actually supports, an eligibility flag, the exposed roles, and the concurrency and
shared-state isolation metadata (lease TTL, session and concurrent-lease bounds, exclusive or
shared mode, isolation requirement, workload-identity requirement, and the authentication and
isolation exception acknowledgements). Unknown members, mismatched provider namespaces, and
inconsistent concurrency or eligibility combinations fail closed. The projection is
diagnostic and readiness input only: it contains no lease ID, execution handle, fencing
generation, credential, or authority, and it cannot authorize an acquisition. A lease request
must still be evaluated independently at the authenticated boundary, so a listed — even
eligible — profile never shortens or substitutes for that path.

`CtxlaneUnixAutomationClient` remains an explicitly `development-only-unqualified`
newline-delimited `SOCK_STREAM` fixture transport. Its path ownership checks do not provide
ctxlane's required peer-process, credential, or cgroup binding, and no production composition
may treat it as trusted. It now refuses authority-bearing calls unless the caller explicitly
sets its test-only `allowDevelopmentOnlyTransport` opt-in. The native deployment contract is
documented in [`ctxlane-native-transport-contract.md`](ctxlane-native-transport-contract.md);
it requires a direct `AF_UNIX`/`SOCK_SEQPACKET` client and forbids stream or helper fallbacks.
Renewal, close, and revoke operations therefore require a mandatory,
operator-supplied in-process `CtxlaneLeaseLifecycleClient`; that adapter must encapsulate the
private begin-renewal, acknowledgement, and final active inspection sequence. A capability-free
`ctxlane.lease-view/v1` projection returned from that boundary is rejected and never promoted
into an `IdentityLease`.

Runmill also exposes `CtxlaneStdioAutomationClient` as an operator-pinned, bounded MCP
stdio bridge. It requires an absolute regular executable, private ownership, a single-link
file, and an exact SHA-256 digest; it invokes only `mcp serve --stdio`, clears the child
environment, bounds one JSON-RPC response, and terminates the child on timeout or cancellation.
Its qualification is `operator-pinned-unqualified`: it is a generic MCP call boundary, not an
identity-lease acquisition client, and it does not authenticate the Runmill parent or promote a
capability-free MCP lease view into an execution lease. The first-party composition remains
blocked until the authenticated lifecycle transport and capability contract are deployed.
Real ctxlane production qualification remains blocked until the authenticated transport and
complete lifecycle path are published and implemented.

### ctxlane service-health observation

Runmill also ships `CtxlaneMcpServiceHealthProbe` in
`dist/identity/ctxlane-service-health.js` for an explicit, Linux-side diagnostic adapter. It
invokes an operator-pinned absolute ctxlane executable as
`ctxlane --root <absolute-root> mcp serve --stdio`, sends only the fixed `ctxlane_health` MCP
request, and validates the returned `ctxlane.service-health/v1` object against the vendored
ctxlane fixture. The executable and root must be private regular paths; the adapter does not do
PATH lookup, follows no symlink, and passes only a small non-secret environment allowlist.

For a runtime module, the health result can be converted into Runmill's diagnostic probe shape:

```ts
const probe = new CtxlaneMcpServiceHealthProbe({
  executable: "/usr/local/bin/ctxlane",
  root: "/var/lib/ctxlane",
});
const serviceHealth = await probe.probe(signal);
const observation = toAsfCtxlaneHealthObservation(serviceHealth, clock);
```

This adapter is classified `authenticated-observation-only`. A successful MCP result proves that
the request crossed ctxlane's authenticated local controller channel, but it does not acquire an
identity, exercise a lease, or provide the private execution handle/fencing generation required
by Runmill's broker. The converted observation preserves ctxlane's
`controller_channel_ready` bit and keeps `automation_lease_probe_passed: false`; it must not be
used to make the first-party composition production-qualified. On macOS and other non-Linux hosts
the ctxlane command itself remains refusal-only, matching ctxlane's platform boundary.

### ctxlane profile-readiness observation

`CtxlaneMcpProfileReadinessProbe` sends the published `ctxlane_check_profile` MCP request
with the exact `client_request_id`, profile UID/reference, environment, role, and bounded
probe timeout fields. It validates the result as the vendored
`ctxlane.automation-readiness/v1` contract and rejects a response bound to any other profile
or execution scope. The resulting envelope is observation-only: it contains no lease ID,
execution handle, fencing generation, credential, or authority, and a fresh lease acquisition
must independently re-evaluate readiness.

```ts
const probe = new CtxlaneMcpProfileReadinessProbe({
  executable: "/usr/local/bin/ctxlane",
  root: "/var/lib/ctxlane",
  clientRequestId: "req_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  profileUid: "profile_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  profileRef: "codex:automation-production",
  environment: "production",
  role: "implementer",
});
const readiness = await probe.probe(signal);
const envelope = toCtxlaneProfileReadinessObservationEnvelope(readiness, {
  profileUid: "profile_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  profileRef: "codex:automation-production",
  environment: "production",
  role: "implementer",
}, clock);
```

This remains `authenticated-observation-only` and is a Linux-side integration seam, not a
claim of a production-qualified ctxlane service, provider harness, or ASF deployment. The
live suite remains opt-in and requires an operator-owned service; no credentials are needed by
the adapter itself, but the service may refuse readiness when its configured provider evidence
is absent or stale.

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
`dist/asf/telemetry.js`: completed spans, monotonic counters, point-in-time queue/active-run
gauges, histograms, and closed-name structured log events. Attribute values come from closed
enumerations plus bounded non-secret correlation IDs (`tenant_id`, `work_order_id`,
`attempt_id`, `run_id`, `invocation_id`, and a `sha256:` candidate digest). Unknown fields or
values are rejected; prompts, model output, paths, credentials, capabilities, and artifact
bytes cannot enter the signal contract. The OTLP adapter maps spans to `/v1/traces`, metrics to
`/v1/metrics`, and structured events to `/v1/logs`. The seam is non-authoritative: exporter and
recorder failures — synchronous or asynchronous — are dropped and can never change admission,
execution, recovery, or shutdown outcomes, nor surface as background errors or unhandled
rejections. This is only an initial OpenTelemetry adapter seam over a worker-kernel
observability surface, not a full OTel SDK integration and not completion of PRD section 23
(the full ASF production telemetry program).

`dist/asf/first-party-composition.js` exports the matching
`runmill.asf-first-party-composition/v1` manifest and a parser for package or operator copies.
The parser requires an exact, ordered port list. `requireAsfFirstPartyComposition()` always
refuses with `first-party-composition-unavailable` while the executable graph is not shipped;
this explicit refusal prevents a declarative document from being mistaken for working provider,
ctxlane, GitHub, or evidence dependencies. The advanced runtime-module seam remains available
for an operator who supplies those ports.

Spans are emitted atomically as already-completed spans: each signal is a single record carrying
only a `duration_ms` for a finished operation, with no separate start/end or in-progress phase
events, and the monotonic clock origin stays private. An OpenTelemetry adapter maps each record to
one completed span at export time. The measured service lifecycle span covers object construction
through worker drain — it is not host-ready uptime and does not include full reference-composition
shutdown. Every run execution emits the `runmill.asf.run.invocations` counter exactly once,
whichever disposition (`terminal`, `durable-pause`, `retry`, `lease-lost`, `unexpected-error`) the
dispatch reaches.

Admission and dispatch signals also carry bounded, non-secret correlation attributes when they are
available: `tenant_id`, `work_order_id`, `attempt_id`, `run_id`, `invocation_id`, and a canonical
`candidate_sha`. The parser accepts only log-safe identifiers or an exact `sha256:` digest; prompts,
model output, paths, credentials, lease capabilities, and protected artifact bytes cannot be
represented as telemetry attributes. These fields let an operator join a trace/metric stream to
the durable attempt without making telemetry an authority source.

For an operator-supplied OTLP/HTTP endpoint, `OtlpHttpAsfTelemetrySink` in
`dist/asf/telemetry.js` maps spans to `/v1/traces` and counters/gauges/histograms to `/v1/metrics`
using the standard JSON envelopes, including closed-name structured events at `/v1/logs`. It accepts
only `http`/`https` URLs without embedded credentials or query strings, bounds the request timeout,
exposes a redacted `health()` snapshot, and keeps export failures non-authoritative. The adapter is opt-in; the reference composition still
requires the operator to provide the telemetry port and does not treat exporter health as proof
of the full ASF telemetry qualification program.

The delivery runner also emits a completed `runmill.asf.run.event` plus an
`runmill.asf.operation.duration` histogram around each durable external-effect stage. The stage
is reduced to the closed vocabulary (`admission`, `identity`, `implementation`, `verification`,
`review`, `delivery`, `evidence`, or `cleanup`) and the event carries only `run_id`,
`work_order_id`, and `attempt_id`. A failed recorder, a backwards or unavailable duration
observation, or an exporter outage is discarded; it cannot alter the effect, recovery, or
terminal outcome. The broader counter and histogram catalog names the remaining production
qualification signals (identity refusals, ambiguous effects, stale fences, cleanup/quarantine,
recovery, and acknowledgement lag), but their end-to-end live qualification still depends on
the operator-owned composition and external controllers.

### Deterministic reference boundary test

`test/asf/reference-composition-e2e.test.ts` drives this assembled composition without
credentials or network access. It now exercises the deterministic path through signed Work
Order admission, published ctxlane acquisition of the exact `implementer`, `local-reviewer`,
and `pr-reviewer` roles, the trusted provider harness and repository tool gateway over a
credential-free sandbox, exact candidate-bound local verification and review, fenced GitHub
branch and pull-request effects, exact-head CI observation, and pull-request delivery. It
then runs the terminal path to completion: deterministic signed attempt evidence
finalization, terminal resource cleanup (identity leases and repository lease released,
workspace removed, no unresolved effects), signed terminal evidence, and a `run.completed`
event bound to the exact candidate SHA. A `StateStore` close and reopen proves the
`COMPLETED` run state, both persisted evidence bundle records, and the exact admission
binding survive recovery, and no lease execution handle or provider credential appears in
the recorded run events.

Every stage of that test — provider, sandbox, ctxlane, GitHub, CI, evidence signing, and
cleanup — runs through in-process, credential-free adapters, not live calls. It is
composition evidence only, and reaching `run.completed` is not a production-readiness claim.
The `integrated` qualification preflight is still `blocked` on
`ctxlane.authenticated-service-unavailable`, `ctxlane.lifecycle-unavailable`, and
`integrated.reference-path-unavailable`; clearing it requires the authenticated ctxlane
service and lifecycle channel plus operator-owned live deployment, GitHub, and CI
qualification. The reference composition remains `productionQualified: false`. Standalone
`runmill start` never loads this path.

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

`runAsfQualificationMatrix` is the execution scaffold for that manifest. It invokes an
operator-owned case executor only after explicit Linux execution authorization and a passing
preflight, records thrown or malformed case results as bounded failures, and returns a frozen
`asf.qualification-execution/v1` report. The closed external catalog includes ctxlane restart
and lease-generation cases, protected GitHub response/head cases, and integrated response-loss,
timeout, denial-canary, recovery, disk, clock, cancellation, takeover, and host-reboot cases.
The report remains `productionQualified: false`; it is qualification evidence, never startup
authority.

`verifyAsfQualificationExecutionReport` is the import boundary for reports returned by an
external harness. It rejects unknown fields, missing/duplicate/unknown catalog cases,
descriptor drift, inconsistent status/reason pairs, count mismatches, hostile object shapes,
and any attempt to set `productionQualified` true. It returns a sanitized frozen copy and
never mutates the supplied report. This makes the matrix auditable without pretending that
the verifier performed the live test itself.

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

## Operator runbook

This runbook applies only to an explicitly configured ASF worker deployment. It does not
change the standalone `runmill start` path, and it does not turn the current reference
composition into a production-qualified deployment.

### Install and preflight

Use Node 22 or 24 on a Linux host. Install the locked dependencies and run the package gates
before placing the worker in service:

```bash
npm ci
npm run check
npm run package:check
```

When a sibling ctxlane publication checkout is available to the maintainer, also run the local
fixture freshness check:

```bash
npm run verify:ctxlane-fixtures -- --source /path/to/Coding\ Agent\ Profiles
```

When a protected Linux ctxlane service is actually available, run the opt-in service-health
qualification test with absolute paths:

```bash
RUNMILL_CTXLANE_BINARY=/usr/local/bin/ctxlane \
RUNMILL_CTXLANE_ROOT=/var/lib/ctxlane \
npx vitest run --config vitest.live.config.ts test/live/ctxlane-service-health.live.test.ts
```

The live test is skipped unless both variables are set on Linux, and it does not claim that
provider readiness, lease acquisition, lifecycle authority, or the complete ASF composition is
qualified.

For a strict qualification run that must not silently skip missing Linux or service
configuration, use the repository runner. Build the architecture-matched native addon first;
the runner requires and exercises the native `SOCK_SEQPACKET` boundary fixture:

```bash
npm run build:native
RUNMILL_CTXLANE_BINARY=/usr/local/bin/ctxlane \
RUNMILL_CTXLANE_ROOT=/var/lib/ctxlane \
RUNMILL_CTXLANE_CLIENT_REQUEST_ID=req_01ARZ3NDEKTSV4RRFFQ69G5FAV \
RUNMILL_CTXLANE_PROFILE_UID=profile_01ARZ3NDEKTSV4RRFFQ69G5FAV \
RUNMILL_CTXLANE_PROFILE_REF=codex:automation-production \
RUNMILL_CTXLANE_ENVIRONMENT=production \
RUNMILL_CTXLANE_ROLE=implementer \
npm run verify:ctxlane-live
```

This command refuses on non-Linux hosts, missing configuration, or a missing native addon. It
still reports observation and transport qualification only; it does not claim provider WIF,
lease lifecycle, harness isolation, or complete ASF production qualification.

To qualify one operator-selected provider profile, run the separate readiness probe with all
request fields pinned explicitly:

```bash
RUNMILL_CTXLANE_BINARY=/usr/local/bin/ctxlane \
RUNMILL_CTXLANE_ROOT=/var/lib/ctxlane \
RUNMILL_CTXLANE_CLIENT_REQUEST_ID=req_01ARZ3NDEKTSV4RRFFQ69G5FAV \
RUNMILL_CTXLANE_PROFILE_UID=profile_01ARZ3NDEKTSV4RRFFQ69G5FAV \
RUNMILL_CTXLANE_PROFILE_REF=codex:automation-production \
RUNMILL_CTXLANE_ENVIRONMENT=production \
RUNMILL_CTXLANE_ROLE=implementer \
npx vitest run --config vitest.live.config.ts test/live/ctxlane-profile-readiness.live.test.ts
```

This test requires `ready: true`, verifies that the response is bound to exactly the requested
profile and role, and checks the observation envelope contains no lease or execution capability.
It is still not lease acquisition, lifecycle qualification, provider-harness qualification, or
proof of the complete ASF composition; it is an opt-in authenticated readiness observation only.

Copy `examples/asf-worker/production-mode.json` to an operator-owned location and replace every
`replace-with-*` value. Keep the config, observation, evaluator public key, and runtime module
in private regular files owned by root or the service user; group/world-writable files, symlinks,
hard links, and unsafe ancestor directories are refused. Generate the signed observation with the
deployment's approved readiness evaluator, then check it without opening the state store:

```bash
runmill service doctor \
  --config /etc/runmill/asf/production-mode.json \
  --observation /etc/runmill/asf/readiness.json \
  --observation-key /etc/runmill/asf/readiness.pub \
  --observation-key-id asf-readiness-2026-01 \
  --json
```

Do not start after a refusal. Fix the reported configuration, signature, digest, key-id, or
readiness reason and issue a new signed observation. A successful doctor result is a preflight
observation only; the first-party manifest and the qualification report must still say
`productionQualified: false` until the external ctxlane, provider, GitHub, and live qualification
requirements are genuinely supplied.

### Start, observe, and stop

Start only with the explicit ASF mode and the signed readiness binding:

```bash
runmill service start \
  --mode asf-worker \
  --config /etc/runmill/asf/production-mode.json \
  --observation /etc/runmill/asf/readiness.json \
  --observation-key /etc/runmill/asf/readiness.pub \
  --observation-key-id asf-readiness-2026-01 \
  --runtime-module /etc/runmill/asf/runtime.mjs
```

The process verifies the binding before importing the module, recovers durable state before
opening the control channel, and re-verifies the binding before every authority-bearing request.
Use `runmill service status` for authenticated health and `runmill mcp serve --stdio` only from
the explicitly configured ASF control environment. `runmill service stop` requests an ordered
shutdown: stop intake, reconcile, retire identities, then release resources. The ASF registry and
socket are separate from the standalone daemon, so stopping one does not stop the other.

### Restart and recovery

After a crash or host restart, preserve the state store, effect intents, lease registry, workspace
quarantine records, and signed evidence. Start the same explicit configuration again; recovery
observes unresolved work and fences stale authority before accepting control. If recovery refuses,
leave the worker stopped, run `service doctor`, and use the authenticated reconciliation or
submission-lookup control operation to resolve the exact run. Never delete state, clear an effect
intent, or retry an ambiguous GitHub/ctxlane mutation by hand.

The MCP `runmill_lookup_submission` operation is for a lost submission response only. Supply the
original idempotency key and both exact request digests; a mismatch intentionally looks like
`not-found`. Reconciliation and cancellation remain durable operations and must be acknowledged by
the controller before an operator closes an incident.

### Evidence, rotation, and backup

Verify a completed bundle on a state-free host before retaining or handing it to ASF:

```bash
runmill evidence verify evidence.json \
  --trust trusted-signers.json \
  --expectations candidate-facts.json \
  --artifacts-dir /var/lib/runmill/evidence-cas \
  --json
```

Keep the exact candidate, Work Order, policy, CI, review, effect, and cleanup bindings together.
Do not include private keys, provider tokens, support bundles, or `.runmill/state/` in source
control or evidence transfers. Backups are operator-managed snapshots of the config/trust roots,
state store, content-addressed evidence, and runtime-module version, preserving ownership and
permissions; restore into a quarantined location and run `service doctor` before rejoining it.

Rotate readiness and control/evidence keys through the operator's secret manager. Publish the new
public key and key id as a new private file, issue a fresh signed observation, run `service doctor`
against the new tuple, and restart only after that check passes. Retain the previous trust material
for the configured evidence-retention window; never replace a key in place while a signed
observation or evidence bundle still depends on it.

### Incident handling

On any readiness, identity, recovery, effect, sandbox, or evidence refusal, stop new intake and
preserve the exact redacted health/events/evidence output. Do not downgrade to the standalone
daemon, substitute the newline-delimited ctxlane fixture transport, or mark a qualification report
ready by editing JSON. Escalate unresolved remote effects with their idempotency and digest
bindings; only the authenticated upstream controller may close or acknowledge them. The worker
should remain fail-closed until the original trust and recovery conditions are restored.

The reference composition is intended for integration testing and operator training. Standalone
`runmill start` never imports this path and does not load reference composition.
