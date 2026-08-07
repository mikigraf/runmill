# Configuration

Two files, split by **ownership** — and the split is a security property, not an organizational
preference.

| File | Declares | Why there |
|---|---|---|
| `runmill.yaml` | Autonomy, budgets, risk rules, backlog and repository mapping | Outside the repository, so an inbound pull request cannot change how much authority runmill has |
| `.runmill/checks.yaml` | Which checks this repository requires | In the repository, versioned and reviewed with the code — and read from the **base** commit |

`runmill init` writes both, inferring the repository and base branch from git. Everything it
cannot infer is left as an editable placeholder, because a guessed merge policy is not a guess
worth making.

```bash
runmill init
runmill config validate    # every violation at once, in both files
runmill config show        # the resolved config, with every default filled in
```

Add this to the top of `runmill.yaml` for editor autocomplete and inline validation:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/mikigraf/runmill/main/runmill.schema.json
```

---

## `runmill.yaml`

Every key that has an obvious correct value has a default, so a missing key never means undefined
behavior. `runmill config show` prints what is actually in effect.

### Top level

| Key | Default | Notes |
|---|---|---|
| `version` | `1` | |
| `autonomy` | `pr-only` | `observe` · `pr-only` · `guarded-merge` · `continuous` — see [autonomy](./autonomy.md) |

### `provider`

| Key | Default | Notes |
|---|---|---|
| `implementation` | `codex` | `codex` or `claude` |
| `max_turns` | `80` | |
| `timeout_minutes` | `120` | |

### `backlog`

| Key | Default | Notes |
|---|---|---|
| `provider` | `linear` | |
| `team` | — | Required |
| `eligible_states` | `[]` | States an issue may be picked up from |
| `claim_state` | — | Moved here on claim. Display only — [the lease](./leases.md) owns ownership |
| `delivered_state` | — | `pr-only` terminal state |
| `completed_state` | — | After a merge |
| `blocked_state` | — | On escalation |
| `include_labels` / `exclude_labels` | `[]` | Exclusion wins |
| `max_estimate` | — | Skip issues estimated larger than this |
| `allow_unassigned` | `true` | |
| `selection.priority_first` | `true` | |
| `selection.unprioritized_last` | `true` | Backlogs encode "no priority" as `0`; a naive sort puts it first |
| `selection.due_date_tiebreaker` | `true` | |
| `selection.oldest_first` | `true` | |

### `github`

| Key | Default | Notes |
|---|---|---|
| `repositories[].match` | — | `{ team, project, label }` — **first matching rule wins** |
| `repositories[].repo` | — | `owner/name` |
| `repositories[].base_branch` | `main` | |
| `branch_template` | `runmill/{issue_identifier}-{slug}-{attempt}` | **Must contain `{attempt}`** |
| `draft_pr` | `true` | |
| `merge.method` | `squash` | `squash` · `merge` · `rebase` |
| `merge.delete_branch` | `true` | |

> `{attempt}` is validated, not suggested. Without it a retry reuses the previous run's branch and
> silently adopts that run's pull request through GitHub's 422-duplicate path — so a second attempt
> appears to succeed while pushing to a PR it did not open.

Rules are evaluated in order and the first match wins, so put specific rules above general ones.
Two rules with identical `match` blocks are rejected: only one could ever fire, and which one is
an accident of ordering.

### `workspace`

| Key | Default | Notes |
|---|---|---|
| `git_isolation` | `clone` | See below |
| `sandbox` | `native` | Resolved by `doctor`, never chosen by hand |
| `network` | `proxy` | `proxy` · `none`. Only `proxy` is enforceable on macOS |
| `network_allowlist` | `[]` | Hosts reachable through the proxy |
| `allow_unenforced` | `[]` | Controls you accept this platform cannot enforce |
| `clean_untracked_files` | `true` | |

**`git_isolation: clone` is the default for a specific reason.** A linked git worktree's `.git` is
a *file* pointing into the parent repository, so the object store, config, and **hooks** are shared
across every worktree and with runmill's own git invocations. That leaves two bad options: deny the
sandbox access to the shared `.git` and git stops working entirely, or grant it and an agent can
write `.git/hooks/pre-commit` to get code execution in the orchestrator's context on the next
commit. A clone with `--no-hardlinks` gives each run a self-contained `.git` inside its own
directory — the only shape where "writable: the run worktree, and nothing else" is both true and
compatible with git working.

`separate-git-dir` remains available because it is cheap on very large repositories. It is a
weaker guarantee and should be a deliberate choice.

### `verification`

| Key | Default | Notes |
|---|---|---|
| `manifest` | `.runmill/checks.yaml` | Path to the repository's check manifest |
| `fail_on_missing_check` | `true` | |
| `fail_on_skipped_check` | `true` | |
| `commands[]` | `[]` | Checks declared here rather than in the manifest |

Checks from both sources are unioned by id, and the repository's manifest wins a conflict.

### `review`

| Key | Default | Notes |
|---|---|---|
| `local_review_skill` | built-in | `runmill skills eject` to customize |
| `pr_review_skill` | built-in | |
| `provider` | `inherit` | |
| `max_fix_iterations` | `3` | Must not exceed the `fixer` invocation budget |
| `merge_blocking_severities` | `[critical, high]` | |
| `require_all_findings_resolved` | `true` | |

Review always runs in a fresh context with no implementer narrative. That is not configurable — a
reviewer that has read the implementer's reasoning is reviewing the reasoning, not the diff.

### `risk`

| Key | Default | Notes |
|---|---|---|
| `default` | `medium` | |
| `manual_approval.paths` | `[]` | Changes here escalate rather than auto-merging |
| `manual_approval.labels` | `[]` | |
| `manual_approval.conditions` | `[]` | |

`manual_approval.paths` does double duty: it escalates changes, and it is what
[`crossCheckVerdict`](./autonomy.md#gate-3--review-cross-checked) uses to reject a
"no findings" review on a sensitive diff.

### `budgets`

| Key | Default |
|---|---|
| `max_cost_usd_per_issue` | — |
| `max_wall_minutes_per_issue` | `240` |
| `daily_cost_usd` | — |
| `daily_window` | `utc` |
| `max_agent_invocations.total` | `14` |
| `max_agent_invocations.implementer` | `1` |
| `max_agent_invocations.local_review` | `4` |
| `max_agent_invocations.fixer` | `3` |
| `max_agent_invocations.pr_review` | `3` |
| `max_agent_invocations.pr_fixer` | `2` |
| `clamp_invocation_timeout_to_remaining` | `true` |
| `cost_enforcement` | `auto` |

Per-role caps matter more than the total: an oscillating fix loop burns budget specifically in the
`fixer` role, and a per-role cap stops it without starving review.

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
  - test_id: "flaky network integration"
    cause: "requires a live staging endpoint; tracked in ENG-88"
```

