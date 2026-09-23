# ASF worker

You can use Runmill without Autonomous Software Factory (ASF) at all. The normal
`runmill start` command is the standalone backlog-to-PR product, and it never needs ASF,
ctxlane, an ASF signing key, or the MCP adapter. Everything ASF-related sits behind separate,
explicit commands. Ordinary startup cannot enter `asf-worker` mode.

> [!IMPORTANT]
> This page describes a worker kernel and a reference integration boundary. It is not a
> production-complete deployment. `runmill service start --mode asf-worker` loads and runs
> an operator-owned composition module. Runmill supplies the trust boundary, control
> transport, and readiness gate around that module; it does not supply a finished ASF
> controller stack.

## Service and MCP commands

| Command                                                                    | Purpose                                                                            |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `runmill service start --mode asf-worker --config <path> --observation <path> --observation-key <path> --observation-key-id <id> --runtime-module <absolute-path>` | Start the production-gated ASF host with an operator-owned deployment composition and process-owned signed readiness gate |
| `runmill service doctor --config <path> --observation <path> --observation-key <path> --observation-key-id <id>` | Verify a signed live-readiness observation and evaluate the explicit production-mode config |
| `runmill service status`                                                   | Read authenticated health from an explicitly configured ASF worker service         |
| `runmill service stop`                                                     | Request a graceful stop from the ASF worker without affecting standalone mode      |
| `runmill mcp serve --stdio`                                                | Run the stateless ASF MCP adapter against an explicitly started ASF worker service |

`service doctor` is read-only. It takes the global `--config <path>` JSON production-mode
document and, when you have one, a signed `--observation <path>` live-readiness envelope along
with the matching trusted Ed25519 `--observation-key <path>` and `--observation-key-id <id>`. It
never opens the Runmill state store, binds a socket, loads a runtime module, or reads
credentials. An ASF configuration without a signed observation is refused. Unsigned,
digest-mismatched, and wrong-key observations are rejected before evaluation. Even a passing
report is only readiness evidence; it does not set `productionQualified`.

The MCP adapter includes `runmill_lookup_submission` for recovering a lost submission response.
It takes an idempotency key plus the exact payload and envelope digests. On a mismatch it returns
a `not-found` result that is indistinguishable from a real miss, so it never reveals another run.

`--mode` accepts only the literal value `asf-worker`. There is no other production mode.
If you pass `--config <path>` (or the global `--config` before `service`), Runmill reads and
validates the declarative `runmill.production-mode/v1` document before it imports the runtime
module. The trusted module receives the exact absolute path in `context.productionConfigPath`,
and the `configPath` it returns must match. This is a fail-closed configuration handoff. It does
not build the missing first-party composition, so you still need a runtime module.
The production-gated path also requires `--observation`, `--observation-key`, and
`--observation-key-id`. Before recovery, and again before every authority-bearing request, the
host re-reads the signed observation and verifies it against the pinned public key and the
config it parsed itself. The runtime module cannot supply or replace that binding. If you omit
`--config`, you are on the advanced runtime-module API, which stays unqualified and is not a
production deployment.
You can omit `--runtime-module` if `RUNMILL_ASF_RUNTIME_MODULE` is set instead, but the two may
not disagree.

## Sample declarative configuration

The package ships [`examples/asf-worker/production-mode.json`](../examples/asf-worker/production-mode.json),
a schema-valid placeholder document with no credentials in it. Copy it somewhere the operator
owns, replace the `replace-with-*` identifiers, and set private Unix endpoints that suit the
host. The sample is deliberately not a deployment. It has no credentials and no live
observation, and `service doctor` refuses it until you supply explicit readiness evidence. It
does not give you a ctxlane service, provider harness, sandbox, GitHub authorization, evidence
signer, or runtime composition.

The package also ships
[`examples/asf-worker/first-party-composition-manifest.json`](../examples/asf-worker/first-party-composition-manifest.json),
a machine-readable description of that same boundary. It reports
`availability: "runtime-module-required"` on purpose; it is not an executable composition. Its
closed `blockingReasons` list names what is missing: the executable graph, ctxlane's
authenticated transport and authority-bearing lifecycle channel, the provider harness, and live
qualification. The manifest is diagnostic only. A first-party composition is
still a release requirement, and the shipped reference composition remains `productionQualified: false`.

## The runtime module

