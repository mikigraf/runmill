# The coverage contract

> Implemented in [`src/verification/engine.ts`](../src/verification/engine.ts).

This is where the evidence for the **Verify** stage of Runmill's delivery loop comes from.

## Portable signed-bundle verification

You can check a delivered signed evidence bundle on a separate verifier host. It needs no Runmill
database, control socket, provider credential, or repository checkout:

```bash
runmill evidence verify evidence.json \
  --trust trusted-signers.json \
  --expectations candidate-facts.json \
  --artifacts-dir /var/lib/runmill/evidence-cas
```

The trust document uses `runmill.asf-evidence-trust/v1` and holds one or more Ed25519 public keys,
each with a bounded validity window. Delivery-bundle facts use
`runmill.asf-evidence-expectations/v1`. They are authoritative observations of the candidate,
policy, checks, review, and pull request; they are not claims copied out of the signed statement.
The command validates the schema, canonical digest, signature, exact candidate bindings, required
evidence, and content-addressed artifact references. With `--artifacts-dir`, it also re-hashes
every referenced CAS body, within bounded per-body and aggregate byte limits.

Terminal cleanup bundles use `runmill.asf-terminal-evidence-expectations/v1`. They verify the
terminal event chain, the cleanup observation, the provider-budget ledger, and the side-effect
ledger. Terminal bundles have no portable artifact manifest, so `--artifacts-dir` is refused for
them. A malformed or contradictory bundle exits non-zero and never becomes an authority decision.

Most automation treats a green command as proof. It isn't. A command that exits 0 answers one
question, *did this process end well?*, and merge-readiness depends on four:

| | Question | How a green command fails it |
|---|---|---|
| **Discovery** | Which checks are required for *this* change? | It ran the checks someone remembered to list |
| **Coverage** | Were all of them actually invoked? | A check that never ran cannot fail |
| **Freshness** | Did they run against the exact commit being merged? | It tested a tree that no longer exists |
| **Outcome** | Did they complete without a prohibited skip? | `0 tests found` also exits 0 |

runmill answers all four and records the evidence. If a check's result can't be tied to a specific
commit, a specific command, and a tree that didn't move, it isn't evidence.

---

## 1. Discovery — resolving the manifest

`resolveManifest()` builds the required set from four sources:

| Source | Origin | Trust |
|---|---|---|
| `repository-policy` | `.runmill/checks.yaml`, read from the **base** commit, plus `verification.commands` in the operator policy | Authoritative |
| `changed-path` | Path rules (touching `migrations/` adds the migration check) | Authoritative |
| `github` | Contexts required by branch protection | Authoritative, remote-observed |
| `agent` | The coding agent proposing additional checks | Advisory, additive only |

Two properties make this safe.

**The union is monotonic.** An agent can *add* checks. Nothing it does removes one. If a change
could shrink its own required set, it could always shrink it to nothing.

**An agent proposes an identifier, never a command.** Proposals are looked up in the configured
set. An identifier that isn't already configured is ignored and never executed:

```ts
const known = input.configured.find((c) => c.id === id);
if (known === undefined) return;   // unknown identifiers are ignored, never executed
```

Only the orchestrator runs check commands. If the agent could supply the string, the check runner
would be a remote-code-execution primitive pointed at your machine.

