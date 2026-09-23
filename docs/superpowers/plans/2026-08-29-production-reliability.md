# Runmill production-reliability implementation plan

## Goal

Harden every Runmill workflow we currently support, and add the one piece of new scope that was explicitly asked for: sandbox portability, meaning Docker plus local sandbox execution on macOS, Linux, and Windows. A platform counts as supported only when its public containment primitive can meet the same fail-closed contract. If the primitive is missing or not good enough, report `unsupported`. Don't fall back silently and don't claim best-effort isolation. Keep public commands, exit codes, JSON fields, forward-only state migrations, and the separate standalone and ASF state machines as they are. Agents and adapters still return observations or proposals, and only the orchestrator authorizes external side effects.

## Global constraints

- Use Node 22 or 24 and Git with `--no-lazy-fetch` support (upstream 2.45 or newer). Every behavior change follows strict red-green-refactor TDD, and each task report records the red and green commands.
- Run `npm run check` before completion. Run `npm run package:check` after changing package metadata, build output, the CLI entrypoint, or bundled fixtures. Run `npm run docs:errors` after changing the error catalog.
- Missing, unknown, stale, contradictory, or ambiguous evidence fails closed.
- Verification and review evidence stays bound to the exact candidate commit.
- Fakes are at least as restrictive as production adapters.
- Time-dependent code uses injected clocks/schedulers; process execution uses `src/platform/process.ts`.
- Repository-controlled inputs may narrow operator authority, never widen it.
- Governance changes include negative/refusal coverage. Sandbox tests exercise real Seatbelt on macOS as a filesystem/process-policy regression harness, bubblewrap on Linux and Windows/WSL2, Docker, and any qualified macOS VM mechanism, and prove a planted resource is accessible outside and denied inside. Seatbelt alone never counts as lifecycle containment: a child can create a new session and outlive both its original process group and `launchctl bootout`.
- Sandbox qualification records the exact backend/runtime identity and policy digest, but startup recomputes and revalidates them anyway. A previous doctor pass is diagnostic evidence. It never carries authority forward.
- Do not implement unrelated roadmap items: automatic run resumption, new agent roles, provider credential brokering, network proxies, merge queues, first-party ASF composition, or provider session resumption.
- Keep patches scoped. Never publish, release, merge, push, or change external repository settings.

## Task 1: Bind review guidance to the candidate repository

Replace host-path review-guidance reads with exact base-commit Git blob reads.

- Validate configured paths as normalized, non-empty repository-relative POSIX paths. Reject absolute paths, `.`/`..` segments, NULs, backslashes, and invalid targets.
- At execution, read the object from `workspace.baseCommit`, require a regular blob, and cap it at 64 KiB. Never resolve or open the repository-controlled pathname on the host.
- Preserve normal committed-guidance behavior and prompt fencing.
- Add refusal tests for absolute/traversal paths, intermediate/final symlinks, special files, oversized content, and a planted host secret. Assert no provider call and no secret in output.

## Task 2: Establish one fail-closed sandbox boundary

Introduce a single internal sandbox-backend contract, wire the selected sandbox instance into provider and verification execution, and stop native profiles from exposing the ambient filesystem.