ASF worker startup is a deployment integration point. It does not come with built-in production
controllers. `runmill service start --mode asf-worker --runtime-module <absolute-path>`
loads an operator-owned ESM composition. Its named `createAsfWorkerHostOptions(context)`
factory returns the fully configured worker host dependencies: the durable `service`
implementation, control authentication, a `readiness` probe, and the repository and config
paths.

The entrypoint is strict about what it will load. The module must be a private regular file
owned by root or the current user (no symlinks, no world- or group-writable ancestor
directories) in a safe directory. The entrypoint checks that the file's identity did not change
between open and factory invocation, and it rejects any factory output that is not a plain
object built from exactly the expected option keys. After that, the host verifies the signed
readiness observation on its own and evaluates it against the production config the process
parsed, before it accepts recovery or control intake. The module's readiness callback is kept
as a compatibility probe. It cannot grant authority by returning a fabricated all-passed report.
Using the advanced runtime-module API without this binding is an explicit qualification gap and
confers no production authority. The reference composition remains
`productionQualified: false`.

## Readiness requirements

The runtime module's `readiness` callback must return the complete, versioned, canonical
`asf.production-readiness-report/v1` evaluator output. The explicit production startup path
evaluates the signed observation independently, so this callback is a compatibility probe and
not where production authority comes from. `AsfWorkerHost`
refuses to start, recover, or accept control traffic if the report is missing or malformed, or
if it passes a custom or partial checklist instead of the full canonical check set
(`hasCanonicalAsfProductionReadinessChecks`). A separate `health` readiness domain gates
`runmill service status` and `runmill service stop` in the same way.

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

Standalone startup reads none of these. The evidence-signing and control-authentication loaders
run only from ASF-specific composition and control code, so an unset or unrelated environment
cannot change standalone behavior.

## Registry and socket isolation

ASF control discovery is kept apart from the standalone daemon. It uses
`RUNMILL_ASF_DAEMON_REGISTRY` or `~/.runmill/asf-worker.json`, and its control socket is named
`asf-worker.sock`. Standalone commands keep using `RUNMILL_DAEMON_REGISTRY` or
`daemon.json`/`daemon.sock`. Both services can run on one host, and by default the ASF status,
stop, and MCP clients cannot reach the standalone daemon.

## The ctxlane boundary

Runmill validates and emits the exact published `ctxlane.identity-lease-request/v1`, and it
accepts complete `ctxlane.identity-lease/v1` or `ctxlane.automation-error/v1` response objects.
During acquisition a trusted authority resolver supplies these fields: a stable
`client_request_id`, the signed work-order authorization, `provider` and `profile` UIDs,
`repository`, `workspace`, and `environment` identifiers, caller and host expectations, and
a separate `ctxlane` policy digest.

The ASF-only `createAsfCtxlaneIdentityController()` factory builds the real ctxlane broker and
Runmill's identity lifecycle around those explicit operator-owned ports. The credential-free
reference qualification test then drives the assembled runner through the provider harness, the
sandbox/tool gateway, exact candidate-bound local verification and review, deterministic
GitHub/CI effects, pull-request delivery, deterministic signed attempt evidence finalization,
terminal resource cleanup, signed terminal evidence, and `run.completed`. Every stage goes
through in-process, credential-free adapters. That makes it composition evidence and nothing
more. The reference composition is still not production-qualified (`productionQualified`
remains `false`), and the `integrated` qualification preflight remains `blocked` on the
authenticated ctxlane service and lifecycle channel and on operator-owned live deployment,
GitHub, and CI qualification.

Runmill fencing and Runmill policy are never sent as ctxlane fields. Full attribution is
protected and persisted inside Runmill's own envelope. Duplicate JSON members in ctxlane objects
fail closed: the ctxlane boundary rejects any message with repeated field names.

ctxlane now publishes the lifecycle parameter objects for renew, inspect, revoke, and close,
the renewal acknowledgement, and capability-free `ctxlane.lease-view/v1` receipts. Runmill
vendors those exact files and validates them byte-for-byte against the sibling publication tree.
The public receipts are data views and carry no authority: they leave out the execution handle
and the fencing generation. The authenticated private lifecycle response still has to carry that
protected binding for Runmill's renewal and retirement checks.

