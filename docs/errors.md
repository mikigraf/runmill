# Error reference

Every runmill error carries a stable code, what happened, why, and how to fix it.
This page is generated from the catalog in `src/errors/runmill-error.ts` —
edit that, then run `npm run docs:errors`.

| Code | Title | Recoverable |
|---|---|---|
| [`RM-WO-001`](#rm-wo-001) | Work Order schema version is unsupported | no |
| [`RM-WO-002`](#rm-wo-002) | Work Order is invalid | no |
| [`RM-WO-003`](#rm-wo-003) | Work Order idempotency conflict | no |
| [`RM-WO-004`](#rm-wo-004) | Work Order base commit is stale or unproven | no |
| [`RM-WO-005`](#rm-wo-005) | Work Order exceeds effective authority | no |
| [`RM-WO-006`](#rm-wo-006) | Work Order closure target is unsupported | no |
| [`RM-APPROVAL-001`](#rm-approval-001) | Approval schema version is unsupported | no |
| [`RM-APPROVAL-002`](#rm-approval-002) | Approval is malformed, unsigned, or stale | no |
| [`RM-APPROVAL-003`](#rm-approval-003) | Approval does not bind the current candidate | no |
| [`RM-APPROVAL-004`](#rm-approval-004) | Approval signer lacks authority | no |
| [`RM-CANCEL-001`](#rm-cancel-001) | Cancellation request is invalid or conflicting | no |
| [`RM-RECON-001`](#rm-recon-001) | Reconciliation request is invalid or unresolved | yes |
| [`RM-EVID-008`](#rm-evid-008) | ASF evidence binding is invalid | no |
| [`RM-SELECT-002`](#rm-select-002) | Issue does not map to a repository | no |
| [`RM-SELECT-003`](#rm-select-003) | Issue is too underspecified to build a task packet | no |
| [`RM-BACKLOG-003`](#rm-backlog-003) | Backlog discovery is incomplete | no |
| [`RM-AUTH-003`](#rm-auth-003) | Required credential unavailable | yes |
| [`RM-SANDBOX-001`](#rm-sandbox-001) | Sandbox isolation unavailable | no |
| [`RM-SANDBOX-002`](#rm-sandbox-002) | Sandbox escape probe succeeded | no |
| [`RM-LEASE-001`](#rm-lease-001) | Lease lost or fencing generation stale | no |
| [`RM-LEASE-002`](#rm-lease-002) | Could not acquire lease | yes |
| [`RM-VERIFY-001`](#rm-verify-001) | Required check is missing | yes |
| [`RM-VERIFY-002`](#rm-verify-002) | Check ran against a different tree | yes |
| [`RM-VERIFY-003`](#rm-verify-003) | Test inventory unproven or changed | yes |
| [`RM-VERIFY-004`](#rm-verify-004) | Check manifest is invalid | no |
| [`RM-VERIFY-005`](#rm-verify-005) | Verification dependencies are not trusted | yes |
| [`RM-EVAL-001`](#rm-eval-001) | Evaluation suite is invalid | no |
| [`RM-CI-002`](#rm-ci-002) | Required check never reported | yes |
| [`RM-CI-003`](#rm-ci-003) | Merge queue check name does not match | yes |
| [`RM-PROVIDER-001`](#rm-provider-001) | Unknown provider event shape | no |
| [`RM-PROVIDER-002`](#rm-provider-002) | Provider budget exhausted | yes |
| [`RM-REVIEW-001`](#rm-review-001) | Review output did not match the schema | yes |
| [`RM-REVIEW-004`](#rm-review-004) | Review needs a human decision | yes |
| [`RM-CONFIG-001`](#rm-config-001) | Configuration is invalid | no |
| [`RM-CONFIG-002`](#rm-config-002) | Referenced file does not exist | no |
| [`RM-CONFIG-003`](#rm-config-003) | No configuration file | no |
| [`RM-WORKSPACE-003`](#rm-workspace-003) | Repository identity does not match | no |
| [`RM-WORKSPACE-004`](#rm-workspace-004) | Candidate commit provenance is unavailable | no |
| [`RM-STATE-001`](#rm-state-001) | State database schema is newer than this binary | no |
| [`RM-STATE-002`](#rm-state-002) | External effect outcome is unresolved | yes |
| [`RM-STATE-003`](#rm-state-003) | State database migration could not be completed safely | no |

## RM-WO-001

**Work Order schema version is unsupported**

Runmill must understand every authority-bearing field before it creates a run. Guessing at an unknown schema could omit a restriction or reinterpret delivery authority.

**Fix (pick one)**

- Submit an asf.work-order-envelope/v1 containing an asf.work-order/v1 payload
- Upgrade Runmill only after the newer schema has been reviewed and supported

Not recoverable: the run stops.

## RM-WO-002

**Work Order is invalid**

Origin, freshness, repository identity, and policy lineage must all be proven before a signed request can create durable work or exercise authority.

**Fix (pick one)**

- Correct and re-sign the Work Order with a trusted ASF signing key
- Submit a new Work Order if its admission window has expired

Not recoverable: the run stops.

## RM-WO-003

**Work Order idempotency conflict**

An idempotency key permanently names one canonical payload. Rebinding it to different work would make a client retry capable of changing an already accepted attempt.

**Fix (pick one)**

- Retry with the original canonical Work Order payload
- Use a new attempt and idempotency key for changed work

Not recoverable: the run stops.

## RM-WO-004

**Work Order base commit is stale or unproven**

The immutable base must belong to the registered repository and be reachable from its configured base ref before repository policy or candidate evidence can be bound to it.

**Fix (pick one)**

- Issue a new Work Order against a currently reachable base commit
- Restore repository access if the base could not be observed

Not recoverable: the run stops.

## RM-WO-005

**Work Order exceeds effective authority**

Signed requests may narrow local policy but cannot widen operator, repository, or current forge restrictions. Missing or contradictory authority therefore fails closed.

**Fix (pick one)**

- Request only registered identities, checks, paths, runtime profiles, and delivery authority
- Have the appropriate owner change the stricter policy before issuing a new Work Order

Not recoverable: the run stops.

## RM-WO-006

**Work Order closure target is unsupported**

Silently downgrading merge, deploy, or observation work to a pull request would report a different accountable outcome from the one ASF requested.

**Fix (pick one)**

- Request the P0 pull-request closure target
- Wait until the requested delivery adapter and policy are production-qualified

Not recoverable: the run stops.

## RM-APPROVAL-001

**Approval schema version is unsupported**

Approvals carry narrowly scoped authority. Runmill cannot safely interpret an unknown schema version or omit a binding added by a newer producer.

**Fix (pick one)**

- Submit an asf.approval-envelope/v1 containing an asf.approval/v1 payload
- Upgrade Runmill only after the newer approval schema is supported

Not recoverable: the run stops.

## RM-APPROVAL-002

**Approval is malformed, unsigned, or stale**

An approval can authorize an effect only while its EdDSA signature and explicit validity window are current. Missing or unparseable evidence fails closed.

**Fix (pick one)**

- Correct and re-sign the approval with a trusted approval key
- Issue a fresh approval if the previous assertion expired

Not recoverable: the run stops.

## RM-APPROVAL-003

**Approval does not bind the current candidate**

Work Order, attempt, candidate, policy, decision, and effect are all authority-bearing. Changing any one invalidates the prior approval.

**Fix**

- Issue a new approval for the exact current run, candidate, policy, and effect

Not recoverable: the run stops.

## RM-APPROVAL-004

**Approval signer lacks authority**

A valid signature proves origin but does not grant subjects, decisions, or effects beyond the operator-owned signer registration.

**Fix (pick one)**

- Use a current signer registered for the exact approver authority and effect
- Have the platform operator update signer trust outside repository control

Not recoverable: the run stops.

## RM-CANCEL-001

**Cancellation request is invalid or conflicting**

Cancellation fences an active worker and may terminate trusted harness and sandbox processes. Its run, requester, mode, reason, grace policy, and idempotency identity must therefore be explicit and immutable.

**Fix (pick one)**

- Retry the original asf.cancellation-request/v1 unchanged
- Use a new request id for a deliberate forced escalation

Not recoverable: the run stops.

## RM-RECON-001

**Reconciliation request is invalid or unresolved**

Reconciliation may change whether a recorded external effect is safe to retry. Only a durable, authorized request for deterministic observation can make that decision; missing, stale, or contradictory observations fail closed.

**Fix (pick one)**

- Retry the original reconciliation operation id and request unchanged
- Inspect the protected effect evidence if deterministic observation is blocked

Recoverable: the run can continue once resolved.

## RM-EVID-008

**ASF evidence binding is invalid**

Evidence finalization and ASF acknowledgement are authority-bearing claims. They must bind one exact Work Order, attempt, candidate, policy, delivery observation, and immutable signed bundle digest.

**Fix (pick one)**

- Acknowledge the exact bundle digest returned for the terminal run
- Retry the original acknowledgement id and payload unchanged

Not recoverable: the run stops.

## RM-SELECT-002

**Issue does not map to a repository**

Every issue must resolve to exactly one repository, because the lease ref lives in the mapped repository. An unmapped issue has no lease target.

**Fix (pick one)**

- Add a matching rule under github.repositories
- `runmill next --dry-run` — Inspect which rules were tried

Not recoverable: the run stops.

## RM-SELECT-003

**Issue is too underspecified to build a task packet**

The description does not contain enough detail to derive objective and acceptance criteria. Dispatching anyway produces plausible but wrong work.

**Fix (pick one)**

- Add acceptance criteria to the issue
- `runmill prepare <issue>` — See exactly what is missing
- Override deliberately by applying the readiness label

Not recoverable: the run stops.

## RM-BACKLOG-003

**Backlog discovery is incomplete**

Runmill must evaluate the complete bounded candidate set. A missing or non-progressing cursor, malformed pagination metadata, or a result beyond the safety ceiling could hide eligible work and must never be reported as an empty or complete queue.

**Fix (pick one)**

- Reduce the number of issues in the configured eligible workflow states
- Retry after confirming Linear pagination is returning progressing cursors

Not recoverable: the run stops.

## RM-AUTH-003

**Required credential unavailable**

runmill cannot use the configured backlog, forge, or provider when its exact resolved credential is missing, expired, or rejected inside the required boundary.

**Fix (pick one)**

- `runmill doctor` — Inspect every credential source and API probe
- Re-authenticate the failing service

Recoverable: the run can continue once resolved.

## RM-SANDBOX-001

**Sandbox isolation unavailable**

runmill runs the coding agent inside an OS sandbox so it cannot read your SSH keys, cloud credentials, or GitHub token. Without a verified sandbox the isolation guarantees do not hold, so no run starts.

**Fix (pick one)**

- `sudo sysctl -w kernel.unprivileged_userns_clone=1` — Enable unprivileged user namespaces (Linux)
- `runmill doctor --explain sandbox` — Show full sandbox requirements

Not recoverable: the run stops.

## RM-SANDBOX-002

**Sandbox escape probe succeeded**

doctor attempted a forbidden read or write from inside the sandbox and it was permitted. The isolation boundary is not what it claims to be.

**Fix (pick one)**

- `runmill doctor --explain sandbox` — Re-run the probes with detail
- Do not run runmill on this host until the probe passes

Not recoverable: the run stops.

## RM-LEASE-001

**Lease lost or fencing generation stale**

Another run took ownership of this issue. Continuing would race a live worker against the same branch and pull request.

**Fix (pick one)**

- `runmill inspect <run-id>` — Inspect the current owner
- No action needed if the other run is legitimate

Not recoverable: the run stops.

## RM-LEASE-002

**Could not acquire lease**

The lease ref already exists, so another run claimed this issue first.

**Fix**

- `runmill next --dry-run` — Select a different issue

Recoverable: the run can continue once resolved.

## RM-VERIFY-001

**Required check is missing**

A check in the resolved manifest has no runnable command and no remote result. Merge-readiness fails closed rather than assuming coverage.

**Fix (pick one)**

- Add the command to .runmill/checks.yaml
- `runmill policy explain <run-id>` — Show the resolved manifest

Recoverable: the run can continue once resolved.

## RM-VERIFY-002

**Check ran against a different tree**

The worktree changed between the start and end of a check, so the result does not describe the candidate commit and cannot be used as evidence.

**Fix**

- Automatic: the check is re-run against a clean detached worktree

Recoverable: the run can continue once resolved.

## RM-VERIFY-003

**Test inventory unproven or changed**

Runmill could not establish an exact base test inventory, or a test that passed at base is skipped or absent at the candidate without an exact per-check declaration. Counts never identify which test was lost.

**Fix (pick one)**

- Produce valid unique-id reports at base and candidate
- Restore the test, or declare its exact test_id with a cause under this check
- `runmill inspect <run-id>` — See the diff against the baseline inventory

Recoverable: the run can continue once resolved.

## RM-VERIFY-004

**Check manifest is invalid**

The repository declares its required checks in this file. An unreadable manifest must never be treated as 'no checks required', so it fails the run instead of being skipped.

**Fix (pick one)**

- `runmill config validate` — Check the manifest and report every problem at once
- `runmill init` — Write a fresh manifest alongside the existing one

Not recoverable: the run stops.

## RM-VERIFY-005

**Verification dependencies are not trusted**

A clean exact-commit checkout does not contain ignored dependency directories. Runmill only reuses an npm install when package.json, package-lock.json, the installed package inventory, platform, architecture, and Node ABI match the commit being checked.

**Fix (pick one)**

- `npm ci` — Update the source checkout to the configured base and install its exact dependencies
- Start Runmill again so it can prepare a fresh read-only dependency cache

Recoverable: the run can continue once resolved.

## RM-EVAL-001

**Evaluation suite is invalid**

The suite defines what 'working' means for this repository. An unreadable or malformed suite must not be treated as an empty one, because a suite with no tasks trivially passes.

**Fix (pick one)**

- `runmill eval validate <suite>` — Check the suite structure and every task
- Start from the example suite in examples/eval/

Not recoverable: the run stops.

## RM-CI-002

**Required check never reported**

GitHub requires this context but has not scheduled it. Most often a workflow paths: filter does not match this diff, so the context will never report and the pull request can never merge.

**Fix (pick one)**

- Add an always-running companion job that reports success
- `gh api repos/{owner}/{repo}/rulesets` — Inspect branch protection

Recoverable: the run can continue once resolved.

## RM-CI-003

**Merge queue check name does not match**

A required check reports under a different name in the merge_group context than in pull_request, so the queue entry can never be satisfied.

**Fix (pick one)**

- Declare `on: merge_group` and use a context-invariant job name
- `runmill doctor --check github` — Validate workflows

Recoverable: the run can continue once resolved.

## RM-PROVIDER-001

**Unknown provider event shape**

The coding agent emitted an event this adapter version does not recognise. Best-effort parsing could misread a tool call or a result, so the run is quarantined instead.

**Fix (pick one)**

- `runmill doctor --check provider` — Check supported versions
- Pin the provider to a supported version

Not recoverable: the run stops.

## RM-PROVIDER-002

**Provider budget exhausted**

The run reached its turn, time, invocation, or cost ceiling.

**Fix (pick one)**

- Raise the budget in the operator policy
- `runmill inspect <run-id>` — Inspect the stopped run
- Return the issue to an eligible state and start a fresh attempt

Recoverable: the run can continue once resolved.

## RM-REVIEW-001

**Review output did not match the schema**

The reviewer returned something that is not a valid findings document. A malformed review is never treated as a passing review.

**Fix (pick one)**

- Automatic: one repair attempt, then escalation
- `runmill skills validate` — Validate the review skill

Recoverable: the run can continue once resolved.

## RM-REVIEW-004

**Review needs a human decision**

The reviewer found an ambiguity that policy cannot resolve deterministically.

**Fix (pick one)**

- `runmill list --needs-attention` — List what is waiting
- `runmill inspect <run-id>` — Inspect the evidence and named decision
- Return the issue to an eligible state and start a fresh attempt

Recoverable: the run can continue once resolved.

## RM-CONFIG-001

**Configuration is invalid**

The operator policy does not satisfy the published schema, so behavior would be undefined.

**Fix (pick one)**

- `runmill config validate` — Show the specific violations
- Add the schema header for editor validation

Not recoverable: the run stops.

## RM-CONFIG-002

**Referenced file does not exist**

A path in the operator policy points at a file that is not present. This is checked before any agent is dispatched so it cannot fail after spend.

**Fix (pick one)**

- `runmill skills eject` — Write the built-in review skills
- `runmill config validate` — Check which paths are unresolvable

Not recoverable: the run stops.

## RM-CONFIG-003

**No configuration file**

runmill needs an operator policy to know which backlog to read, which repositories issues map to, and how much autonomy it has.

**Fix (pick one)**

- `runmill init` — Create one, with the repository inferred from git
- `runmill --config <path> next` — Or point at one that lives somewhere else

Not recoverable: the run stops.

## RM-WORKSPACE-003

**Repository identity does not match**

A daemon may only push work cloned from the GitHub repository named by the selected issue route. Allowing those identities to differ could send one repository's code to another.

**Fix (pick one)**

- Run the daemon from the repository configured for this issue
- `runmill next --dry-run` — Inspect repository routing

Not recoverable: the run stops.

## RM-WORKSPACE-004

**Candidate commit provenance is unavailable**

Runmill, rather than the coding agent, authors the candidate commit. It needs an explicit verified Git identity and must be able to use any signer required by the source checkout before it claims backlog work.

**Fix (pick one)**

- Configure user.name and a verified user.email in the source checkout
- Make the configured signing key or signing agent available without a prompt
- `runmill doctor --check git:provenance` — Repeat the exact candidate-commit probe

Not recoverable: the run stops.

## RM-STATE-001

**State database schema is newer than this binary**

The database was migrated by a newer runmill. Reading it with this version could corrupt the audit record.

**Fix (pick one)**

- `npm i -g runmill@latest` — Upgrade runmill
- `runmill --version` — Check versions

Not recoverable: the run stops.

## RM-STATE-002

**External effect outcome is unresolved**

A prior request may have changed GitHub or the backlog even though Runmill did not receive a definitive response. Starting more work could repeat or contradict that mutation.

**Fix (pick one)**

- `runmill effects list` — List the exact pending effects
- `runmill effects resolve <key> --outcome applied` — Check the named remote system, then record the observed outcome

Recoverable: the run can continue once resolved.

## RM-STATE-003

**State database migration could not be completed safely**

Runmill refused to change the durable audit database because it could not create a consistent backup or acquire a coherent migration state.

**Fix (pick one)**

- Preserve the database and any backup files before retrying
- Check filesystem permissions and available disk space
- Stop other Runmill versions that may be using the same state directory

Not recoverable: the run stops.

<!-- Docs base: https://github.com/mikigraf/runmill/blob/main/docs/errors.md -->