# Error reference

Every runmill error carries a stable code, what happened, why, and how to fix it.
This page is generated from the catalog in `src/errors/runmill-error.ts` —
edit that, then run `npm run docs:errors`.

| Code | Title | Recoverable |
|---|---|---|
| [`RM-SELECT-002`](#rm-select-002) | Issue does not map to a repository | no |
| [`RM-SELECT-003`](#rm-select-003) | Issue is too underspecified to build a task packet | no |
| [`RM-AUTH-003`](#rm-auth-003) | Backlog credential expired | yes |
| [`RM-SANDBOX-001`](#rm-sandbox-001) | Sandbox isolation unavailable | no |
| [`RM-SANDBOX-002`](#rm-sandbox-002) | Sandbox escape probe succeeded | no |
| [`RM-LEASE-001`](#rm-lease-001) | Lease lost or fencing generation stale | no |
| [`RM-LEASE-002`](#rm-lease-002) | Could not acquire lease | yes |
| [`RM-VERIFY-001`](#rm-verify-001) | Required check is missing | yes |
| [`RM-VERIFY-002`](#rm-verify-002) | Check ran against a different tree | yes |
| [`RM-VERIFY-003`](#rm-verify-003) | Undeclared test skip | yes |
| [`RM-CI-002`](#rm-ci-002) | Required check never reported | yes |
| [`RM-CI-003`](#rm-ci-003) | Merge queue check name does not match | yes |
| [`RM-PROVIDER-001`](#rm-provider-001) | Unknown provider event shape | no |
| [`RM-PROVIDER-002`](#rm-provider-002) | Provider budget exhausted | yes |
| [`RM-REVIEW-001`](#rm-review-001) | Review output did not match the schema | yes |
| [`RM-REVIEW-004`](#rm-review-004) | Review needs a human decision | yes |
| [`RM-CONFIG-001`](#rm-config-001) | Configuration is invalid | no |
| [`RM-CONFIG-002`](#rm-config-002) | Referenced file does not exist | no |
| [`RM-CONFIG-003`](#rm-config-003) | No configuration file | no |
| [`RM-STATE-001`](#rm-state-001) | State database schema is newer than this binary | no |

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

## RM-AUTH-003

**Backlog credential expired**

runmill cannot read or transition issues without a valid backlog credential.

**Fix (pick one)**

- `runmill auth login linear` — Re-authenticate
- `runmill doctor --check linear` — Verify

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

**Undeclared test skip**

A test that passed at the base commit is skipped or absent at the candidate, and the skip is not declared in the manifest. Silently losing a test is indistinguishable from breaking it.

**Fix (pick one)**

- Restore the test, or declare the skip with a cause and expiry
- `runmill inspect <run-id>` — See the diff against the baseline inventory

Recoverable: the run can continue once resolved.

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

- Raise the budget in runmill.yaml
- `runmill resume <run-id>` — Resume with approval

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
- `runmill resume <run-id> --answer <choice>` — Answer and continue

Recoverable: the run can continue once resolved.

## RM-CONFIG-001

**Configuration is invalid**

runmill.yaml does not satisfy the published schema, so behavior would be undefined.

**Fix (pick one)**

- `runmill config validate` — Show the specific violations
- Add the schema header for editor validation

Not recoverable: the run stops.

## RM-CONFIG-002

**Referenced file does not exist**

A path in runmill.yaml points at a file that is not present. This is checked before any agent is dispatched so it cannot fail after spend.

**Fix (pick one)**

- `runmill skills eject` — Write the built-in review skills
- `runmill config validate` — Check which paths are unresolvable

Not recoverable: the run stops.

## RM-CONFIG-003

**No configuration file**

runmill needs a runmill.yaml to know which backlog to read, which repositories issues map to, and how much autonomy it has.

**Fix (pick one)**

- `runmill init` — Create one, with the repository inferred from git
- `runmill --config <path> next` — Or point at one that lives somewhere else

Not recoverable: the run stops.

## RM-STATE-001

**State database schema is newer than this binary**

The database was migrated by a newer runmill. Reading it with this version could corrupt the audit record.

**Fix (pick one)**

- `npm i -g runmill@latest` — Upgrade runmill
- `runmill --version` — Check versions

Not recoverable: the run stops.

<!-- Docs base: https://github.com/mikigraf/runmill/blob/main/docs/errors.md -->