ctxlane also publishes the capability-free `ctxlane.profile-list/v1` projection. Runmill vendors
that exact file and validates it strictly, member by member. Each listed profile must carry a
well-formed profile UID and a provider-namespaced profile reference, a provider and an auth mode
that provider actually supports, an eligibility flag, the exposed roles, and the concurrency and
shared-state isolation metadata (lease TTL, session and concurrent-lease bounds, exclusive or
shared mode, isolation requirement, workload-identity requirement, and the authentication and
isolation exception acknowledgements). Unknown members, mismatched provider namespaces, and
inconsistent concurrency or eligibility combinations fail closed. The projection is diagnostic
and readiness input only. It contains no lease ID, execution handle, fencing generation,
credential, or authority, and it cannot authorize an acquisition. A lease request is still
evaluated independently at the authenticated boundary, so a listed profile, eligible or not,
never shortens or substitutes for that path.

`CtxlaneUnixAutomationClient` is still an explicitly `development-only-unqualified`
newline-delimited `SOCK_STREAM` fixture transport. Its path ownership checks do not give you the
peer-process, credential, or cgroup binding ctxlane requires, and no production composition may
treat it as trusted. It refuses authority-bearing calls unless the caller explicitly sets its
test-only `allowDevelopmentOnlyTransport` opt-in. The native deployment contract lives in
[`ctxlane-native-transport-contract.md`](ctxlane-native-transport-contract.md). It requires a
direct `AF_UNIX`/`SOCK_SEQPACKET` client and forbids stream or helper fallbacks.
That is why renewal, close, and revoke require a mandatory, operator-supplied in-process
`CtxlaneLeaseLifecycleClient`. That adapter has to encapsulate the private begin-renewal,
acknowledgement, and final active inspection sequence. If the boundary returns a capability-free
`ctxlane.lease-view/v1` projection, Runmill rejects it and never promotes it into an
`IdentityLease`.

Runmill also exposes `CtxlaneStdioAutomationClient`, an operator-pinned, bounded MCP stdio
bridge. It requires an absolute regular executable with private ownership, a single link, and an
exact SHA-256 digest. It invokes only `mcp serve --stdio`, clears the child environment, bounds
a single JSON-RPC response, and kills the child on timeout or cancellation. Its qualification is
`operator-pinned-unqualified`. It is a generic MCP call boundary and not an identity-lease
acquisition client: it does not authenticate the Runmill parent, and it does not promote a
capability-free MCP lease view into an execution lease. The first-party composition stays
blocked until the authenticated lifecycle transport and capability contract are deployed.
Real ctxlane production qualification stays blocked until the authenticated transport and the
complete lifecycle path are published and implemented.

### ctxlane service-health observation

Runmill also ships `CtxlaneMcpServiceHealthProbe` in
`dist/identity/ctxlane-service-health.js`, an explicit, Linux-side diagnostic adapter. It runs an
operator-pinned absolute ctxlane executable as
`ctxlane --root <absolute-root> mcp serve --stdio`, sends only the fixed `ctxlane_health` MCP
request, and validates the returned `ctxlane.service-health/v1` object against the vendored
ctxlane fixture. The executable and root must be private regular paths. The adapter does no PATH
lookup, follows no symlinks, and passes only a small allowlist of non-secret environment
variables.

In a runtime module, you can convert the health result into Runmill's diagnostic probe shape:

```ts
const probe = new CtxlaneMcpServiceHealthProbe({
  executable: "/usr/local/bin/ctxlane",
  root: "/var/lib/ctxlane",
});
const serviceHealth = await probe.probe(signal);
const observation = toAsfCtxlaneHealthObservation(serviceHealth, clock);
```

This adapter is classified `authenticated-observation-only`. A successful MCP result shows that
the request crossed ctxlane's authenticated local controller channel. It does not acquire an
identity, exercise a lease, or provide the private execution handle and fencing generation that
Runmill's broker needs. The converted observation keeps ctxlane's
`controller_channel_ready` bit and leaves `automation_lease_probe_passed: false`. Do not use it
to make the first-party composition production-qualified. On macOS and other non-Linux hosts the
ctxlane command itself is refusal-only, which matches ctxlane's platform boundary.

### ctxlane profile-readiness observation

`CtxlaneMcpProfileReadinessProbe` sends the published `ctxlane_check_profile` MCP request
with the exact `client_request_id`, profile UID and reference, environment, role, and a bounded
probe timeout. It validates the result against the vendored `ctxlane.automation-readiness/v1`
contract and rejects a response bound to any other profile or execution scope. The resulting
envelope is an observation and nothing else. It contains no lease ID, execution handle, fencing
generation, credential, or authority, and a fresh lease acquisition has to re-evaluate readiness
on its own.

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

