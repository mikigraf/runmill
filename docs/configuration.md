# Configuration

Use one command for the complete setup:

```bash
runmill init
```

The wizard uses existing GitHub and Linear access to preload repository, team, and workflow choices,
and checks which Codex and Claude Code sessions authenticate inside Runmill's sandbox. It never
asks for a GitHub token or Linear API key in an interactive terminal. If GitHub is not configured,
it can hand sign-in to `gh auth login`; if Linear is not configured, it writes unmistakable
`REPLACE_WITH_LINEAR_*` placeholders and prints the environment/keychain command to use before
rerunning setup. Those placeholders never pass doctor. Provider subscription sign-in is likewise
handed to the provider's own CLI.
After writing the files, `init` runs the full doctor suite. It creates and validates a candidate
commit in a disposable repository using the source checkout's identity and signing policy, then
sends one short, one-turn request for each distinct configured provider/model through the same
sandbox used for real work. The provider requests use a small number of tokens and may be billable.
Runmill does not accept those secrets as wizard answers or command arguments, and never writes them
to the policy file. In CI or another non-interactive shell, `runmill init --defaults` accepts
discovered values and conservative defaults, then performs the same readiness checks.

`init` is idempotent per file. It never overwrites an existing operator policy, check manifest,
review skill, schema, or ignore file. Re-run it whenever setup is incomplete: Runmill preserves the
files already there and creates only the missing ones.

For a locked npm project, `init` reads `package.json` and emits only check scripts that actually
exist: `typecheck` and `test`, then `check`, `lint`, or `build` as conservative fallbacks. It never
invents `npm test` for a Python repository or a Node package without that script. When no safe check
can be inferred, `.runmill/checks.yaml` contains `checks: []` and both init and doctor block until
you replace it with the repository's real commands. Run `npm ci` in the source checkout before the
first live run. The `verification:dependencies` doctor proof freshly fetches the configured remote
base without moving the local branch, reads repository check policy from that exact SHA, and
compares its lockfiles with the installed npm inventory. It does not copy dependencies or contact
the registry, and blocks when the local checkout is ahead, behind, missing `node_modules`, or stale.
Runmill then reuses that exact lockfile-matching tree without installing or using the network during
verification.

The configuration is the team's delivery policy in executable form: which backlog work is
eligible, how issues map to repositories, which agent implements and reviews, which checks and
paths matter, what budgets apply, and when a run may continue, retry, merge, or require a person.

Two files, split by **ownership** — and the split is a security property, not an organizational
preference.

| File                                                         | Declares                                                      | Why there                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `$XDG_CONFIG_HOME/runmill/projects/<project-id>/policy.yaml` | Autonomy, budgets, risk rules, backlog and repository mapping | Operator-owned and outside the repository, so an inbound pull request cannot increase Runmill's authority |
| `.runmill/checks.yaml` and `.runmill/skills/*.md`            | Required checks and review rules                              | Repository-owned, versioned and reviewed with the code — and read from the **base** commit                |

Without `XDG_CONFIG_HOME`, the policy defaults to
`~/.config/runmill/projects/<project-id>/policy.yaml`. Pass `--config <path>` before the command to
use an explicit operator-policy path. `runmill init` infers the repository and base branch from git
and preselects everything else it can discover safely.

```bash
runmill config validate    # every violation at once, in both files
runmill config show        # the resolved config, with every default filled in
runmill doctor             # rerun host, sandbox, auth, and minimal provider-request proofs
runmill next               # show which issue would be selected and why
```

