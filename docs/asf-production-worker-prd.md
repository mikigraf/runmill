# PRD: Production Delivery Runtime for ASF

- **Project:** Runmill
- **Status:** Proposed implementation contract
- **Date:** 2026-08-22
- **Target release:** First production-qualified ASF worker, PR closure only
- **Owners:** Runmill maintainers
- **Upstream contracts:** ASF Work Order/control; ctxlane automation identity

## 1. Executive summary

Runmill already implements the difficult core of a bounded coding-agent delivery attempt: exact repository admission, isolated workspaces, implementation, exact-candidate verification, fresh-context review, controlled GitHub effects, durable effect reconciliation, budgets, cancellation, signed evidence, and a private ASF control surface.

The remaining work is to turn those components into a supported production worker that ASF can start, interrogate, recover, and trust without supplying a bespoke JavaScript composition module.

The production promise is:

> Given one immutable, signed Work Order, Runmill either produces a verified pull request with signed exact-commit evidence or stops in a durable, owned state that says what must happen next.

Runmill owns one attempt. It does not own whether work should be accepted, the cross-attempt obligation, source closure, or product-level completion. Those remain ASF responsibilities.

## 2. Release slice

The first production worker is intentionally constrained:

- single tenant;
- Linux only;
- one repository per Work Order;
- GitHub repository and pull-request delivery;
- pull request as the only closure target;
- no merge, deploy, or post-deploy observation authority;
- one current attempt per Work Order;
- explicit Codex/Claude role identities supplied through signed ctxlane authorization;
- bubblewrap-based sandbox with a read-only base and ephemeral workspaces;
- repository tools and verification without provider credentials;
- a private Unix control endpoint;
- signed portable attempt evidence and signed terminal cleanup evidence;
- a first-party deployment composition;
- no backlog selection or mutation in ASF-worker mode.

Standalone Runmill remains a separate supported developer-preview product and must not require ASF, ctxlane, or ASF signing keys.

## 3. Verified repository baseline

### 3.1 Existing standalone delivery loop

The repository already implements:

- Linear issue selection and Git-ref claims;
- Codex and Claude CLI provider adapters;
- isolated implementation and review workspaces;
- write-scope enforcement;
- exact-commit verification in a fresh checkout;
- machine-readable test evidence and refusal of zero-test/undeclared-skip cases;
- fresh local and PR review roles;
- durable GitHub/Linear effect intents and ambiguity reconciliation;
- budgets and circuit breakers;
- PR-only, guarded-merge, and continuous modes, with PR-only recommended;
- recovery and inspection surfaces.

### 3.2 Existing ASF worker foundation

The current branch contains substantial ASF-specific implementation:

- strict signed `asf.work-order/v1` admission;
- durable ASF run and event state;
- an explicit ASF worker host;
- production-readiness evaluation;
- separate ASF control discovery/socket namespace;
- cryptographic local-control authentication;
- MCP tools for submit, get run, list events, evidence, cancellation, approval, reconciliation, acknowledgement, and health;
- identity lifecycle and protected lease registry;
- durable reconciliation and cancellation;
- signed in-toto-style attempt evidence;
- signed terminal evidence after cleanup;
- filesystem content-addressed artifact storage;
- source-tested integration fixtures in ASF.

The current working tree now contains the ctxlane boundary correction:

- vendored upstream ctxlane v1 schemas and examples with provenance;
- strict TypeScript transcriptions in `src/identity/ctxlane-contracts.ts`;
- an authority-resolver interface for the immutable fields absent from Runmill's internal lease request;
- acquisition requests built with every published v1 authority coordinate and signed Work Order authorization;
- strict validation of the published lease and code-only automation-error projections;
- a dedicated `docs/asf-worker.md` operator-facing description and documentation-contract tests.