This is also `authenticated-observation-only`. It is a Linux-side integration seam and makes no
claim that the ctxlane service, provider harness, or ASF deployment is production-qualified. The
live suite stays opt-in and needs an operator-owned service. The adapter itself needs no
credentials, but the service may refuse readiness when its configured provider evidence is
absent or stale.

## Reference composition

The `createAsfReferenceWorkerHostOptions()` factory and the `inspectAsfReferenceComposition()`
introspection function are exported from `dist/asf/reference-composition.js`. The composition is
classified as a `reference-integration-boundary` with `productionQualified:
false`. It wires the real `AsfPrDeliveryRunner` and `AsfWorkerService` only when every listed
operator port is supplied. Otherwise it refuses startup before recovery and control intake.
Startup coordinates shutdown reconciliation, identity retirement, and resource cleanup in that
order. None of this makes it production qualified.

| Operator port group                     | Required ports                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| Recovery/resource lifecycle             | recovery intake, resource lifecycle, lease recovery                                   |
| Provider/identity/tooling               | provider endpoint, identity resolver, tool registry                                   |
| Verification/review                     | review authority, evidence validator                                                  |
| GitHub/CI/reconciliation                | GitHub API, CI orchestrator, reconciliation sink                                      |
| Evidence/control/observability/shutdown | evidence store, control transport, health probe, telemetry sink, shutdown coordinator |

The required telemetry port receives only the fixed, low-cardinality signals defined in
`dist/asf/telemetry.js`: completed spans, monotonic counters, point-in-time queue and active-run
gauges, histograms, and structured log events with closed names. Attribute values come from
closed enumerations plus bounded, non-secret correlation IDs (`tenant_id`, `work_order_id`,
`attempt_id`, `run_id`, `invocation_id`, and a `sha256:` candidate digest). Unknown fields or
values are rejected. Prompts, model output, paths, credentials, capabilities, and artifact bytes
have no way into the signal contract. The OTLP adapter maps spans to `/v1/traces`, metrics to
`/v1/metrics`, and structured events to `/v1/logs`. The seam carries no authority. Exporter and
recorder failures, synchronous or asynchronous, are dropped. They can never change admission,
execution, recovery, or shutdown outcomes, and they never surface as background errors or
unhandled rejections. This is an initial OpenTelemetry adapter seam over a worker-kernel
observability surface. It is not a full OTel SDK integration, and it does not complete PRD
section 23 (the full ASF production telemetry program).

`dist/asf/first-party-composition.js` exports the matching
`runmill.asf-first-party-composition/v1` manifest and a parser for package or operator copies.
The parser requires an exact, ordered port list. `requireAsfFirstPartyComposition()` always
refuses with `first-party-composition-unavailable` while the executable graph is not shipped.
The refusal is there so nobody mistakes a declarative document for working provider, ctxlane,
GitHub, or evidence dependencies. The advanced runtime-module seam is still available to an
operator who supplies those ports.

Spans are emitted atomically as already-completed spans. Each signal is a single record that
carries only a `duration_ms` for a finished operation. There are no separate start/end or
in-progress phase events, and the monotonic clock origin stays private. An OpenTelemetry adapter
maps each record to one completed span at export time. The measured service lifecycle span runs
from object construction through worker drain. It is not host-ready uptime, and it does not
include full reference-composition shutdown. Every run execution emits the
`runmill.asf.run.invocations` counter exactly once, whichever disposition (`terminal`,
`durable-pause`, `retry`, `lease-lost`, `unexpected-error`) the dispatch reaches.

Admission and dispatch signals also carry bounded, non-secret correlation attributes when they
are available: `tenant_id`, `work_order_id`, `attempt_id`, `run_id`, `invocation_id`, and a
canonical `candidate_sha`. The parser accepts only log-safe identifiers or an exact `sha256:`
digest. Prompts, model output, paths, credentials, lease capabilities, and protected artifact
bytes cannot be expressed as telemetry attributes. With these fields an operator can join a
trace or metric stream to the durable attempt, and telemetry still never becomes a source of
authority.