Checks sourced from `github` go into the manifest with an empty command. They can't be run
locally; [CI reconciliation](#remote-checks) satisfies them instead.

> **Repository policy is read from the base commit.** A pull request that edits
> `.runmill/checks.yaml` cannot relax the checks that govern its own merge. A change is judged by
> the rules that existed before it. If the manifest is *new* in the change, Runmill falls back to
> the working tree. That is safe because the union is monotonic: a new manifest can only add.
>
> Where the manifest was read from is recorded on the run (`readFrom: "base-ref" | "working-tree"`).

The two files are split by ownership:

| File | Declares | Lives |
|---|---|---|
| `.runmill/checks.yaml` | Which checks this repository requires | In the repository, versioned and reviewed with the code |
| Operator `policy.yaml` | Autonomy, budgets, risk rules | Outside the repository, where an inbound pull request cannot reach it |

Both contribute checks, unioned by id. On a conflict the operator definition wins. Repository
content can add a requirement, but it can't replace a command or evidence rule chosen outside the
repository. A manifest that exists but doesn't parse is a hard failure
([`RM-VERIFY-004`](./errors.md#rm-verify-004)). *Unreadable* must never quietly turn into *no checks
required*.

## 2. Coverage — proving each one ran

After execution, every required, locally executable check must have produced a result:

```ts
for (const spec of manifest) {
  if (spec.source === "github" || !spec.required) continue;
  if (!results.some((r) => r.checkId === spec.id)) {
    failures.push(`required check "${spec.id}" produced no result`);
  }
}
```

This is a separate pass on purpose. "No check failed" and "every check ran" are different
statements, and only the second is worth anything. A manifest of ten checks where two never ran
produces zero failures, and it is not merge-ready.

A required check with no runnable command and no remote result raises
[`RM-VERIFY-001`](./errors.md#rm-verify-001). It is not skipped.

### Who ran it counts

Every recorded result carries an `executor`:

```ts
// Checks the agent ran during implementation are advisory telemetry.
// Merge-readiness only ever counts the orchestrator's own execution.
executor: "orchestrator",
```

The agent runs tests while it works. That's a useful signal, but it isn't evidence: it happened in
the agent's workspace, under the agent's control, at whatever commit the agent had at the time.
Merge-readiness counts only checks the orchestrator ran itself.

## 3. Freshness — pinning the result to a commit

Checks don't run in the agent's workspace. Each one gets a fresh **detached checkout of the
candidate commit**:

```ts
const verifyPath = await workspaces.createVerificationCheckout(workspace, candidateSha);
```

and the tree is hashed on both sides of every check:

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

If the tree moved, the result doesn't describe the candidate commit. It describes something else
that existed briefly. That is [`RM-VERIFY-002`](./errors.md#rm-verify-002).

The same mechanism catches the honest cases (a check that regenerates a lockfile, a formatter left
on `--write`) and the dishonest ones (a test that rewrites a fixture until it passes), because it
doesn't care *why* the tree moved.

The checkout is destroyed after that invocation, so a check that mutates its tree can't contaminate
the next one.

### Dependencies without a networked verification bootstrap

A detached Git checkout correctly leaves out ignored directories such as `node_modules`. Run the
usual Node checks there without preparing dependencies and every otherwise normal `npm test` fails
before it finds a single test.

The developer-preview path supports locked npm projects without giving repository code an install
hook or network access:

1. The operator runs `npm ci` in the source checkout explicitly.
2. `runmill init` and `runmill doctor --check verification:dependencies` freshly fetch the
   configured remote base, load repository check policy at that same SHA, and compare its exact
   lockfiles with that install. If the checkout is ahead, behind, missing dependencies, or stale,
   they fail before an issue is claimed. This proof does not copy packages, warm Runmill's cache,
   run npm, or contact a registry.
3. Before agent work starts, Runmill requires that checkout's `package.json`, `package-lock.json`,
   installed package inventory, platform, architecture, and Node ABI to match the exact trusted
   base.
4. Runmill imports the installed bytes into a machine-local, content-keyed cache and records a
   full tree fingerprint. Reuse verifies the receipt and every cached byte.
5. Each detached verification checkout gets a hard-linked view of that exact `node_modules` tree
   on Runmill's machine-local state filesystem. Files aren't copied again on every fix iteration,
   and the sandbox overlays the whole nested tree read-only alongside `.git`.

No package-manager command or repository-controlled bootstrap string runs during verification, and
the verification sandbox has no network. `node_modules/` must be ignored so this verification-only
input can't enter the measured candidate tree. Any of these fails with
[`RM-VERIFY-005`](./errors.md#rm-verify-005): a missing install, a stale local lockfile, a changed
candidate lockfile, a mutated cache, an unignored dependency directory, or an npm workspace link.
To recover, update the source checkout, run `npm ci`, and start a fresh delivery run. Other package
managers will need an operator-declared preparation strategy in a future release. Runmill does not
guess one.

Checks run in the [sandbox](./sandbox.md) with network disabled and the whole verification checkout
read-only. The checkout, `.git`, and prepared `node_modules` can be read but not changed. This
matters even with before/after hashes. Otherwise, hostile test code could edit source, generate a
passing report, and restore the original bytes before the second hash.

A declared report is the one ephemeral artifact allowed. It must not exist before the command runs,
it must resolve inside the checkout, and it must be a regular file in a supported format. Runmill
safely creates any missing parent directories, pre-creates an empty report file, and gives the
sandbox write access to that exact file and nothing else. The reporter has to overwrite it. A
reporter that needs to own the output directory is unsupported and fails closed. Runmill parses
and removes the report before the post-check hash. Test-runner scratch data belongs in the private,
writable `TMPDIR` each invocation gets.

Report-producing checks run twice: first in a fresh checkout of `workspace.baseCommit`, then in a
fresh checkout of the candidate. Both runs use the same command, timeout, sandbox, network denial,
read-only `.git`, read-only prepared dependencies, report validation, and before/after tree hash.
The baseline has to produce a valid, non-mutating inventory. Baseline evidence that is missing,
malformed, stale, has duplicate ids, is focused, has zero tests, timed out, or mutated the tree
fails closed. A nonzero baseline exit is allowed if its report is valid. Failed baseline tests
don't establish preservation authority, but the tests the report says passed still do.

## 4. Outcome — what "passed" excludes

Exit code 0 is necessary and nowhere near sufficient. Any of three further conditions turns a green
exit into a failure.

**Zero tests discovered.**

```ts
if (status === "passed" && detectZeroTests(combined)) {
  status = "failed";
  coverage = "unproven";
}
```

This matches `no tests found`, `0 tests`, `0 passed`, and `passWithNoTests`. It is the nastiest
false green there is. A misconfigured path filter or a renamed directory produces output that is
character-for-character as reassuring as a full pass. Every framework will happily report total
success for having done nothing.

**Focused execution.** `.only(`, `fit(`, `fdescribe(`. A `.only` left in a test file quietly cuts
the suite down to one case and still exits 0. The whole suite didn't run, so the suite didn't pass.

**Skipped or missing tests.**

Runmill compares exact identities, never counts. Every test that passed at the base must still be
present, and not skipped, at the candidate. The only exception is an exact `test_id` declared under
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

The observed set of exceptions must equal the declared set. Declaring A can't authorize B, and a
stale declaration for a test that now passes also fails. Empty and duplicate ids are invalid.
Declarations on a check without a report are rejected, because summary text can't identify tests.
This is [`RM-VERIFY-003`](./errors.md#rm-verify-003).

Canonical ids come from the report:

| Format | `test_id` |
|---|---|
| JUnit | `classname::name`, or `name` when `classname` is absent |
| TAP | The non-empty description after `ok` / `not ok` and the optional result number |
| Go JSON | `Package::Test` from the completed test event |

Every id must be unique within the report. TAP evidence must use one flat plan with a non-empty,
unique description for each point. Nested plans are rejected rather than guessed at. TAP `SKIP` and
`TODO` directives both count as skipped. Go package summaries have no `Test` field and aren't test
identities. JUnit accepts a deliberately strict XML subset and rejects DTD/entity declarations.

**Timeouts** count as failures. They are not unknowns.

### `proven` vs `unproven` coverage

A check that passes without a machine-readable report is marked `coverage: "unproven"`:

```ts
if (spec.report === undefined) {
  coverage = "unproven";
  notes.push("no machine-readable report declared; coverage unproven");
}
```

All the engine did was parse stdout and find nothing alarming. It couldn't confirm *what* ran.
Declaring a report upgrades the result from an absence of bad news, but only when the command
creates the file and Runmill can parse it:

```yaml
checks:
  - id: unit
    run: npm test -- --reporter=junit --outputFile=reports/unit.xml
    report:
      path: reports/unit.xml
      format: junit
```

Supported formats are `junit`, `tap`, and `go-json`. A generic JSON object has no standard test
semantics, so it's rejected rather than guessed at. A candidate report that is missing,
pre-existing, empty, malformed, has duplicate ids, is unsupported, or escapes the checkout is
`unproven`. If a report was declared, that also blocks the base-to-candidate inventory comparison
and fails the check.

When omitted, `verification.fail_on_skipped_check` defaults to `true`, and an `unproven` required
result blocks merge-readiness. A freshly generated `pr-only` policy sets it to `false`. The starter
manifest can run portable commands, but it can't guess every test framework's reporter flags, and a
person still owns the merge. Add newly generated reports and set the gate to `true` before you move
to automatic merge; `guarded-merge` and `continuous` are rejected without it. Setting it to `false`
never turns an observed zero-test run, focused run, identity-free skip, or baseline-inventory
failure into a pass.

<a id="remote-checks"></a>

## Remote checks

Checks that GitHub runs are reconciled instead of executed; see
[`src/pr/reconcile.ts`](../src/pr/reconcile.ts). Two rules matter.

- **`neutral` and `skipped` are not coverage.** A required check that reports `skipped` hasn't
  passed. It hasn't run. GitHub's own merge gating counts these as satisfied. runmill doesn't.
- **A required context that never gets scheduled is a failure.** Runmill doesn't wait on it
  indefinitely. After 10 minutes with no run scheduled, the run escalates with
  [`RM-CI-002`](./errors.md#rm-ci-002). A workflow whose trigger doesn't match the branch will
  never report, and waiting on it looks exactly like hanging.

## The final verdict

```ts
const anyFailed = results.some((r) => r.status === "failed");
const lacksRequiredProof = failOnSkippedCheck &&
  results.some((r) => r.required && r.coverage !== "proven");
return { mergeReady: !anyFailed && !lacksRequiredProof && failures.length === 0, results, failures };
```

All three conditions must hold. `results` covers checks that ran and failed. The proof gate covers
required checks whose coverage is still `unproven`. `failures` covers checks that never ran,
produced no result, or had no runnable command. A missing check is not a passing check.

## Reading the evidence

```bash
runmill inspect <run-id>
```

Every check result records the command, the commit, the tree hash before and after, the executor,
the exit code, the duration, and a hash of stdout. If a merge is ever questioned, this is the record
of what was actually proven, and by whom.

## See also

- [Autonomy and merge gates](./autonomy.md): where verification sits among the seven gates
- [The sandbox](./sandbox.md): the isolation checks run under
- [Errors](./errors.md): `RM-VERIFY-001`, `RM-VERIFY-002`, `RM-VERIFY-003`, `RM-CI-002`