The deterministic reference qualification boundary now exercises the assembled
delivery runner through signed Work Order admission, the published ctxlane role
composition, the credential-free provider harness, the sandbox/tool gateway,
exact candidate-bound local verification and review, fenced deterministic
GitHub/CI effects, pull-request delivery, deterministic signed attempt evidence
finalization, terminal resource cleanup, signed terminal evidence, and
`run.completed`, with durable recovery of the completed run proved across a
state-store close and reopen. Every stage runs through in-process,
credential-free adapters. This is composition evidence only: it is not live
provider, GitHub, CI, evidence-signing, or production-readiness qualification.
`productionQualified` remains `false`, and the `integrated` qualification
preflight remains `blocked` on the authenticated ctxlane service and lifecycle
channel and on operator-owned live deployment, GitHub, and CI qualification.

The exact acquisition projection is wired and covered by byte-identical sibling fixtures. The
current ctxlane publication also supplies exact lifecycle parameter objects, the renewal
acknowledgement, and capability-free lease-view/receipt schemas; Runmill vendors and validates
those shapes. They do not carry the execution handle or fencing generation required to exercise
Runmill authority, so renew/close/revoke remain behind an operator-supplied in-process client
until ctxlane publishes the private authenticated lifecycle channel. The Unix transport remains
explicitly development-only and unqualified until it can authenticate the native ctxlane channel.

This is not a greenfield worker. The PRD should compose and qualify existing components before adding new orchestration features.

### 3.3 Verified blockers

#### ctxlane protocol mismatch

The acquisition path in `src/identity/ctxlane-broker.ts` now implements the
published ctxlane v1 request and lease/error projections, including signed
Work Order authorization, tenant/repository/workspace/provider/profile
coordinates, policy-digest equality, and strict duplicate-key rejection. The
remaining contract blocker is outside the acquisition schema: the public lifecycle
parameter/view schemas are now frozen and cross-tested, but ctxlane has not published the
private authority-bearing lifecycle response/channel that carries the execution handle and
fencing transition. Runmill's Unix stream transport is also not compatible with ctxlane's Linux
authenticated `SOCK_SEQPACKET` channel. The live path therefore remains unqualified until those
interfaces are implemented and a native authenticated transport is exercised.

#### Bespoke runtime module required

`runmill service start --mode asf-worker` requires an operator-owned `RUNMILL_ASF_RUNTIME_MODULE`/`--runtime-module` that supplies all production dependencies. The loader is defensive, but Runmill does not ship a first-party complete production composition. A caller cannot install the package and start a qualified worker from declarative configuration alone.

The package now ships `runmill.asf-first-party-composition/v1` as an exact,
machine-readable manifest of the reference boundary and a fail-closed parser/refusal API.
This makes the missing executable graph discoverable without promoting a declarative document
into authority; `productionQualified` remains exactly `false` and the runtime-module seam is
still required until the first-party providers and published ctxlane lifecycle/transport exist.

#### Lost submission lookup gap

The production control surface now provides a durable Work Order idempotency
lookup for a lost submission response and binds the lookup to the exact request
digest before reopening the run. The remaining release gap is qualification of
that path against a first-party deployed controller and real restart/transport
failure, not the absence of a lookup API.

#### Work Order v1 authority gaps

The strict current Work Order does not carry all authority inputs ASF's own P0 audit requires, including a complete source reference, risk reasons, planner digest, command policy, and an explicitly named repository-policy digest. Because v1 is strict, these fields require a versioned successor rather than silent additions.

#### Operator documentation is present but still describes a kernel

The current working tree now moves ASF-specific commands, environment variables, readiness requirements, socket isolation, and the ctxlane boundary into `docs/asf-worker.md`, with CLI contract tests that enforce the split. That resolves the prior broken-link/documentation-coverage issue. The document correctly says the worker is an operator-composed kernel, not a production-complete deployment. It must be expanded alongside the first-party composition into a complete install, preflight, recovery, key-rotation, backup, upgrade, and incident guide before release.

#### Deployment gaps