- Replace the shared host-path `wrap()` assumption with lifecycle-owning `start()`/`run()` operations. The contract carries an explicit host-to-guest path layout, bounded streaming output, an awaited idempotent abort, and completion only after the entire backend-owned process tree/resource is gone.
- Stop granting every ambient `PATH` directory, package roots, `/opt`, and `/Library`.
- Resolve a minimal read-only runtime closure from the exact executable, bounded shebang/interpreter chain, dynamic loader/libraries, explicitly supported subprocesses, required system runtime locations, and prepared dependency checkout. Sanitize child `PATH`, restrict Seatbelt `process-exec`, and bind executable identity/digests to qualification.
- Never inspect an untrusted/repository executable with host-side `ldd` or another mechanism that may execute it. Pin and qualify the native sandbox launcher itself; ambient `PATH` cannot supply `bwrap`, a provider discovery binary, or another trusted transport.
- Reject root, home, workspace ancestors, credential ancestors, and other over-broad grants. Make doctor refuse when the closure cannot be proven.
- Normalize host sources and guest destinations once; reject duplicate, overlapping, conflicting, or over-broad mounts. Make dependency preparation and disposable provider-home creation explicit backend operations keyed to the target runtime OS/architecture/libc/Node ABI rather than the host runtime.
- Create orchestrator-owned task/issue/runtime inputs with no-follow containment checks; repository symlinks or special files must never redirect a host write. Verification accepts only an exact `exited`/zero result, and real provider/npm tool-child startup must be proven through the production call paths.
- Keep backend selection explicit and deterministic: `native`, `docker`, or `none`; never fall back between mechanisms. `native` may select bubblewrap on Linux only after the exact descriptor-bound runtime and lifecycle qualification below passes; the current fail-closed checkpoint refuses Linux, macOS, and Windows. Tasks 12a and 13 own the additional macOS and Windows transports. Pure Seatbelt stays only as an internal regression harness. Process groups and launchd jobs do not contain a descendant that calls `setsid()`, so Seatbelt cannot provide backend-owned teardown.
- Qualify a rootless, non-setuid bubblewrap with FD-bind support. Hold no-follow descriptors for every runtime and policy mount, pass them through the sole process boundary, and render `--ro-bind-fd`/`--bind-fd`; never reopen a qualified source pathname at launch or fall back to path binds. Preserve original guest aliases for shebangs, ELF `PT_INTERP`, libraries, and runtime data even when their canonical host sources differ.
- Build a deterministic, bounded immutable runtime manifest from descriptor-anchored traversal. Bind every executed/package/library and required DNS, TLS, NSS, hosts, and timezone input to its exact content evidence; enforce aggregate ELF/file/edge/byte limits and fail closed on unsupported loader, libc, symlink, encoding, or mount semantics.
- For bubblewrap lifecycle ownership, create a dedicated `--sync-fd` pipe and require direct monitor completion, PID-namespace-init EOF after it has reaped all children, and bounded output drain before returning, deleting runtime state, or releasing credentials/workspaces. Timeout, abort, and output-limit paths use the same proof; missing acknowledgement quarantines resources and never becomes success.
- Resolve and qualify exactly one configured backend at the composition root and inject it into provider, verification, doctor, evaluation, and orchestrator paths. Remove production constructor defaults that can select an ambient mechanism independently.
- Add actual macOS Seatbelt and Linux bubblewrap planted-secret tests under prior broad roots and PATH/package siblings while retaining provider/npm startup tests. Keep them explicitly pending while their harness cannot clean up safely. The Seatbelt tests prove its access policy and separately prove why production selection refuses it; they do not qualify it as a lifecycle-owning backend. Linux activation also requires real glibc and musl, Node shebang/package/native-dependency, DNS/TLS/hosts/timezone, source-swap, invalid-name/FIFO/symlink, normal-exit descendant, timeout, abort, output-limit, and `--sync-fd` ordering tests.

## Task 3: Make provider and process completion fail closed

Unify the provider and process lifecycle and remove the paths that report false success.

- Reuse `runControlledProcess` for provider, Git, signing, verification, and credential-helper execution where practical. Make termination asynchronous, backend-extensible, and confirmed. Killing a transport CLI by itself is not completion. Detached process-tree/container/guest termination must finish before credentials, leases, or workspaces are released.
- Defaults: local commands 2 minutes, remote observations 30 seconds per attempt, remote mutations 5 minutes; all are bounded by the remaining run/lease deadline with a 5-second safety margin.
- A provider result succeeds only with one start event, exactly one successful terminal event, and exit code zero. Pre-abort never spawns. Cancellation, timeout, output-limit, failure terminal, missing terminal, duplicate terminal, or contradictory terminal fails closed in that order.
- Every role, local review included, needs a successful process status before its output is accepted. Otherwise discard the output.
- Stream through a bounded async queue. Limits: 16 MiB aggregate output, 1 MiB line, 10,000 retained events, 1 MiB structured review file. Accept only regular no-follow output files.
- Test failure-terminal/exit-zero, missing/duplicate/conflicting terminal, pre-abort, TERM trapping, delayed grandchildren, stale approval files, and all output limits.

## Task 4: Make garbage collection non-destructive

- Export and reuse one clean-exit predicate containing only `COMPLETED` and `PR_DELIVERED`.
- Perform an exact store lookup for every discovered directory; do not infer orphan status from a limited recent-run page.
- Resolve an exact primary workspace name before recognizing only a strict trailing `-verify-<12 lowercase hex>` child. Ambiguous, malformed, missing-record, unavailable-store, or future-state directories remain preserved.
- Preserve and report missing, unknown, active, aborted, quarantined, approval, and human-attention states.
- Remove source-repository `git worktree prune` from dry-run and real GC and remove the unused workspace prune path. Preserve the existing JSON field as `worktreePruned: false`.
- Open existing state read-only for classification: GC must never create or migrate a database; an absent/incompatible store preserves all directories. Exhaustively test every run state, ambiguous and unknown directories, a run older than 1,000 newer records, source worktree metadata, and dry-run filesystem/Git/database immutability.