The generated policy references the `runmill.schema.json` file written beside it. For a manually
created policy, add this line for editor autocomplete and inline validation:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/mikigraf/runmill/main/runmill.schema.json
```

---

## `policy.yaml`

Every key that has an obvious correct value has a default, so a missing key never means undefined
behavior. `runmill config show` prints what is actually in effect.

### Top level

| Key                            | Default   | Notes                                                                                  |
| ------------------------------ | --------- | -------------------------------------------------------------------------------------- |
| `version`                      | `1`       |                                                                                        |
| `autonomy`                     | `pr-only` | `observe` · `pr-only` · `guarded-merge` · `continuous` — see [autonomy](./autonomy.md) |
| `experimental.automatic_merge` | `false`   | A second explicit acknowledgement required for `guarded-merge` and `continuous`        |

### `providers`

Which agent runs which role. One block, because picking the implementer and
picking the reviewer is the same decision made twice.

| Key                          | Default                                                        | Notes                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_turns`                  | `80`                                                           | Passed to Claude Code for each invocation. Codex CLI has no equivalent turn flag; Codex runs are bounded by `timeout_minutes` and the issue invocation and wall-time budgets instead. |
| `timeout_minutes`            | `120`                                                          | Shared by both roles                                                                                                                                                                  |
| `implementer.implementation` | `codex`                                                        | `codex` or `claude`                                                                                                                                                                   |
| `implementer.model`          | CLI default                                                    | Model id passed through. Not validated against a list, because model ids change faster than any allowlist                                                                             |
| `reviewer.implementation`    | `inherit`                                                      | `inherit` reuses the implementer's CLI                                                                                                                                                |
| `reviewer.model`             | same-CLI: implementer's model; different CLI: provider default | Independent of `reviewer.implementation` when explicitly set                                                                                                                          |

```yaml
providers:
  implementer:
    implementation: codex
    model: <fast-model>
  reviewer:
    implementation: inherit # same CLI
    model: <stronger-model> # different model
```

`inherit` is valid only for the reviewer; the implementer has nothing to inherit from.

#### Provider credentials

| Method                                  | Current status                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex or Claude subscription session    | Experimental. `runmill doctor` first proves authentication from a disposable private config copy, then completes one small provider request inside the real sandbox. Writes cannot reach the real provider config, but tool subprocesses can still read the copied credential. Use a dedicated subscription and keep Runmill in `pr-only`. |
| `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` | Unsupported. Runmill strips provider keys from the agent environment because every tool subprocess would inherit them.                                                                                                                                                                                                                     |