- Standalone provider credential handling is explicitly experimental and allows copied subscription state to be readable by agent tools.
- Standalone `proxy` networking is unrestricted provider egress.
- The ASF production config describes a host-side credential harness and disabled tool network, but a first-party qualified deployment is not supplied.
- OpenTelemetry export is opt-in and bounded, but a production collector,
  sampling/retention policy, and end-to-end trace/metric qualification are not
  shipped.
- `runmill service doctor` and the explicit `service start --config` path now verify a signed,
  digest-bound readiness observation against an explicitly pinned Ed25519 evaluator key before
  evaluating it. The host re-reads that observation before recovery and authority-bearing control
  requests; the runtime-module callback cannot replace the process-owned binding. The advanced
  runtime-module API without this binding remains unqualified and must not be treated as a
  production deployment.
- Live cross-repository failure qualification has not been completed.

## 4. Product goals

### G1. Production attempt execution

Accept one signed Work Order, execute only its bounded authority, and durably reach verified pull-request evidence or an explicit terminal/attention state.

### G2. Exact contract interoperability

Consume ctxlane's canonical identity contracts and ASF's canonical Work Order/control contracts without parallel lookalike schemas.

### G3. First-party operability

An operator can install Runmill, provide declarative production configuration and external credentials/trust roots, run preflight, and start the ASF worker without authoring executable composition code.

### G4. Safe recovery

Run, effect, identity, workspace, budget, event, evidence, and acknowledgement state survives worker restarts. Lost network responses are reconciled rather than blindly retried.

### G5. Independently verifiable evidence

The attempt produces portable signed evidence tied to the Work Order, exact candidate, checks, reviews, CI, identity attribution, budgets, effects, and cleanup. Verification is reproducible; agent execution is not claimed to be deterministic.

### G6. Preserve standalone product boundaries

Ordinary `runmill start`, `daemon`, `run`, `demo`, and TUI paths remain independent of ASF-worker configuration and identity service availability.

## 5. Non-goals

The first production worker will not:

- discover or accept backlog work;
- decide the business priority of work;
- sign ASF Work Orders;
- close Linear/GitHub source items on behalf of ASF;
- own cross-attempt retries or final accountability;
- merge, deploy, or observe production;
- expose provider, GitHub, Linear, or ASF credentials to coding workers;
- expose ctxlane administration to workers;
- support multi-tenant hosted worker service;
- support macOS as a production ASF worker;
- implement generic multi-agent collaboration beyond the explicit implementer/fixer/reviewer stages;
- claim that a reviewer is independent merely because it has a different role name;
- claim deterministic replay of model execution;
- use MCP as the durability layer.

## 6. Users and jobs

### ASF controller

Submits a signed Work Order, receives a run ID immediately, observes durable state/events, obtains signed evidence, cancels or approves at supported checkpoints, requests reconciliation, and acknowledges the outcome.

### Platform operator

Registers the worker, configures repositories, trust roots, ctxlane endpoint, harnesses, sandbox, GitHub permissions, signer keys, resource limits, retention, and telemetry. Needs clear readiness and runbooks.

### Security/reliability operator

Needs to inspect exact authority, effects, identity lineage, failure ownership, evidence signatures, and cleanup without retrieving credentials or unrestricted transcripts.

### Coding/review agents

Receive a bounded role, task packet, workspace, and credential-free tool surface. They propose code or verdicts; they never own external mutations or policy.

## 7. Ownership boundaries

| Concern | Owner |
| --- | --- |
| Work acceptance, cross-attempt obligation, source closure | ASF |
| Work Order signature and maximum authority | ASF or another trusted signer |
| One delivery attempt | Runmill |
| Provider identity lease and host-side credential isolation | ctxlane |
| Repository tool sandbox | Runmill |
| GitHub mutation intent/reconciliation inside the attempt | Runmill |
| Exact candidate verification and independent review | Runmill |
| Signed attempt and cleanup evidence | Runmill |
| Final closure pack and externally owned escalation | ASF |

## 8. Target architecture