## Task 5: Make terminal state, leases, and effects authoritative

- Before run creation, propagate failures instead of manufacturing an outcome for a nonexistent run. After creation, require terminal CAS persistence before returning a terminal outcome or recording accounting/log completion; terminal write failure is never converted into a second terminal state.
- Add a forward migration for lease phases `acquiring`, `held`, `releasing`, and `released`, including immutable run/repo/generation/ref/object identity, expected/intended/observed object, timestamps, and pending intent. Migrate legacy active rows to unresolved `acquiring`, never assumed `held`.
- Persist acquisition/release intent before remote mutation and confirm only after exact remote observation. Retain ambiguous rows for manual reconciliation; do not add automatic run resumption.
- Reconcile exact refs as absent, exact intended object, or contradictory/fenced object.
- Replace unconditional outbox reopening with transactional `beginEffect` outcomes `new`, `pending`, or `confirmed`; only `new` authorizes execution, pending/confirmed rows remain unchanged, binding contradictions refuse, and every legal transition requires exactly one affected row.
- Journal or replace the write-capability probe that currently performs a no-op remote mutation. Add terminal-write failure tests, full acquisition/release crash matrices, concurrent duplicate-effect tests, and lost-response tests for push/PR/mark-ready/merge.

## Task 6: Persist and revalidate standalone workflow evidence

- Atomically persist base/branch/candidate commits, workspace lifecycle, every verification attempt, review verdict/output digest/findings, PR identity/head/base/merge SHA, issue snapshot, policy decisions, transition reason/actor, and terminal reason.
- Add only the missing standalone `reviews` table; reuse existing evidence tables and run-lineage columns. Let StateStore transactionally allocate event, policy, and check-attempt sequences and require check/review candidate SHA to equal the current persisted candidate.
- Extend `inspect` additively with checks, reviews, findings, pullRequest, workspace, policyDecisions, and transition reason/actor. Make `policy explain` derive from persisted evidence and return unknown when absent.
- Persist a canonical full issue snapshot and full SHA-256 authority fingerprint. Re-observe immediately before first push and before merge/completion, rerun the same eligibility/repository resolution, and persist the decision. Material changes, missing/ambiguous observations, unexpected state/assignee changes, cancellation, completion, ineligibility, or retargeting go to `NEEDS_HUMAN` before mutation; exclude only the exact confirmed Runmill-owned claim state/assignee delta.
- Test database reopen at every stage/retry, exact-candidate binding, failed/retried checks, approval with no findings, documented jq commands, and issue mutations at implementation/CI/review stages.

## Task 7: Standardize adapter deadlines, retry classification, and daemon recovery

- Introduce one internal remote-operation context with cancellation, absolute deadline, injected clock/scheduler/jitter, and observation-vs-mutation identity for backlog/forge APIs.
- Classify authentication, authorization/policy, rate limit/retry-after, proven-not-started timeout/transport, conflict/not-found/invalid, and ambiguous mutation failures.
- Make at most three total observation attempts with full jitter, 250 ms base and 5-second cap, respecting Retry-After only within the deadline and abortable injected scheduling. Authentication/policy/invalid/contradictory results do not retry. Never retry a dispatched mutation; only proven pre-dispatch failure is not-started, while transport/timeout/5xx after dispatch is ambiguous and requires exact reconciliation or remains pending.
- Paginate GitHub check-runs and statuses to a combined explicit 1,000-check bound, validate page identity, and preserve 404/403/429/5xx meaning instead of collapsing it to absence.
- Keep daemon service alive after isolated exhausted transient observations and persist a restart-safe cooldown/backoff without fabricating a run outcome. Authentication/policy fail immediately; contradictions remain quarantined.
- Test hangs, 429, 502, abort during backoff, >100 checks, lost responses, and daemon/breaker recovery using injected time.

## Task 8: Make budgets and standalone ownership crash-safe

