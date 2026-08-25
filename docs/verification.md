# The coverage contract

> Implemented in [`src/verification/engine.ts`](../src/verification/engine.ts).

This coverage contract supplies the evidence for the **Verify** stage of Runmill's delivery loop.

## Portable signed-bundle verification

A verifier host can check a delivered signed evidence bundle without a Runmill
database, control socket, provider credential, or repository checkout:

```bash
runmill evidence verify evidence.json \
  --trust trusted-signers.json \
  --expectations candidate-facts.json \
  --artifacts-dir /var/lib/runmill/evidence-cas
```

The trust document uses `runmill.asf-evidence-trust/v1` and contains exactly one
or more Ed25519 public keys with bounded validity windows. Delivery-bundle facts
use `runmill.asf-evidence-expectations/v1`; they are authoritative candidate,
policy, check, review, and pull-request observations rather than claims copied
from the signed statement. The command validates the schema, canonical digest,
signature, exact candidate bindings, required evidence, and content-addressed
artifact references. Supplying `--artifacts-dir` additionally re-hashes every
referenced CAS body with bounded byte and aggregate limits.

Terminal cleanup bundles use `runmill.asf-terminal-evidence-expectations/v1`.
They verify the terminal event chain, cleanup observation, provider-budget
ledger, and side-effect ledger; terminal bundles do not have a portable artifact
manifest, so `--artifacts-dir` is refused for them. A malformed or contradictory
bundle exits non-zero and never becomes an authority decision.

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
| `repository-policy` | `.runmill/checks.yaml`, read from the **base** commit, plus `verification.commands` in the operator policy | Authoritative |
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
| Operator `policy.yaml` | Autonomy, budgets, risk rules | Outside the repository, where an inbound pull request cannot reach it |