```text
ASF durable controller
  | signed Work Order / authenticated control
  v
Runmill ASF worker service
  |-- Work Order admission and durable run state
  |-- ctxlane identity client and protected lease registry
  |-- trusted provider harness integration
  |-- credential-free repository tool gateway
  |-- workspace/sandbox/check/review pipeline
  |-- GitHub effects and reconciliation
  |-- evidence finalizer and signer
  `-- private control API + OTLP
        |
        +--> ctxlane private identity service
        +--> GitHub trusted host adapter
        +--> artifact store
```

The MCP server remains a stateless adapter to the separately durable worker service. It is exposed only to the trusted controller environment.

## 9. Contract decisions

### 9.1 ctxlane is the identity schema authority

Runmill must remove its parallel `ctxlane.automation-identity-request/v1` and simplified lease shapes when the canonical ctxlane operation schemas are available.

The production client must:

- validate against the exact published schema/version;
- send the signed Work Order authorization and every duplicated authority field;
- use immutable profile UID plus expected alias;
- handle `requested`, `active`, `renewing`, terminal, `refused`, and `error` shapes correctly;
- distinguish durable refusal from transport/service error;
- preserve nullability and stable reason codes;
- never put lease IDs or execution handles into public state, events, evidence, errors, or logs;
- use exact lifecycle contracts for renew, inspect, revoke, close, and execution start;
- pin contract digests and run cross-repository fixtures in CI.

Runmill may map canonical wire values into internal types after validation. It may not drop an authority coordinate or treat a missing field as a default.

### 9.2 Work Order v2

ASF and Runmill must jointly define `asf.work-order/v2` and its signed envelope. Runmill should dual-read v1 for existing local fixtures and accept v2 for production. It must never reinterpret or re-sign an already signed envelope.

V2 must bind at least:

- complete source system, external ID, immutable snapshot reference/digest, and source timestamp;
- repository, base ref, exact base SHA, and repository-policy digest;
- objective, acceptance criteria, non-goals, and optional planner artifact digest;
- allowed/forbidden paths, risk class, risk reasons, and matched rule IDs;
- required local checks, CI contexts, review policy, and verification policy digest;
- explicit command/tool policy digest rather than an ambiguous label;
- implementer/local-reviewer/PR-reviewer ctxlane profile UIDs and aliases;
- per-role signed ctxlane authorization or a canonical reference included in the signed Work Order;
- sandbox, network, dependency, harness, and runtime policy digests;
- wall time, cost, invocation, fix/review, artifact, and external-effect budgets;
- PR-only delivery authority;
- tenant, work item, attempt, idempotency key, validity interval, and signer.

Unknown v2 fields remain refused. Authority changes require a new attempt and new signature.

### 9.3 Control contract

The production control surface must support:

- capability negotiation;
- idempotent submission;
- run lookup by run ID;
- run lookup by Work Order idempotency key plus expected payload/envelope digest;
- event listing with opaque run-bound cursor and compaction metadata;
- evidence manifest and exact signed bundle retrieval;
- cancellation;
- signed approval;
- deterministic reconciliation request;
- outcome acknowledgement;
- health/readiness.

All mutating calls require cryptographic controller authentication and stable idempotency keys. Reads require authenticated authorization for the exact worker/tenant scope.

## 10. Functional requirements

### RM-PROD-001: First-party deployment composition

Ship a supported first-party runtime composition that constructs all required `AsfWorkerHostOptions` from declarative operator configuration.

Proposed operator path:

```text
runmill service doctor --mode asf-worker --config <path> --json
runmill service start --mode asf-worker --config <path>
runmill service status --json
runmill service stop
runmill mcp serve --stdio
```

The existing trusted runtime-module seam may remain for advanced deployments, but the release cannot require users to author executable JavaScript. The current implementation now accepts and validates the declarative document at `service start --config` and binds it to an advanced module handoff; it still does not ship the first-party composition required by this criterion.

The first-party composition must wire:

- state store and migrations;
- Work Order admission/trust roots;
- ctxlane canonical client;
- protected lease registry;
- trusted provider harness;
- workspace and bubblewrap sandbox;
- repository tool gateway;
- GitHub adapter and reconciliation observers;
- verification and review pipeline;
- budgets and circuit breakers;
- cancellation and approvals;
- artifact store;
- evidence and terminal-evidence signers;
- private control authentication;
- health/readiness and OTLP.

### RM-PROD-002: Immutable admission and lost-response adoption

Submission remains short-lived and returns immediately.

For an idempotency key:

- identical signed envelope -> same run and `existing` disposition;
- changed payload/envelope digest -> idempotency conflict;
- same Work Order attempt under another key -> conflict;
- expired replay with a previously accepted immutable run -> discoverable through authenticated lookup, without re-authorizing new execution;
- incomplete or invalid signature -> no run and no repository/provider effect.

Add a production control operation that looks up by idempotency key and requires the caller to provide the expected payload and envelope digests. A mismatch must disclose no other run details.

### RM-PROD-003: Canonical ctxlane lifecycle

For each required role:

1. validate the signed role authorization from the Work Order;
2. ensure the durable Runmill ownership fence is current;
3. acquire the exact ctxlane lease;
4. store capabilities only in the protected registry;
5. persist non-secret lease attribution in run state;
6. start the fixed harness through ctxlane;
7. renew before expiry and acknowledge the new generation;
8. revoke on lost Runmill ownership, cancellation, malformed identity, or policy drift;
9. close after the role terminates;
10. prove all leases released before terminal cleanup evidence is signed.

Implementer/fixer resume and reviewer freshness remain separate policies. A reviewer is `independent: true` only when it has fresh context, no writable candidate, no implementer transcript, separately attributed identity/session, and no access to the implementer's protected state. Provider/model diversity may be reported but is not required to use the word independent.

### RM-PROD-004: Trusted harness and credential-free tools

The production provider path uses ctxlane's fixed host-side harness. The coding model's repository actions pass through Runmill's structured tool gateway and bubblewrap sandbox.

Tests must prove the worker/tool environment cannot access:

- provider credentials or provider homes;
- ctxlane service/execution channels;
- ASF control credentials or MCP endpoint;
- GitHub/backlog credentials;
- SSH agent;
- cloud metadata;
- Docker socket;
- another workspace;
- host filesystem outside explicit mounts.

Verification runs with network disabled in a fresh exact-candidate checkout. Tool networking is disabled for the first production release unless a later enforced broker is separately qualified.

### RM-PROD-005: Durable execution and recovery

Every phase transition, ownership generation, provider invocation, budget reservation, effect intent, event, evidence artifact, and cleanup checkpoint is durable before the next irreversible effect.

Recovery must:

- re-adopt exact admitted runs;
- reject two live worker generations;
- reconcile prior ctxlane leases before acquiring replacements;
- inspect remote GitHub state for ambiguous effects;
- resume only from a checkpoint whose exact candidate, policy, repository, identity, budget, and evidence remain valid;
- create a new attempt when authority-bearing inputs changed;
- preserve workspaces on unsafe intermediate failure and remove them only after terminal cleanup proof;
- never turn missing evidence into success.

### RM-PROD-006: Event stream

Run events must remain append-only, gap-aware, and bound to:

- run, Work Order, attempt, worker, and generation;
- sequence and previous event digest;
- policy digest;
- current phase;
- candidate SHA when applicable;
- non-secret evidence references;
- stable stop/escalation reason.

Compaction must preserve a signed or digest-bound snapshot plus the terminal events required to verify evidence. Cursors are opaque, run-bound, and reject cross-run use.

### RM-PROD-007: GitHub effect ownership

Runmill remains the sole owner of attempt-level branch/PR effects.

- Persist intent before push/create/update/observe.
- Bind every effect to Work Order, run, attempt, candidate SHA, repository, and stable marker.
- On response loss, observe before retry.
- Reject candidate-head drift and ambiguous PR collisions.
- Read branch protection and required checks independently.
- Do not merge in the first production release.
- Return exact side-effect receipts in evidence.

### RM-PROD-008: Verification and review

Required checks execute against the exact candidate in a fresh checkout.

The production release must preserve existing refusal behavior for:

- missing or malformed reports;
- zero tests;
- focused tests;
- undeclared skipped/absent tests;
- baseline inventory loss;
- changed verification policy;
- dirty candidate or mutable Git metadata;
- missing or contradictory CI;
- review findings not resolved on the exact candidate.

The Work Order and effective repository policy jointly determine required checks. Repository input may narrow authority but cannot remove controller-required checks.

### RM-PROD-009: Signed attempt evidence

Retain the existing in-toto-style signed evidence and extend it only through a versioned contract when needed.

The successful PR bundle must bind:

- exact Work Order envelope and payload digests/signature;
- effective policy and every input digest;
- base, candidate, remote head, tree, diff, and changed paths;
- runtime/harness/tool/sandbox/dependency digests;
- non-secret ctxlane attribution digest for every role;
- provider/model/principal/profile references permitted by the evidence policy;
- role outcomes;
- local checks and CI contexts at the candidate SHA;
- fresh review verdicts and finding digests;
- confirmed GitHub effects and reconciliation evidence;
- approval evidence where applicable;
- budget reservations, reported costs, and conservative unknown cost;
- artifact manifest;
- completion decision and timestamp.

The terminal cleanup bundle must additionally prove:

- every identity lease released or terminally revoked;
- repository lease released;
- workspace removed or explicitly quarantined;
- no unresolved effect remains;
- budget reservations settled;
- exact terminal event and phase;
- stable stop reason for non-success outcomes.

### RM-PROD-010: Independent evidence verifier

Provide a credential-free verifier that can run without starting Runmill or contacting a model/provider.

Proposed surface:

```text
runmill evidence verify <bundle-or-closure-pack> \
  --trust <public-trust-policy> \
  --artifacts <artifact-root> \
  --json
