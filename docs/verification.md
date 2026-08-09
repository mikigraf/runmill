# The coverage contract

> Implemented in [`src/verification/engine.ts`](../src/verification/engine.ts).

This coverage contract supplies the evidence for the **Verify** stage of Runmill's delivery loop.

Most automation treats a green command as proof. It is not. A command that exits 0 answers
exactly one question — *did this process end well?* — and merge-readiness depends on four:

| | Question | How a green command fails it |
|---|---|---|
| **Discovery** | Which checks are required for *this* change? | It ran the checks someone remembered to list |
| **Coverage** | Were all of them actually invoked? | A check that never ran cannot fail |
| **Freshness** | Did they run against the exact commit being merged? | It tested a tree that no longer exists |
| **Outcome** | Did they complete without a prohibited skip? | `0 tests found` also exits 0 |

runmill answers all four and records the evidence. A check whose result cannot be tied to a
specific commit, a specific command, and a tree that did not move is not evidence.

---

## 1. Discovery — resolving the manifest

`resolveManifest()` builds the required set from four sources:

| Source | Origin | Trust |
|---|---|---|
| `repository-policy` | `.runmill/checks.yaml`, read from the **base** commit, plus `verification.commands` in `runmill.yaml` | Authoritative |
| `changed-path` | Path rules — touching `migrations/` adds the migration check | Authoritative |
| `github` | Contexts branch protection requires | Authoritative, remote-observed |
| `agent` | The coding agent proposing additional checks | Advisory, additive only |

Two properties make this safe:

**The union is monotonic.** An agent can *add* checks. Nothing it does removes one. A change
that could shrink its own required set could always shrink it to nothing.

**An agent proposes an identifier, never a command.** Proposals are looked up in the configured
set; an identifier that is not already configured is ignored and never executed:

```ts
const known = input.configured.find((c) => c.id === id);
if (known === undefined) return;   // unknown identifiers are ignored, never executed
```

The orchestrator is what runs check commands. If the agent could supply the string, the check
runner would be a remote-code-execution primitive pointed at your machine.