- Durably reserve provider invocations by `(runId, logical budget role, attempt)` in an immediate transaction before spawn and settle idempotently afterward. A duplicate reservation never respawns; outstanding usage counts toward invocation limits and blocks cost-capped dispatch until positively reconciled.
- Validate safe non-negative integer tokens, finite non-negative cost, and monotonic cumulative usage in production and fakes. Unsettled restart usage counts the invocation and blocks further cost-capped dispatch pending reconciliation.
- After Task 5's terminal CAS, derive durable usage and transactionally/idempotently settle run-keyed accounting, daily ledger, and breakers before returning/logging the outcome. Startup repairs terminal runs missing this marker; contradictory duplicate settlement is corruption.
- Add an atomically created mode-0600 regular data-directory owner record containing canonical data directory, PID, cross-platform process-start identity, nonce, command, and acquisition time. Foreground run/daemon hold it; detached startup performs an explicit parent-to-child handoff; readers use read-only state; mutating commands refuse.
- Normal acquisition never steals. Only GC may remove a stale owner after a fail-closed identity result proves that exact PID/start identity absent or different, then atomically acquire ownership itself; unknown, malformed, symlinked, or raced records remain preserved.
- Replace date-derived run IDs with `run_`-prefixed cryptographic UUIDs.
- Test the provider/accounting crash matrix, malformed usage, concurrent foreground processes, daemon/foreground conflict, PID reuse, SIGKILL stale ownership, and same-millisecond ID uniqueness.

## Task 9: Stabilize CLI and release artifact contracts

- Route all 42 CLI leaves, program construction, Commander parsing, configuration, and synchronous/asynchronous action failures through one root-aware error boundary. JSON mode emits exactly one existing `RunmillError.toJSON()` object on stdout and no stderr; success payloads and exit codes 0/1/2/3 remain unchanged. Successful `mcp serve --stdio` remains a stream, while its startup failures use the boundary.
- Build and pack once with scripts disabled, retain the tarball, hash SHA-512, install/smoke-test that exact path, and publish only that same `.tgz` with scripts disabled. The smoke step accepts an artifact and never packs; post-smoke `dist` changes cannot affect publication.
- Verify a release tag is annotated and has a valid signature by an exact maintained release-key fingerprint, matches the package version, and points to a commit on freshly fetched protected-main ancestry before constructing the artifact.
- Add package OS metadata for Darwin/Linux/Windows, keep engines `>=22`, qualify Node 22/24, and smoke-test the same artifact contract on all three operating systems including Windows bin shims. Make `--no-color` and non-empty `NO_COLOR` override all styling; JSON never contains ANSI.
- Test every CLI leaf in text/JSON mode and prove post-smoke `dist` mutation cannot change the publish artifact. Run package checks.

## Task 10: Bound ASF shutdown and observability

- Add injected `shutdownGraceMs` defaulting to 30 seconds. Atomically stop intake, heartbeats, retries, delayed work, and new admission; await cooperative grace, then set the local lease-lost fence before exact-generation owner release, abort, and local-slot release. Preserve phase/checkpoint/pending-effect state for takeover; do not invent a durable lease-lost transition.
- Require Task 3's bounded generation-keyed transport/process termination confirmation. Delay identity/credential/provider-home/workspace cleanup until cooperative completion or that confirmation; unknown confirmation preserves protected resources and fails shutdown.
- Emit bounded redacted structured records correlated by run/work-order, session, role, attempt, stage, effect key, candidate SHA, outcome, duration, retry class, and sequence. Carry existing ASF trace context end-to-end.
- Expose only closed-enum, low-cardinality run/retry/timeout/pending-effect/breaker/queue/lease-loss counters through existing snapshots/telemetry; identifiers stay in bounded records/spans. Add no network exporter. Use per-sink FIFO capacity 1,024 with drop-newest counters; rotate no-follow regular JSONL logs before 10 MiB, retaining five mode-0600 files and rejecting records above 64 KiB.
- Test non-cooperative shutdown/takeover, late-event fencing, streaming order/correlation, secret redaction, cardinality, exporter failure, and rotation.

## Task 11: Tighten fakes and remove misleading/dead behavior

- Make fake forge push failures and usage validation match production: a not-started push mutates nothing, while applied-then-lost-response remains an explicit ambiguous mode. Add refusal tests.
- Make `next` consult active leases.
- Advertise provider session resume as unsupported for every production/fake dialect and refuse without spawning; do not implement it.
- Remove only execution branches proven unreachable after the existing `git_isolation: clone` refusal, plus trivial duplicate branches. Preserve public types, verification-worktree behavior, reconciliation schemas/protocols, and database compatibility; defer removal of the unconstructed reconciliation coordinator until the final characterization/split.
- Fix documentation mismatches for breaker persistence, inspect evidence, release artifacts, limitations, exit codes, and remediation commands. Run error-doc generation when applicable.