```

It must verify:

- schema/version and canonical encoding;
- signature and signer policy;
- payload and artifact digests;
- Work Order, policy, run, attempt, worker, identity, candidate, event, and cleanup cross-bindings;
- exact required check/review/CI coverage;
- absence of unknown authority-bearing fields;
- terminal claim consistency.

The verifier may re-run deterministic repository checks when artifacts and source are available. It must describe this as reproducible evidence verification, not replay of the original LLM execution.

### RM-PROD-011: Cancellation, approval, and acknowledgement

- Cancellation persists and fences authority before returning.
- It revokes ctxlane leases, terminates provider sessions, and reconciles remote effects.
- Approval is signed, candidate/policy/effect-bound, expiring, and idempotent.
- Outcome acknowledgement is bound to the exact evidence digest and does not rewrite evidence.
- The worker retains unacknowledged terminal evidence for the configured retention window.

### RM-PROD-012: Health and readiness

Canonical readiness must prove the complete known evaluator output, including:

- exact mode and single-tenant hosting;
- disabled backlog selection/mutation;
- signer trust;
- ctxlane contract version, reachability, authenticated channel, readiness probe, and capacity;
- harness readiness and identity isolation;
- sandbox enforcement and resource limits;
- denial canaries;
- private authenticated control/MCP boundary;
- worker heartbeat/generation/fencing;
- artifact and evidence signing readiness;
- GitHub permissions and reconciliation;
- retention cleanup;
- OTLP exporter health.

The current readiness schema must be versioned when these checks change. A custom partial checklist cannot authorize startup.

### RM-PROD-013: OpenTelemetry and operational metrics

Export correlated traces, metrics, and structured logs using non-secret IDs:

```text
tenant -> work order -> attempt -> run -> role invocation
       -> check/review/effect -> evidence -> acknowledgement