Both contribute checks and are unioned by id. On a conflict, the operator definition wins.
Repository content may add a requirement, but it cannot replace a command or evidence rule chosen
outside the repository. A manifest that exists but does not parse is a hard failure
([`RM-VERIFY-004`](./errors.md#rm-verify-004)): *unreadable* must never quietly become *no checks
required*.

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

Checks do not run in the agent's workspace. Every check gets a fresh **detached checkout of the
candidate commit**:

```ts
const verifyPath = await workspaces.createVerificationCheckout(workspace, candidateSha);
```

and hashes the tree on both sides of every check:

```ts
const before = await workspaces.treeHash(verifyWorkspace);
const outcome = await this.#sandbox.run({ ... });
// Parse and remove the declared, newly generated report artifact.
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

The checkout is destroyed after that invocation. A check that mutates its tree therefore cannot
contaminate the next check.

### Dependencies without a networked verification bootstrap

A detached Git checkout correctly omits ignored directories such as `node_modules`. Running the
usual Node checks there without preparing dependencies makes every otherwise normal `npm test`
fail before it discovers a test.

The developer-preview path supports locked npm projects without giving repository code an install
hook or network access:

1. The operator runs `npm ci` in the source checkout explicitly.
2. `runmill init` and `runmill doctor --check verification:dependencies` freshly fetch the
   configured remote base, load repository check policy at that same SHA, and compare its exact
   lockfiles with that install. They fail before an issue is claimed when the checkout is ahead,
   behind, missing dependencies, or stale. This proof does not copy packages, warm Runmill's cache,
   run npm, or contact a registry.
3. Before agent work starts, Runmill requires that checkout's `package.json`, `package-lock.json`,
   installed package inventory, platform, architecture, and Node ABI to match the exact trusted
   base.
4. Runmill imports the installed bytes into a machine-local, content-keyed cache and records a
   full tree fingerprint. Reuse verifies the receipt and every cached byte.
5. Each detached verification checkout receives a hard-linked view of that exact `node_modules`
   tree on Runmill's machine-local state filesystem. Files are not copied again for every fix
   iteration, and the sandbox overlays the whole nested tree read-only alongside `.git`.

No package-manager command or repository-controlled bootstrap string runs in verification, and the
verification sandbox has no network. `node_modules/` must be ignored so this verification-only
input cannot enter the measured candidate tree. A missing install, a stale local lockfile, a
changed candidate lockfile, a mutated cache, an unignored dependency directory, or an npm workspace link fails with
[`RM-VERIFY-005`](./errors.md#rm-verify-005). Update the source checkout, run `npm ci`, and start a
fresh delivery run. Other package managers need an operator-declared preparation strategy in a
future release; Runmill does not guess one.

Checks run in the [sandbox](./sandbox.md) with network disabled and the entire verification
checkout read-only. The checkout, `.git`, and prepared `node_modules` are readable but cannot be
changed. This matters even with before/after hashes: hostile test code could otherwise edit source,
generate a passing report, and restore the original bytes before the second hash.

A declared report is the one permitted ephemeral artifact. It must not exist before the command,
must resolve inside the checkout, and must be a regular file in one of the supported formats.
Runmill safely creates any missing parent directories, pre-creates an empty report file, and grants
the sandbox write access to that exact file only. The reporter must overwrite it; a reporter that
requires ownership of the output directory is unsupported and fails closed. Runmill parses and
removes the report before the post-check hash. Test-runner scratch data belongs in the private,
writable `TMPDIR` provided to each invocation.

Report-producing checks run twice: first in a fresh checkout of `workspace.baseCommit`, then in a
fresh checkout of the candidate. Both runs use the same command, timeout, sandbox, network denial,
read-only `.git`, read-only prepared dependencies, report validation, and before/after tree hash.
The baseline must produce a valid, non-mutating inventory. Missing, malformed, stale, duplicate-id,
focused, zero-test, timed-out, or mutating baseline evidence fails closed. A nonzero baseline exit
is allowed when its report is valid: failed baseline tests do not establish preservation authority,
but the tests the report says passed still do.

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

**Skipped or missing tests.**

Runmill compares exact identities, never counts. Every test that passed at the base must still be
present and not skipped at the candidate. The only exception is an exact `test_id` declared under
that same check:

```yaml
checks:
  - id: unit
    run: npm test -- --reporter=tap
    report:
      path: reports/unit.tap
      format: tap
    declared_skips:
      - test_id: "flaky network integration"
        cause: "requires a live staging endpoint; tracked in ENG-88"
```

The observed exception set must equal the declaration set. Declaring A cannot authorize B; a
stale declaration for a test that now passes also fails. Empty and duplicate ids are invalid, and
declarations on a check without a report are rejected because summary text cannot identify tests.
This is [`RM-VERIFY-003`](./errors.md#rm-verify-003).

Canonical ids come from the report:

| Format | `test_id` |
|---|---|
| JUnit | `classname::name`, or `name` when `classname` is absent |
| TAP | The non-empty description after `ok` / `not ok` and the optional result number |
| Go JSON | `Package::Test` from the completed test event |

Every id must be unique within the report. TAP evidence must use one flat plan with a non-empty,
unique description for each point; nested plans are rejected rather than guessed. TAP `SKIP` and
`TODO` directives both count as skipped. Go package summaries have no `Test` field and are not test
identities. JUnit accepts a deliberately strict XML subset and rejects DTD/entity declarations.

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
report upgrades this from an absence of bad news only when the command creates the file and Runmill
can parse it:

```yaml
checks:
  - id: unit
    run: npm test -- --reporter=junit --outputFile=reports/unit.xml
    report:
      path: reports/unit.xml
      format: junit
```

Supported formats are `junit`, `tap`, and `go-json`. A generic JSON object has no standard test
semantics and is rejected rather than guessed. A missing, pre-existing, empty, malformed,
duplicate-id, unsupported, or escaping candidate report is `unproven`; when a report was declared,
it also prevents the base-to-candidate inventory comparison and fails the check.

When omitted, `verification.fail_on_skipped_check` defaults to `true`, and an `unproven` required
result blocks merge-readiness. A freshly generated `pr-only` policy sets it to `false`: the starter
manifest can run portable commands, but cannot guess each test framework's reporter flags, and a
person still owns the merge. Add newly generated reports and set the gate to `true` before moving
to automatic merge; `guarded-merge` and `continuous` are rejected without it. Setting it to
`false` never turns observed zero-test, focused, identity-free skip, or baseline-inventory failure
into a pass.

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
const lacksRequiredProof = failOnSkippedCheck &&
  results.some((r) => r.required && r.coverage !== "proven");
return { mergeReady: !anyFailed && !lacksRequiredProof && failures.length === 0, results, failures };
```

All three conditions are required. `results` covers checks that ran and failed; the proof gate
covers required checks whose coverage is still `unproven`; and `failures` covers checks that never
ran, produced no result, or had no runnable command. A missing check is not a passing check.

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