For an operator-supplied OTLP/HTTP endpoint, `OtlpHttpAsfTelemetrySink` in
`dist/asf/telemetry.js` maps spans to `/v1/traces`, counters/gauges/histograms to `/v1/metrics`,
and closed-name structured events to `/v1/logs`, using the standard JSON envelopes. It accepts
only `http`/`https` URLs with no embedded credentials or query strings, bounds the request
timeout, exposes a redacted `health()` snapshot, and keeps export failures non-authoritative.
The adapter is opt-in. The reference composition still requires the operator to provide the
telemetry port, and it does not treat exporter health as proof of the full ASF telemetry
qualification program.

The delivery runner also emits a completed `runmill.asf.run.event` plus a
`runmill.asf.operation.duration` histogram around each durable external-effect stage. The stage
is reduced to a closed vocabulary (`admission`, `identity`, `implementation`, `verification`,
`review`, `delivery`, `evidence`, or `cleanup`), and the event carries only `run_id`,
`work_order_id`, and `attempt_id`. A failed recorder, a duration observation that runs backwards
or is unavailable, or an exporter outage is discarded; none of them can alter the effect,
recovery, or terminal outcome. The wider counter and histogram catalog names the remaining
production qualification signals (identity refusals, ambiguous effects, stale fences,
cleanup/quarantine, recovery, and acknowledgement lag). Qualifying them end to end against live
systems still depends on the operator-owned composition and external controllers.

### Deterministic reference boundary test

`test/asf/reference-composition-e2e.test.ts` drives the assembled composition with no
credentials and no network. It exercises the deterministic path through signed Work Order
admission, published ctxlane acquisition of the exact `implementer`, `local-reviewer`, and
`pr-reviewer` roles, the trusted provider harness and repository tool gateway over a
credential-free sandbox, exact candidate-bound local verification and review, fenced GitHub
branch and pull-request effects, exact-head CI observation, and pull-request delivery. It then
runs the terminal path to the end: deterministic signed attempt evidence finalization, terminal
resource cleanup (identity leases and the repository lease released, workspace removed, no
unresolved effects), signed terminal evidence, and a `run.completed` event bound to the exact
candidate SHA. Closing and reopening the `StateStore` proves that the `COMPLETED` run state,
both persisted evidence bundle records, and the exact admission binding survive recovery. No
lease execution handle or provider credential appears in the recorded run events.

Every stage of that test (provider, sandbox, ctxlane, GitHub, CI, evidence signing, and cleanup)
runs through in-process, credential-free adapters. Nothing is a live call. It is composition
evidence only, and reaching `run.completed` says nothing about production readiness.
The `integrated` qualification preflight is still `blocked` on
`ctxlane.authenticated-service-unavailable`, `ctxlane.lifecycle-unavailable`, and
`integrated.reference-path-unavailable`. Clearing it takes the authenticated ctxlane service and
lifecycle channel plus operator-owned live deployment, GitHub, and CI qualification. The
reference composition remains `productionQualified: false`. Standalone
`runmill start` never loads this path.

## Qualification manifest and preflight

`dist/asf/qualification.js` exports `evaluateAsfQualificationPreflight`, a pure prerequisite
evaluation for explicit qualification runs that authorizes nothing. Next to it are frozen
manifest constants for the profile, the applicability list, and the cold-start case matrix. The
API has no filesystem, credential, process, socket, or network effects and takes no live action.
Its result can never grant authority or authorize startup:
`productionQualified` is `false` in every result, `ready-to-run` ones included.

The PR-only profile (`asf.pr-only-qualification-profile/v1`) applies exactly 15 of the 17
catalog checkpoint kinds. The two merge checkpoints (`merge-queue-candidate-state` and
`merge-intent-observation`) are `not-applicable` with reason
`pr-only-profile-prohibits-merge`, because the profile prohibits merging. The
`process-cold-start` matrix is the deterministic product of those 15 applicable checkpoints and
the `before`/`after` boundaries, which gives exactly 30 cases. Each boundary is a worker process
restart around the checkpoint and nothing more. `process-cold-start` is not a host reboot, and
the preflight makes no claim about host reboots.

`runAsfQualificationMatrix` is the execution scaffold for that manifest. It calls an
operator-owned case executor only after explicit Linux execution authorization and a passing
preflight. Thrown or malformed case results are recorded as bounded failures, and it returns a
frozen `asf.qualification-execution/v1` report. The closed external catalog includes ctxlane
restart and lease-generation cases, protected GitHub response/head cases, and integrated
response-loss, timeout, denial-canary, recovery, disk, clock, cancellation, takeover, and
host-reboot cases. The report stays `productionQualified: false`. It is qualification evidence
and never startup authority.