GitHub and Linear credentials stay in orchestrator-owned adapters and never enter the coding-agent
process. A host-side credential broker is required before Runmill can claim provider credential
isolation. See [the sandbox boundary](./sandbox.md#the-provider-credential-boundary).

On macOS, store an existing credential by piping it on stdin. Runmill deliberately has no token
option, so the secret never appears in its process arguments or command history:

```bash
printenv LINEAR_API_KEY | runmill auth login linear
gh auth token | runmill auth login github
```

The command refuses an interactive terminal or empty input and never echoes the value. On Linux,
keep using `LINEAR_API_KEY`, `GITHUB_TOKEN`, or an authenticated `gh` CLI.

The interactive `runmill init` wizard follows the same boundary. It can launch `gh auth login`,
which owns its own terminal authentication flow, but it never reads a GitHub or Linear secret with
an echoed wizard question. Configure environment variables before starting the wizard, or use the
stdin-only keychain commands above on macOS and rerun it to preload remote choices.

`runmill doctor` resolves credentials through the same environment, keychain, and `gh` fallback as
the runtime. Its GitHub probe checks the exact configured repositories and base branches, including
reported push permission, instead of accepting a generic account lookup. The Linear probe makes an
authenticated API request for the exact configured team and proves that every eligible, claim,
delivered, and completed state named by the policy exists on that team. For coding agents it
reports authentication and actual one-turn
execution separately, so a logged-in CLI with an unavailable model, blocked network, exhausted
account, or incompatible sandbox cannot pass readiness. The presence of a token or a successful
status command is not treated as proof that work can execute.

### `backlog`

| Key                                 | Default  | Notes                                                                                                                                   |
| ----------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`                          | `linear` | Linear is the only live adapter in this preview. Unsupported values are rejected during validation.                                     |
| `team`                              | —        | Required                                                                                                                                |
| `eligible_states`                   | `[]`     | Exact Linear state names an issue may be picked up from. Names must be unique.                                                          |
| `claim_state`                       | —        | Exact non-eligible state entered on claim. Display only — [the lease](./leases.md) owns ownership.                                     |
| `delivered_state`                   | —        | Required non-eligible terminal state for `pr-only`; prevents the next poll from opening another PR for the same issue.                  |
| `completed_state`                   | —        | Exact non-eligible state entered after a merge, when configured.                                                                        |
| `include_labels` / `exclude_labels` | `[]`     | Exclusion wins                                                                                                                          |
| `max_estimate`                      | —        | Skip issues estimated larger than this                                                                                                  |
| `allow_unassigned`                  | `true`   | When false, `claim_assignee` is required and only work already owned by that exact id is eligible. Other assignments are never adopted. |
| `claim_assignee`                    | —        | Exact Linear assignee id set on claim and restored after a pre-PR failure.                                                              |
| `selection.priority_first`          | `true`   |                                                                                                                                         |
| `selection.unprioritized_last`      | `true`   | Backlogs encode "no priority" as `0`; a naive sort puts it first                                                                        |
| `selection.due_date_tiebreaker`     | `true`   |                                                                                                                                         |
| `selection.oldest_first`            | `true`   |                                                                                                                                         |

Runmill compares lifecycle names case-insensitively during policy validation so `Todo` and `todo`
cannot describe two sides of the same boundary. Doctor then checks the exact spelling against
Linear. A missing team or state blocks readiness before Runmill claims an issue or records a remote
mutation intent.

### `github`

| Key                          | Default                                       | Notes                                                     |
| ---------------------------- | --------------------------------------------- | --------------------------------------------------------- |
| `repositories[].match`       | —                                             | `{ team, project, label }` — **first matching rule wins** |
| `repositories[].repo`        | —                                             | `owner/name`                                              |
| `repositories[].base_branch` | `main`                                        |                                                           |
| `branch_template`            | `runmill/{issue_identifier}-{slug}-{attempt}` | **Must contain `{attempt}`**                              |
| `draft_pr`                   | `true`                                        |                                                           |
| `merge.method`               | `squash`                                      | `squash` · `merge` · `rebase`                             |

Several match rules may select teams, projects, or labels, but every rule must resolve to the same
`owner/name`, and that name must match the local checkout's `origin`. This release runs one daemon
per repository. It does not clone one checkout and push it to a different configured target.

Dependency-stack delivery is not exposed in the developer preview. It needs a complete lower-layer
merge, retarget, rebase, and re-verification lifecycle before an upper pull request can be described
as delivered. Unknown stack settings are rejected instead of enabling a partial implementation.

> `{attempt}` is validated, not suggested. Without it a retry reuses the previous run's branch and
> silently adopts that run's pull request through GitHub's 422-duplicate path — so a second attempt
> appears to succeed while pushing to a PR it did not open.

Rules are evaluated in order and the first match wins, so put specific rules above general ones.
Two rules with identical `match` blocks are rejected: only one could ever fire, and which one is
an accident of ordering.

Runmill does not delete a merged branch automatically in this release. Branch cleanup remains a
GitHub or operator policy rather than a configuration switch that the runtime does not consume.

### `workspace`

| Key                 | Default  | Notes                                                                                        |
| ------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `git_isolation` | `clone` | See below |
| `sandbox`           | `native` | Resolved by `doctor`, never chosen by hand                                                   |
| `network`           | `proxy`  | `proxy` currently permits unrestricted provider egress; `none` is accepted only in `observe` |
| `network_allowlist` | `[]`     | Reserved for the planned proxy. Non-empty values are rejected rather than silently ignored.  |
| `allow_unenforced`  | `[]`     | Reserved. Non-empty values are rejected because no runtime gate consumes them yet.           |

`sandbox: native` is the only execution mode. `none` is accepted only for `observe`, where no
agent runs. Container isolation is not exposed until Runmill has a container backend it can probe
and enforce.

The Codex and Claude CLIs need network access for implementation and review. For that reason,
`network: none` is also limited to `observe`; selecting it for a live delivery mode fails policy
validation before doctor can certify a different execution context than the daemon will use.

**`git_isolation: clone` is the default for a specific reason.** A linked git worktree's `.git` is
a _file_ pointing into the parent repository, so the object store, config, and **hooks** are shared
across every worktree and with runmill's own git invocations. That leaves two bad options: deny the
sandbox access to the shared `.git` and git stops working entirely, or grant it and an agent can
write `.git/hooks/pre-commit` to get code execution in the orchestrator's context on the next
commit. A clone with `--no-hardlinks` gives each run a self-contained `.git` inside its own
directory — the only shape where "writable: the run worktree, and nothing else" is both true and
compatible with git working.

Linked-worktree isolation is not exposed as configuration. Its Git metadata lives in the parent
repository, outside the run sandbox, so agent Git commands either fail or require a grant that
would weaken isolation.

Per-run clones are removed after successful cleanup and retained when a failed run needs
inspection. There is no separate untracked-file cleanup switch.

#### Candidate commit identity and signing

Candidate commits use the effective Git identity and signing policy of the trusted source checkout,
not a Runmill placeholder identity. Configure the operator or bot identity with Git itself:

```bash
git config --local user.name "Runmill Bot"
git config --local user.email "verified-bot-address@example.com"
git config --local commit.gpgSign true       # optional, or required by your branch policy
git config --local user.signingKey <key-id-or-path>
```

Runmill resolves `user.name`, `user.email`, `commit.gpgSign`, `user.signingKey`, `gpg.format`, and
the selected signing program before the agent starts. It keeps that snapshot in the orchestrator,
does not copy it into the run clone, and invokes signing from the host-side checkpoint process. The
private key or signing-agent credential is never passed to the coding-agent process. A missing
identity, the old `runmill@localhost` placeholder, or a required signature that cannot be created
stops setup before the first run. `runmill doctor --check git:provenance` repeats the exact commit
operation in a disposable repository without changing the source checkout. Candidate commits use
the current clock; the fixed 1970 identity used to make internal lease-ref objects deterministic
never appears in pull-request history.

### `verification`

| Key                     | Default                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`              | `.runmill/checks.yaml`                                       | Path to the repository's check manifest                                                                                                                                                                                                                                                                                                                                                  |
| `fail_on_missing_check` | `true`                                                       |                                                                                                                                                                                                                                                                                                                                                                                          |
| `fail_on_skipped_check` | `true` when omitted; `false` in a generated `pr-only` policy | Requires every required local check to produce a valid declared report. The starter manifest cannot guess framework-specific reporter flags, so `runmill init` records its passing checks honestly as `unproven` while a person owns the merge. `guarded-merge` and `continuous` require this setting to be `true`. Observed zero-test, focused, or undeclared-skip results always fail. |
| `commands[]`            | `[]`                                                         | Checks declared here rather than in the manifest                                                                                                                                                                                                                                                                                                                                         |

Checks from both sources are unioned by id. If an id conflicts, the operator policy wins: repository
content may add a requirement, but it cannot replace an operator-owned command or evidence rule.
At least one command must exist across the two sources. `runmill doctor --check verification` and
`runmill config validate` fail closed when the union is empty. The same doctor scope includes
`verification:dependencies`; run that full id to refetch the configured base and recheck the exact
remote lockfile/local-install proof.

### `review`

| Key                             | Default            | Notes                                                                                                                                                                                             |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local_review_skill`            | none               | Optional repository guidance appended after the immutable local-review rubric                                                                                                                     |
| `pr_review_skill`               | none               | Optional repository guidance appended after the immutable PR-review rubric                                                                                                                        |
| `max_fix_iterations`            | `3`                | Must not exceed the `fixer` invocation budget                                                                                                                                                     |
| `merge_blocking_severities`     | `[critical, high]` |                                                                                                                                                                                                   |
| `require_all_findings_resolved` | `true`             | When true, every finding blocks until a fresh review no longer reports it. When false, severity filtering applies only to an approving verdict; `changes_required` still blocks on every finding. |

Review always runs in a fresh context with no implementer narrative. That is not configurable: a
reviewer that has read the implementer's reasoning is reviewing the reasoning, not the diff.

Runmill's minimum rubric and complete `review-findings@1` output contract are always included in
the live reviewer prompt. A configured skill cannot replace them. Repository skill text is
captured before implementation starts, clearly marked as untrusted data, and may only ask for
additional or narrower scrutiny. `runmill skills eject` writes editable starting points for that
supplemental guidance; removing requirements from an ejected file does not remove them from the
immutable built-in rubric.

`providers.reviewer` goes one step further. Fresh context removes the implementer's narrative; a
different vendor also removes its blind spots. A model reviewing its own work agrees with itself
for the same reasons it was wrong, and no amount of context clearing fixes that. The cost is a
second authenticated CLI, which is why the default is `inherit`.

The CLI and the model are separate choices, and either one differing is enough to make review
independent. Different vendors:

```yaml
providers:
  implementer:
    implementation: codex
  reviewer:
    implementation: claude
```

Or the same CLI with a different model, which needs no second subscription and is usually the
cheapest useful configuration:

```yaml
providers:
  implementer:
    implementation: codex
    model: <fast-model>
  reviewer:
    implementation: inherit
    model: <stronger-model>
```

runmill forks the reviewer when the implementation **or** the model differs. When only the model
differs it reuses the already-authenticated CLI and skips a second detect and auth probe.

Acceptance criteria are enforced, not just recorded. The reviewer receives the criteria extracted
from the issue and returns which ones it judges met; an approval that leaves any of them unmet is
rejected. That rule is one-directional, like every other cross-check: it can withhold delivery, and
it can never grant it. A reviewer reporting every criterion met earns nothing on its own, because
the deterministic gates still have to pass.

### `risk`

| Key                          | Default  | Notes                                                                                           |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `default`                    | `medium` | Only `low` is eligible for automatic merge; every other tier requires approval                  |
| `manual_approval.paths`      | `[]`     | A match in the final diff requires approval before merge; supports literals, `*`, `**`, and `?` |
| `manual_approval.labels`     | `[]`     | A matching issue label requires approval before merge; matching is case-insensitive             |
| `manual_approval.conditions` | `[]`     | See condition support below; unknown evidence fails closed                                      |

`manual_approval.paths` does double duty: it escalates changes, and it is what
[`crossCheckVerdict`](./autonomy.md#gate-3--review-cross-checked) uses to reject a
"no findings" review on a sensitive diff.

Runmill can determine these conditions from evidence it already owns:

| Condition                     | Evidence                                               |
| ----------------------------- | ------------------------------------------------------ |
| `missing_acceptance_criteria` | The claimed task packet has no acceptance criteria     |
| `check_config_changed`        | The final diff changes `verification.manifest`         |
| `lockfile_changed`            | The final diff changes a recognized ecosystem lockfile |

`public_api_change`, `permissions_change`, and `secret_related_change` need semantic diff evidence
that Runmill does not yet produce deterministically. Configuring one therefore ends an automatic
merge run in `NEEDS_HUMAN`; it is never treated as a non-match. These rules do not block `pr-only`
from delivering the reviewed pull request.

### `budgets`

| Key                                     | Default |
| --------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `max_cost_usd_per_issue`                | —       |
| `max_wall_minutes_per_issue`            | `240`   |
| `daily_cost_usd`                        | —       |
| `daily_window`                          | `utc`   | Calendar bucket for the durable per-repository spend ledger (`utc` or host `local`) |
| `max_agent_invocations.total`           | `14`    |
| `max_agent_invocations.implementer`     | `1`     |
| `max_agent_invocations.local_review`    | `4`     |
| `max_agent_invocations.fixer`           | `3`     |
| `max_agent_invocations.pr_review`       | `3`     |
| `max_agent_invocations.pr_fixer`        | `2`     |
| `clamp_invocation_timeout_to_remaining` | `true`  |
| `cost_enforcement`                      | `auto`  |

Per-role caps matter more than the total: an oscillating fix loop burns budget specifically in the
`fixer` role, and a per-role cap stops it without starving review.

`auto` enforces dollar cost only when every configured provider reports it, and refuses rather
than treating unknown spend as zero. The current Codex adapter does not report dollar cost, so a
policy that combines Codex with either dollar cap is invalid. Daily spend is recorded in SQLite by
repository and calendar bucket, survives daemon restarts, and is checked before another issue is
dispatched. Token-price estimation is not implemented. Use `wall-and-invocations-only` without a
dollar cap when those are the available signals.

Daemon polling is an operational CLI setting rather than repository policy. Use
`runmill daemon --poll-seconds <seconds>` to change the 30-second default, or `--once` to drain the
currently eligible queue and exit. See [daemon operation](./daemon.md).

---

## `.runmill/checks.yaml`

```yaml
checks:
  - id: typecheck
    run: npm run typecheck

  - id: test
    run: npm test
    report:
      path: reports/junit.xml
      format: junit
    declared_skips:
      - test_id: "tests.network::retries request"
        cause: "requires a live staging endpoint; tracked in ENG-88"
```

| Key                         | Notes                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checks[].id`               | Unique. Duplicates are rejected rather than letting the later one win                                                                                                                                                                    |
| `checks[].run`              | The command. Required                                                                                                                                                                                                                    |
| `checks[].report`           | A relative path plus `junit`, `tap`, or `go-json`. Runmill pre-creates this exact writable file in otherwise read-only base and candidate checkouts; the reporter must overwrite it. Both reports need unique, non-empty test identities |
| `checks[].declared_skips[]` | Exact `test_id` exceptions for this check only. `cause` is required, ids must be unique, and observed skipped/absent ids must exactly equal the declarations                                                                             |

Every check declared here is required. An optional check is a check nobody has to fix, which is
indistinguishable from no check.

`runmill init` only infers this file for a committed npm lockfile and scripts present in
`package.json`. It deliberately writes `checks: []` for an unknown ecosystem instead of producing a
plausible command that cannot run. Edit the file and rerun `runmill doctor --check verification`.

For npm checks, the source checkout must contain the result of `npm ci` for the exact base
`package.json` and `package-lock.json`. Runmill fingerprints and caches that tree before agent work,
then materializes it read-only in the clean verification checkout. Verification does not run an
installer and cannot reach the registry. `runmill doctor --check verification:dependencies`
freshly fetches that same base and validates its exact lockfiles against the source install without
creating the cache. See [Dependencies without a networked verification
bootstrap](./verification.md#dependencies-without-a-networked-verification-bootstrap).

A manifest that exists but does not parse is a **hard failure**
([`RM-VERIFY-004`](./errors.md#rm-verify-004)) — _unreadable_ must never quietly become _no checks
required_.

---

## Environment variables

| Variable                      | Does                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `RUNMILL_DEMO=1`              | In-memory backlog, provider, and forge, seeded with the bundled example issues |
| `RUNMILL_FAKE_BACKLOG=<file>` | Read issues from a JSON fixture                                                |
| `RUNMILL_SOURCE_REPO=<path>`  | Repository to create run workspaces from                                       |
| `RUNMILL_DATA_DIR=<path>`     | Where the state database and workspaces live                                   |
| `LINEAR_API_KEY`              | Backlog credential. The environment overrides the macOS keychain               |
| `GITHUB_TOKEN`                | Forge credential. `gh auth token` is used when unset                           |

Fakes are never inferred. A fake standing in for production without the operator knowing is how a
governance system becomes theatre.

## See also

- [Autonomy and merge gates](./autonomy.md) · [The coverage contract](./verification.md)
- [The lease model](./leases.md) · [The sandbox](./sandbox.md) · [Run lifecycle](./lifecycle.md)