## Task 12: Add the explicit Docker sandbox backend

- Accept `workspace.sandbox: docker` only with an operator-configured canonical `name@sha256:<64 lowercase hex>` image reference, explicit nonzero numeric `uid:gid`, and bounded resources. Refuse tags, tag-plus-digest forms, missing local images, root users, automatic pulls, remote daemon contexts, and unqualified daemons.
- Qualify a local Linux daemon endpoint, inspect the locally present manifest/config and OS/architecture, capture the resolved image/config ID, and create by that immutable ID with pull disabled. Prove host-bind identity with a canary so Docker Desktop/local-VM mappings cannot silently target another filesystem.
- Use create → inspect → start/attach → kill/wait/remove, not opaque `docker run`. Before start, inspect the actual image, user, mounts, namespaces, network, restart policy, read-only root, limits, capabilities, security options, devices, and socket absence; validate the daemon-issued container ID before every lifecycle action.
- Execute provider and verification processes through the shared sandbox contract. Use a read-only root filesystem, explicit non-root user, tmpfs `/home/runmill` and `/tmp`, all capabilities dropped, `no-new-privileges`, default seccomp, private PID/IPC/cgroup namespaces, PID/CPU/memory bounds, no devices or Docker socket, restart disabled, and `--network none` whenever network is disallowed.
- Mount allowlisted authentication read-only at a staging path and use a fixed trusted image helper to copy it into tmpfs home before execution. Bind only normalized workspace, pre-created output, and target-runtime dependency sources at stable guest paths; re-mount `.git`, immutable `.runmill/run` inputs, dependency trees, and every protected subtree read-only after any broader workspace bind.
- Key dependency preparation and provider/verifier qualification to the container runtime OS/architecture/libc/Node ABI. Rewrite every cwd, home, temp, task-packet, provider `-C`, dependency, and output argument to its declared guest path; refuse an untranslatable path.
- Persist/emit the backend ID, manifest digest, resolved image/config ID, policy digest, runtime limits, and qualification outcome. Doctor and run startup both revalidate; failure never falls back to native or unsandboxed execution.
- Add argument/inspection-contract tests plus real Docker planted-secret, protected-path, network-denial, process-tree cancellation, provider-startup, and verification-startup tests using a preloaded checksum-verified, digest-pinned fixture image. The backend and its security tests always run with pull-never semantics.

## Task 12a: Add the qualified local macOS sandbox backend

- Implement `native` on macOS 26/Apple silicon through Apple's per-container Linux VM runtime, never through Seatbelt/process groups alone. Older macOS and Intel hosts report `unsupported`; selection never falls back to Docker or host execution.
- Require an operator-configured digest-pinned OCI workload image, numeric non-root user, bounded resources, and a pinned/signed helper/runtime protocol. Resolve workload images with a local-only content lookup, not the stock `container create` fetch path. The helper uses Apple's persistent per-user API service so controller failure leaves a durably addressed VM for recovery rather than an orphaned direct-`Virtualization.framework` process.
- Reserve a cryptographically random container UUID durably before creation, never reuse it, and bind it to run/candidate/nonce labels plus the expected image/config/policy digests. Revalidate the complete snapshot before every lifecycle operation. Same-UID manual runtime interference is outside the repository/agent boundary; contradictory or missing identity is nevertheless a refusal, never authority to affect another object.
- Use create → full inspect → start/attach/wait → stop/kill → delete. Completion requires the workload exit status, guest-wide process termination, init exit, unmount, and awaited VM stop/delete. A lost attach makes the result unknown and fail-closed; it is never reconstructed as success from container absence.
- Require `--network none`/no DNS when networking is denied, a read-only root, explicit read-only/writable mounts, tmpfs home/temp, all capabilities dropped, no SSH/socket/port/virtualization forwarding, numeric uid/gid, CPU/memory/PID/rlimit bounds, and an exact trusted init/runtime/kernel identity. Apply the same auth-staging, guest-path rewrite, protected-subtree, target-runtime dependency, and canary rules as Docker.
- Do not qualify a stock Apple runtime whose VM-init image can disappear after preflight and be auto-fetched. The backend may become executable only when the exact pinned public API/service supports a local-only VM-init lookup, or when the shipped signed helper/service closes that path without owning a second VM runtime. Until then, code/config/doctor must emit a precise `unsupported` result rather than weakening the no-auto-pull contract.
- Add typed helper protocol/argument/inspection tests and a real trusted-host qualification suite covering local-only image/init resolution, planted host-secret denial, protected mounts, raw-IP network denial, detached/session descendant teardown on every terminal path, controller-crash recovery, never-reused identity, provider startup, and verification startup. Emit exact helper, Apple CLI/API service, Containerization, kernel, init image, workload image, and policy identities.