Checks sourced from `github` are recorded in the manifest with an empty command. They are not
locally executable — they are satisfied by [CI reconciliation](#remote-checks), not by running
anything.

> **Repository policy is read from the base commit.** A pull request that edits
> `.runmill/checks.yaml` cannot relax the checks that govern its own merge — the rules a change is
> judged by are the rules that existed before it. A manifest that is *new* in the change falls back
> to the working tree, which is safe because the union is monotonic: a new manifest can only add.
>
> Where the manifest was read from is recorded on the run (`readFrom: "base-ref" | "working-tree"`).

Two files, split by ownership:

| File | Declares | Lives |
|---|---|---|
| `.runmill/checks.yaml` | Which checks this repository requires | In the repository, versioned and reviewed with the code |
| `runmill.yaml` | Autonomy, budgets, risk rules | Outside the repository, where an inbound pull request cannot reach it |

Both contribute checks; they are unioned by id, and the repository wins a conflict — it is the
thing that knows how to build itself. A manifest that exists but does not parse is a hard failure
([`RM-VERIFY-004`](./errors.md#rm-verify-004)): *unreadable* must never quietly become
*no checks required*.

## 2. Coverage — proving each one ran

After execution, every required, locally-executable check must have produced a result:

```ts
for (const spec of manifest) {
  if (spec.source === "github" || !spec.required) continue;
  if (!results.some((r) => r.checkId === spec.id)) {
    failures.push(`required check "${spec.id}" produced no result`);
  }
}
```

This is a separate pass on purpose. "No check failed" and "every check ran" are different
statements, and only the second one is worth anything. A manifest of ten checks where two never
executed produces zero failures and is not merge-ready.

A required check with no runnable command and no remote result raises
[`RM-VERIFY-001`](./errors.md#rm-verify-001) rather than being skipped.

### Who ran it counts

Every recorded result carries an `executor`:

```ts
// Checks the agent ran during implementation are advisory telemetry.
// Merge-readiness only ever counts the orchestrator's own execution.
executor: "orchestrator",
```

The agent runs tests while it works. That is useful signal and it is not evidence — it happened in
the agent's own workspace, under the agent's own control, at whatever commit the agent had at the
time. Merge-readiness counts only checks the orchestrator ran itself.

## 3. Freshness — pinning the result to a commit

Checks do not run in the agent's workspace. The engine creates a **detached checkout of the
candidate commit**:

```ts
const verifyPath = await workspaces.createVerificationCheckout(workspace, candidateSha);
```

and hashes the tree on both sides of every check:

```ts
const before = treeBefore ?? (await workspaces.treeHash(verifyWorkspace));
const outcome = await this.#sandbox.run({ ... });
const after = await workspaces.treeHash(verifyWorkspace);

if (before !== after) {
  status = "failed";
  notes.push("tree changed during the check; result invalidated");
}
```

If the tree moved, the result does not describe the candidate commit — it describes something
else that briefly existed. That is [`RM-VERIFY-002`](./errors.md#rm-verify-002).

This catches the honest cases (a check that regenerates a lockfile, a formatter with `--write`
left on) and the dishonest ones (a test that rewrites a fixture until it passes) with the same
mechanism, because it does not care *why* the tree moved.

The `after` hash of one check becomes the `before` of the next — nothing runs in between — so N
checks cost N+1 full-tree hashes rather than 2N.

Checks run in the [sandbox](./sandbox.md) with network disabled and only the verification
checkout writable.

## 4. Outcome — what "passed" excludes

Exit code 0 is necessary and nowhere near sufficient. Three additional conditions each turn a
green exit into a failure.

**Zero tests discovered.**

```ts
if (status === "passed" && detectZeroTests(combined)) {
  status = "failed";
  coverage = "unproven";
}
```

Matches `no tests found`, `0 tests`, `0 passed`, `passWithNoTests`. This is the nastiest false
green there is: a misconfigured path filter or a renamed directory produces output that is
character-for-character as reassuring as a full pass. Every framework will happily report total
success for having done nothing.

**Focused execution.** `.only(`, `fit(`, `fdescribe(` — a `.only` left in a test file silently
reduces the suite to one case and still exits 0. The whole suite did not run, so the suite did
not pass.

**Undeclared skips.**

```ts
const reportedSkips = countReportedSkips(combined);
const declared = spec.declaredSkips?.length ?? 0;
if (status === "passed" && reportedSkips > declared) { status = "failed"; }
```

Skips are allowed — they must be *declared*, with a stated cause, in the manifest. `declared_skips`
is top level and applies to every check, because a skip is a statement about a *test*, and the same
test does not become acceptable to lose because a different command happened to run it:

```yaml
checks:
  - id: unit
    run: npm test

declared_skips:
  - test_id: "flaky network integration"
    cause: "requires a live staging endpoint; tracked in ENG-88"
```

A declared skip with no `cause` is rejected — that is exactly the undocumented skip the file
exists to prevent.

Three skips against one declaration is two skips nobody decided on. That is
[`RM-VERIFY-003`](./errors.md#rm-verify-003).

The asymmetry is deliberate: declaring a skip is cheap and explicit, and the cause is written
down where a reviewer sees it. Silently tolerating skips means the number can drift from 0 to 40
without anyone choosing it.

**Timeouts** are failures, not unknowns.

### `proven` vs `unproven` coverage

A check that passes without a machine-readable report is marked `coverage: "unproven"`:

```ts
if (spec.report === undefined) {
  coverage = "unproven";
  notes.push("no machine-readable report declared; coverage unproven");
}
```

The engine parsed stdout and found nothing alarming. It could not confirm *what* ran. Declaring a
report upgrades this from an absence of bad news to a positive statement:

```yaml
checks:
  - id: unit
    run: npm test -- --reporter=junit --outputFile=reports/unit.xml
    report:
      path: reports/unit.xml
      format: junit
```

`unproven` does not block a merge on its own. It is the honest label for the difference between
"nothing looked wrong" and "here is what ran".

<a id="remote-checks"></a>

## Remote checks

Checks that GitHub runs are reconciled rather than executed — see
[`src/pr/reconcile.ts`](../src/pr/reconcile.ts). Two rules matter:

- **`neutral` and `skipped` are not coverage.** A required check reporting `skipped` has not
  passed; it has not run. GitHub's own merge gating counts these as satisfied. runmill does not.
- **A required context that never gets scheduled is a failure, not a wait.** After
  10 minutes with no run scheduled, the run escalates with
  [`RM-CI-002`](./errors.md#rm-ci-002) rather than waiting forever. A workflow whose trigger
  does not match the branch will never report, and waiting on it is indistinguishable from
  hanging.

## The final verdict

```ts
const anyFailed = results.some((r) => r.status === "failed");
return { mergeReady: !anyFailed && failures.length === 0, results, failures };
```

Both terms are required. `results` covers checks that ran and failed; `failures` covers checks
that never ran, produced no result, or had no runnable command. A missing check is not a passing
check.

## Reading the evidence

```bash
runmill inspect <run-id>
```

Every check result records the command, the commit, the tree hash before and after, the executor,
the exit code, the duration, and a hash of stdout. If a merge is ever questioned, this is the
record of what was actually proven, and by whom.

## See also

- [Autonomy and merge gates](./autonomy.md) — where verification sits among the seven gates
- [The sandbox](./sandbox.md) — the isolation checks execute under
- [Errors](./errors.md) — `RM-VERIFY-001`, `RM-VERIFY-002`, `RM-VERIFY-003`, `RM-CI-002`