```

Required metrics include:

- run phase duration;
- queue and active-run counts;
- identity acquisition/renewal/refusal;
- provider invocation count and conservative cost;
- check/review/CI outcome;
- effect ambiguity and reconciliation latency;
- stale-fence rejection;
- recovery duration;
- evidence finalization/acknowledgement lag;
- cleanup failures and quarantines.

Prompts, model output, source, credentials, lease capabilities, and protected artifact bytes are off by default and never metric labels.

### RM-PROD-014: Documentation and packaging

- Restore a real `docs/asf-worker.md` operator guide or remove the broken link.
- Document every explicit service/MCP command and environment/config field.
- Ship a sample declarative config with placeholders, never credentials.
- Document service installation, user/systemd ownership, socket paths, log/retention paths, key rotation, backup/restore, and upgrade procedure.
- Preserve standalone quick start and clarify that ASF mode is opt-in.
- Run `npm run package:check` for the final artifact.

## 11. State and terminal outcomes

Runmill's public worker phases must map every stop into a bounded outcome. No process exit or thrown error may be the only record.

At minimum, ASF must be able to distinguish:

- accepted but not started;
- running;
- waiting for approval;
- cancellation requested;
- completed target with evidence pending;
- completed with signed evidence;
- cancelled with cleanup evidence;
- refused before provider work;
- budget exhausted;
- failed/retryable;
- quarantined;
- terminal conflict or remote-effect ambiguity.

Each non-success state names the required actor, action, retry disposition, evidence references, and whether a new signed attempt is required.

## 12. Failure-injection qualification

The test harness must be able to kill or fault the worker at every durable checkpoint, including:

- submission before/after admission commit;
- submission response loss;
- ctxlane acquire before/after lease persistence;
- provider harness spawn and first request;
- provider response before usage/effect persistence;
- workspace checkpoint and candidate commit;
- verification before/after each check receipt;
- review before/after verdict persistence;
- branch push and PR create response loss;
- CI pagination and candidate-head change;
- evidence artifact write and manifest freeze;
- evidence signature before/after persistence;
- acknowledgement response loss;
- cancellation/revocation/cleanup;
- worker heartbeat loss and generation takeover.

The external matrix must additionally include:

- real Runmill process crashes;
- real ctxlane service restart and lease generation changes;
- provider timeout/rate-limit/ambiguous billing;
- GitHub outage, rate limit, stale checks, and ambiguous mutation;
- disk full and filesystem permission loss;
- artifact corruption or disappearance;
- clock rollback/forward jump;
- sandbox denial-canary attempts;
- malicious repository files and prompts attempting privileged MCP or credential access.

## 13. Milestones

### M0: Contract freeze

- ctxlane operation schemas complete.
- `asf.work-order/v2` frozen with ASF.
- lost-submit lookup contract frozen.
- evidence compatibility/deprecation policy frozen.
- cross-repository fixtures run in CI.

### M1: First-party worker composition

- declarative config and operator doctor;
- complete worker dependency construction;
- private authenticated control socket;
- state/artifact/evidence signer lifecycle;
- honest ASF worker documentation.

### M2: Production identity integration

- canonical ctxlane client;
- protected leases and execution sessions;
- credential-free tool gateway;
- three-role lifecycle and cleanup evidence.

### M3: Durable attempt and evidence

- v2 admission;
- lost-response adoption;
- complete events/effects/reconciliation;
- portable verifier;
- OTLP.

### M4: ASF end-to-end path

- ASF submits and adopts one Work Order;
- observes all events;
- retrieves and independently verifies evidence;
- acknowledges outcome;
- cancellation and escalation paths pass.

### M5: External qualification

- protected Linux deployment;
- native provider identities;
- real private repository and GitHub App/token boundary;
- full failure matrix;
- operator runbooks and production sign-off.

## 14. Acceptance criteria

The ASF worker may be called production-ready only when:

1. It starts from a shipped first-party declarative composition; custom executable composition is optional, not required.
2. Standalone Runmill starts and operates without ASF or ctxlane configuration.
3. Work Order v2 is strictly validated and signature/authority changes create a new attempt.
4. Identical submissions converge and lost successful submission responses are recoverable by idempotency key plus exact digest.
5. Runmill consumes ctxlane's exact schemas and passes cross-repository compatibility tests.
6. Every required role uses an explicit ctxlane profile UID/alias and signed authorization; no active/default profile fallback exists.
7. Provider credentials, ctxlane channels, GitHub/ASF credentials, and other protected resources are denied to workers/tools in live Linux tests.
8. A stale worker or lease generation cannot make another provider or GitHub effect.
9. Required checks and reviews are bound to the exact candidate SHA and contradictory evidence fails closed.
10. Push/PR response loss produces one reconciled logical effect and no duplicate PR.
11. Every terminal run has signed attempt evidence where a candidate exists and signed post-cleanup evidence.
12. The independent verifier validates 100% of accepted bundles and rejects every single-field tamper case.
13. Crash injection at every checkpoint produces a safely resumed run, a new-attempt requirement, or an owned attention state—never an orphan.
14. Cancellation revokes identity authority and does not release ownership before exact terminal cleanup evidence.
15. Health/readiness fails when any required identity, sandbox, GitHub, artifact, signer, state, retention, or telemetry gate is unavailable.
16. One real ASF-controlled private-repository run reaches a verified PR, acknowledgement, and complete cleanup.

## 15. Success metrics

Release qualification targets:

- duplicate Work Order run after exact retry: **0**;
- duplicate branch/PR effect after response loss: **0**;
- stale worker effect accepted: **0**;
- credential or privileged control endpoint visible to worker/tool: **0**;
- exact-candidate evidence mismatch accepted: **0**;
- independently unverifiable accepted bundle: **0**;
- crash point ending without resumable or owned state: **0**;
- identity lease left active after terminal cleanup: **0**;
- unsupported merge/deploy effect attempted: **0**.

Operational product metrics:

- verified-PR rate;
- human-intervention rate;
- time and conservative cost to verified PR;
- escalation rate by stable reason;
- effect-reconciliation rate and duration;
- recovery success and duration;
- evidence acknowledgement lag;
- review/fix iteration distribution.

## 16. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Runmill becomes a second ASF | Keep scope to one attempt; ASF owns acceptance, retries across attempts, source closure, and final accountability |
| Identity wire drift | ctxlane owns schemas; remove invented shapes; pin digests and cross-test fixtures |
| First-party composition becomes insecure convenience code | Apply the same strict readiness and path/key checks as the current module seam; fail closed |
| “Independent review” is overstated | Require fresh isolated context/session and immutable candidate; report provider/model separation rather than implying it |
| Evidence is called replayable | Provide deterministic evidence verification and optional check reproduction; do not promise LLM replay |
| Local success hides Linux deployment gaps | Gate production status on the external Linux matrix and denial canaries |
| Generic factory feature pressure expands scope | PR closure only until this release is qualified on real repositories |

## 17. Release language

Before acceptance:

> Runmill provides a developer-preview delivery loop and production-oriented ASF worker foundations. The integrated ASF worker path is not yet production-qualified.

After acceptance:

> Runmill is the durable PR-delivery runtime for ASF: it turns one signed Work Order into a verified pull request or an owned stop, with fenced identity, exact-commit evidence, and crash recovery on qualified Linux deployments.

## 18. Cross-project delivery order

1. ctxlane publishes the complete canonical operation schemas and private authority-bearing
   lifecycle channel (the public parameter/view schemas are already vendored and cross-tested).
2. ASF and Runmill freeze Work Order v2 and lost-submit lookup.
3. Runmill replaces the current ctxlane wire client.
4. Runmill ships the first-party worker composition and denial-proof harness.
5. ASF wires submission, lookup/adoption, event observation, evidence retrieval, and acknowledgement.
6. Runmill ships the independent verifier.
7. All three projects run the shared failure matrix and one real PR-only qualification.

Runmill can release improvements to its standalone product independently, but it must not label the ASF worker production-ready before the coordinated gates pass.
