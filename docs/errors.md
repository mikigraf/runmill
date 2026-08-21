# Error reference

Every runmill error carries a stable code, what happened, why, and how to fix it.
This page is generated from the catalog in `src/errors/runmill-error.ts` —
edit that, then run `npm run docs:errors`.

| Code | Title | Recoverable |
|---|---|---|
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

<!-- Docs base: https://github.com/mikigraf/runmill/blob/main/docs/errors.md -->