| Key | Notes |
|---|---|
| `checks[].id` | Unique. Duplicates are rejected rather than letting the later one win |
| `checks[].run` | The command. Required |
| `checks[].report` | `{ path, format }`. Without it, coverage is [`unproven`](./verification.md#proven-vs-unproven-coverage) |
| `declared_skips[]` | Top level, applies to every check. `cause` is required |

Every check declared here is required. An optional check is a check nobody has to fix, which is
indistinguishable from no check.

A manifest that exists but does not parse is a **hard failure**
([`RM-VERIFY-004`](./errors.md#rm-verify-004)) — *unreadable* must never quietly become *no checks
required*.

---

## Environment variables

| Variable | Does |
|---|---|
| `RUNMILL_DEMO=1` | In-memory backlog, provider, and forge, seeded with the bundled example issues |
| `RUNMILL_FAKE_BACKLOG=<file>` | Read issues from a JSON fixture |
| `RUNMILL_SOURCE_REPO=<path>` | Repository to create run workspaces from |
| `RUNMILL_DATA_DIR=<path>` | Where the state database and workspaces live |
| `LINEAR_API_KEY` | Backlog credential. The OS keychain is checked first |
| `GITHUB_TOKEN` | Forge credential. `gh auth token` is used when unset |

Fakes are never inferred. A fake standing in for production without the operator knowing is how a
governance system becomes theatre.

## See also

- [Autonomy and merge gates](./autonomy.md) · [The coverage contract](./verification.md)
- [The lease model](./leases.md) · [The sandbox](./sandbox.md) · [Run lifecycle](./lifecycle.md)