## Task 13: Add the local Windows sandbox backend

- Implement `native` on Windows through an explicitly configured, dedicated WSL2 distribution/non-root user and the same bubblewrap policy model used on Linux. Never select the ambient default distribution and never fall back to Docker, another distribution, or an unsandboxed Windows process.
- Require the distro to have `[interop] enabled=false` and `appendWindowsPath=false`. Qualification proves Windows PATH entries, `WSLENV`, `WSL_INTEROP`, `/init`, interop sockets, unapproved `/mnt/*`, and Windows executable launch are unavailable inside the sandbox; do not toggle distro-global interop state per run.
- Support only canonical existing paths on approved local fixed volumes. Reject UNC, `SUBST`, relative, missing, and reparse/junction/symlink-ancestor paths. Resolve Windows final path/file identity, translate using `wslpath` inside the exact distro, Linux-`realpath` it, reverse-translate/canonicalize it, compare identities where available, and prove both views with a same-file canary; refuse any ambiguity.
- Translate approved host sources to stable guest destinations and rewrite every cwd, home, temp, task-packet, provider `-C`, dependency, and output path. Expose no original Windows mount roots inside bubblewrap. Keep the orchestrator and policy decision on the Windows host; WSL is only the execution transport.
- Prepare dependencies for the WSL Linux OS/architecture/libc/Node ABI rather than reusing Windows host artifacts. Require Linux provider/verifier binaries and authentication sources in the named distro; a trusted helper creates a private WSL-side disposable home without exposing the real distro home to the sandbox.
- Start each invocation under a trusted Linux-side supervisor/process group (or cgroup) identified by an unguessable token plus PID/start identity. Cancellation uses an out-of-band command to the exact distro, then confirms `/proc` disappearance before cleanup; never terminate a shared distro to kill one invocation.
- Qualify WSL2 version, distro/user identity, interop settings, bubblewrap/user namespaces, path proofs, runtime closure, provider/verifier availability, and process-tree termination before use.
- Add Windows unit/contract tests and real qualification tests whose positive control reads a planted Windows-host resource from the same distro outside bubblewrap and whose sandboxed read is denied. Also prove permitted workspace I/O, protected Git/provider paths, network denial, guest-path rewriting, and TERM-trapping descendant cleanup.
- Run portable Windows config/package tests on hosted runners. Run real integration qualification only on ephemeral, credential-free, WSL2-capable trusted-branch runners with a provisioned named distro; `unsupported` or skipped qualification cannot satisfy a claimed Windows release gate.

## Task 14: Characterize, simplify, and complete quality gates

- After Tasks 5/6/8/10/12/12a/13 land, freeze public surfaces and add characterization tests; then split StateStore behind its existing facade into standalone journal, ASF admission/ownership, effects/budget, and evidence modules sharing exactly one database/transaction boundary. The source-only split adds no migration or exported repository abstraction.
- Split AsfDeliveryRunner incrementally into recovery, implementation, review, delivery, and terminal stage handlers with immutable contexts, retaining one central state-machine switch and unchanged public exports/interface.
- Remove the CLI coverage exclusion after Task 9's all-leaf goldens. Add exact-file critical-module thresholds of 90% lines and 85% branches where mechanically supported rather than global per-file thresholds; retain separate real sandbox mechanism gates for host-specific transports.
- Add a contributor-only environment preflight for Node 22/24 and npm major 11 (matching CI) without restricting installed consumers or running from package install hooks.
- Upgrade dependencies one major family at a time only when contract, offline, package, and optional live qualification tests demonstrate compatibility. Do not batch unrelated majors.
- Separate portable unit/package jobs from required real mechanism jobs for the Seatbelt regression harness, Linux bubblewrap, Docker, qualified Apple per-container VM, and Windows WSL2/bubblewrap. Emit a machine-readable exact-commit artifact containing backend/runtime/config identity, policy digest, probe results, and `qualified|refused|unsupported`; only `qualified` satisfies a claimed release target.
- Finish with full checks, package checks, migration upgrade coverage, JSON/exit golden tests, real sandbox qualification on every claimed backend/platform, and a whole-branch senior review.