`verifyAsfQualificationExecutionReport` is the import boundary for reports that come back from
an external harness. It rejects unknown fields, missing, duplicate, or unknown catalog cases,
descriptor drift, inconsistent status/reason pairs, count mismatches, hostile object shapes,
and any attempt to set `productionQualified` to true. It returns a sanitized frozen copy and
never mutates the report it was given. That keeps the matrix auditable without pretending the
verifier ran the live test itself.

Per-target behavior:

- `ctxlane` and `integrated` are hard-blocked today. The preflight always adds
  `ctxlane.authenticated-service-unavailable` and `ctxlane.lifecycle-unavailable` (plus
  `integrated.reference-path-unavailable` for `integrated`), so neither can reach
  `ready-to-run` until the authenticated ctxlane transport and lifecycle path exist.
- `github-protected` can at most become syntactically ready-to-run, and only with explicit
  private bindings: `execute: true`, a caller-asserted `platform: "linux"`, a valid explicit
  private `owner/repo` with `privateRepository: true`, distinct absolute `tokenFile` and
  `outputPath` files, and an `acknowledgement` that repeats the repository exactly. Even a
  `ready-to-run` decision performs no live GitHub action. The preflight does not verify
  credentials, permissions, or branch protection, and it does not run a pilot.
- Every target also requires `execute: true` and `platform: "linux"`. Anything else fails closed
  with `execution-not-explicitly-authorized` or `platform-not-linux`.

## Operator runbook

This runbook applies only to an explicitly configured ASF worker deployment. It does not change
the standalone `runmill start` path, and following it does not turn the current reference
composition into a production-qualified deployment.

### Install and preflight

Use Node 22 or 24 on a Linux host. Install the locked dependencies and run the package gates
before you put the worker in service:

```bash
npm ci
npm run check
npm run package:check
```

If the maintainer has a sibling ctxlane publication checkout, also run the local fixture
freshness check:

```bash
npm run verify:ctxlane-fixtures -- --source /path/to/Coding\ Agent\ Profiles
```

If a protected Linux ctxlane service is actually available, run the opt-in service-health
qualification test with absolute paths:

```bash
RUNMILL_CTXLANE_BINARY=/usr/local/bin/ctxlane \
RUNMILL_CTXLANE_ROOT=/var/lib/ctxlane \
npx vitest run --config vitest.live.config.ts test/live/ctxlane-service-health.live.test.ts
```

The live test is skipped unless both variables are set and you are on Linux. It does not claim
that provider readiness, lease acquisition, lifecycle authority, or the complete ASF composition
is qualified.

For a strict qualification run, where missing Linux or service configuration must not be
silently skipped, use the repository runner. Build the architecture-matched native addon first,
because the runner requires and exercises the native `SOCK_SEQPACKET` boundary fixture:

```bash
npm run build:native
RUNMILL_CTXLANE_BINARY=/usr/local/bin/ctxlane \
RUNMILL_CTXLANE_ROOT=/var/lib/ctxlane \
RUNMILL_CTXLANE_ENDPOINT=unix:///var/lib/ctxlane/automation-controller.sock \
RUNMILL_CTXLANE_EXPECTED_PEER_EXECUTABLE=/usr/local/bin/ctxlane \
RUNMILL_CTXLANE_EXPECTED_PEER_CGROUP=0::/system.slice/ctxlane.service \
RUNMILL_CTXLANE_CLIENT_REQUEST_ID=req_01ARZ3NDEKTSV4RRFFQ69G5FAV \
RUNMILL_CTXLANE_PROFILE_UID=profile_01ARZ3NDEKTSV4RRFFQ69G5FAV \
RUNMILL_CTXLANE_PROFILE_REF=codex:automation-production \
RUNMILL_CTXLANE_ENVIRONMENT=production \
RUNMILL_CTXLANE_ROLE=implementer \
RUNMILL_CTXLANE_LIVE_REQUEST_FILE=/etc/runmill/asf/identity-lease-request.json \
npm run verify:ctxlane-live
```

This command refuses on non-Linux hosts, with missing configuration, or without the native
addon. What it reports is observation and transport qualification. It makes no claim about
provider WIF, the lease lifecycle, harness isolation, or complete ASF production qualification.

To qualify one provider profile the operator has chosen, run the separate readiness probe with
every request field pinned explicitly:

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

The test requires `ready: true`, checks that the response is bound to exactly the requested
profile and role, and checks that the observation envelope contains no lease or execution
capability. It is an opt-in authenticated readiness observation and that is all. It does not
acquire a lease, and it does not qualify the lifecycle, the provider harness, or the complete
ASF composition.

Copy `examples/asf-worker/production-mode.json` to a location the operator owns and replace
every `replace-with-*` value. Keep the config, the observation, the evaluator public key, and
the runtime module in private regular files owned by root or the service user. Group- or
world-writable files, symlinks, hard links, and unsafe ancestor directories are refused.
Generate the signed observation with the deployment's approved readiness evaluator, then check
it without opening the state store:

```bash
runmill service doctor \
  --config /etc/runmill/asf/production-mode.json \
  --observation /etc/runmill/asf/readiness.json \
  --observation-key /etc/runmill/asf/readiness.pub \
  --observation-key-id asf-readiness-2026-01 \
  --json
```

Do not start after a refusal. Fix whatever it reported (configuration, signature, digest, key
id, or readiness reason) and issue a new signed observation. A successful doctor result is a
preflight observation and nothing more. The first-party manifest and the qualification report
must keep saying `productionQualified: false` until the external ctxlane, provider, GitHub, and
live qualification requirements are genuinely met.

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

The process verifies the binding before it imports the module, recovers durable state before it
opens the control channel, and verifies the binding again before every authority-bearing
request. Use `runmill service status` for authenticated health. Run `runmill mcp serve --stdio`
only from the explicitly configured ASF control environment. `runmill service stop` requests an
ordered shutdown: stop intake, reconcile, retire identities, then release resources. The ASF
registry and socket are separate from the standalone daemon, so stopping one leaves the other
running.

### Restart and recovery

After a crash or host restart, keep the state store, effect intents, lease registry, workspace
quarantine records, and signed evidence. Start the same explicit configuration again. Recovery
observes unresolved work and fences stale authority before it accepts control. If recovery
refuses, leave the worker stopped, run `service doctor`, and resolve the exact run with the
authenticated reconciliation or submission-lookup control operation. Never delete state, clear
an effect intent, or retry an ambiguous GitHub or ctxlane mutation by hand.

The MCP `runmill_lookup_submission` operation exists for one case: a lost submission response.
Supply the original idempotency key and both exact request digests. A mismatch deliberately
looks like `not-found`. Reconciliation and cancellation are still durable operations, and the
controller must acknowledge them before an operator closes the incident.

### Evidence, rotation, and backup

Verify a completed bundle on a state-free host before you retain it or hand it to ASF:

```bash
runmill evidence verify evidence.json \
  --trust trusted-signers.json \
  --expectations candidate-facts.json \
  --artifacts-dir /var/lib/runmill/evidence-cas \
  --json
```

Keep the exact candidate, Work Order, policy, CI, review, effect, and cleanup bindings together.
Keep private keys, provider tokens, support bundles, and `.runmill/state/` out of source control
and out of evidence transfers. Backups are operator-managed snapshots of the config and trust
roots, the state store, content-addressed evidence, and the runtime-module version, with
ownership and permissions preserved. Restore into a quarantined location and run
`service doctor` before the worker rejoins.

Rotate readiness keys and control/evidence keys through the operator's secret manager. Publish
the new public key and key id as a new private file, issue a fresh signed observation, run
`service doctor` against the new tuple, and restart only after that check passes. Keep the
previous trust material for the configured evidence-retention window. Never replace a key in
place while a signed observation or evidence bundle still depends on it.

### Incident handling

On any readiness, identity, recovery, effect, sandbox, or evidence refusal, stop new intake and
keep the exact redacted health, events, and evidence output. Do not fall back to the standalone
daemon, swap in the newline-delimited ctxlane fixture transport, or edit JSON to mark a
qualification report ready. Escalate unresolved remote effects with their idempotency and
digest bindings. Only the authenticated upstream controller may close or acknowledge them. The
worker should stay fail-closed until the original trust and recovery conditions are back.

The reference composition is meant for integration testing and operator training. Standalone
`runmill start` never imports this path and does not load the reference composition.
