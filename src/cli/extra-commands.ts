import { Command, Option } from "commander";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SCHEMA_FILENAME, writeSchemaBeside } from "../config/schema-asset.js";
import { createConfiguration, type DiscoveredSetup } from "../config/create.js";
import { RunmillError, errorMessage } from "../errors/runmill-error.js";
import { CredentialStore, type CredentialName } from "../credentials/store.js";
import { StateStore } from "../state/store.js";
import { recordDoctorFailure, recordMilestone } from "../state/funnel.js";
import {
  SKILL_FILES,
  starterChecksForRepository,
  validateSkill,
} from "../review/default-skills.js";
import { assessReadiness, renderReadiness } from "../queue/readiness.js";
import { buildAdapters, resolveReviewerAgent } from "../factory.js";
import { loadConfig } from "../config/load.js";
import { run as runProcess } from "../platform/process.js";
import { tryGit } from "../platform/git.js";
import { leaseRefName } from "../queue/git-lease.js";
import {
  runAllChecks,
  checkVerificationDependencies,
  checkVerificationPolicy,
  worstStatus,
  type CheckResult,
  type ProviderCheckTarget,
} from "../doctor/checks.js";
import { renderDoctor } from "./render.js";

export interface InitDoctorInput {
  readonly repoRoot: string;
  readonly configPath: string;
}

export interface CommandContext {
  readonly emit: (human: string, data: unknown) => void;
  readonly fail: (err: unknown) => never;
  readonly dataDir: () => string;
  readonly configPath: () => string;
  readonly repoRoot: () => string;
  readonly exitCodes: {
    ok: number;
    failed: number;
    configInvalid: number;
    blocked: number;
  };
  /** Injectable so init's file semantics can be tested without probing host CLIs or accounts. */
  readonly createConfiguration?: typeof createConfiguration | undefined;
  /** Tests inject readiness results; production runs the complete doctor suite. */
  readonly runDoctor?:
    | ((input: InitDoctorInput) => Promise<readonly CheckResult[]>)
    | undefined;
  /** Credential command seams keep tests away from the real OS keychain/stdin. */
  readonly credentialStore?:
    | Pick<CredentialStore, "get" | "set" | "remove">
    | undefined;
  readonly readStdin?: (() => string | Promise<string>) | undefined;
  readonly stdinIsTTY?: (() => boolean) | undefined;
}

const CREDENTIAL_NAMES: readonly CredentialName[] = [
  "linear",
  "github",
  "runmill-policy",
];

async function readCredentialStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

function isCredentialName(value: string): value is CredentialName {
  return (CREDENTIAL_NAMES as readonly string[]).includes(value);
}

/**
 * Everything a developer is told to run must exist.
 *
 * These commands were added because the error catalog cited them: an audit
 * found 8 of 19 error codes whose only remedy was a command that had never
 * been implemented. `test/cli/contract.test.ts` now fails if that drifts again.
 */
export function registerExtraCommands(
  program: Command,
  ctx: CommandContext,
): void {
  registerInit(program, ctx);
  registerAuth(program, ctx);
  registerInspect(program, ctx);
  registerEffects(program, ctx);
  registerLeases(program, ctx);
  registerResume(program, ctx);
  registerPolicy(program, ctx);
  registerPrepare(program, ctx);
  registerSkills(program, ctx);
  registerFeedback(program, ctx);
  registerGc(program, ctx);
}

// -- interrupted lease recovery -------------------------------------------

function registerLeases(program: Command, ctx: CommandContext): void {
  const leases = program
    .command("leases")
    .description(
      "Inspect and manually reconcile leases left by an interrupted process",
    );

  leases
    .command("list")
    .description("List leases that still block local issue selection")
    .action(() => {
      const store = StateStore.open(join(ctx.dataDir(), "runmill.db"));
      try {
        const active = [...store.activeLeaseIssueIds()]
          .map((issueId) => store.getLease(issueId))
          .filter((lease) => lease !== undefined);
        ctx.emit(
          active.length === 0
            ? "Active local leases: (none)"
            : [
                "Active local leases:",
                ...active.map(
                  (lease) =>
                    `  ${lease.issueId}  run=${lease.runId} generation=${lease.generation} ` +
                    `expires=${lease.expiresAt}`,
                ),
              ].join("\n"),
          { active },
        );
      } finally {
        store.close();
      }
    });

  leases
    .command("resolve")
    .argument("<issue>", "issue identifier shown by `runmill leases list`")
    .requiredOption(
      "--confirm-remote-cleared",
      "confirm the worker is dead and the backlog ownership was restored",
    )
    .description("Clear a local lease row only after its remote ref is absent")
    .action(async (issueId: string) => {
      const store = StateStore.open(join(ctx.dataDir(), "runmill.db"));
      try {
        const lease = store.getLease(issueId);
        if (lease === undefined)
          ctx.fail(new Error(`no active local lease for ${issueId}`));

        const remote = await tryGit(ctx.repoRoot(), [
          "ls-remote",
          "origin",
          leaseRefName(issueId),
        ]);
        if (!remote.ok) {
          ctx.fail(
            new Error(
              `could not prove the remote lease state for ${issueId}: ` +
                `${remote.stderr.trim() || "git ls-remote failed"}`,
            ),
          );
        }
        if (remote.stdout.trim() !== "") {
          ctx.fail(
            new Error(
              `remote lease ${leaseRefName(issueId)} still exists; refuse to clear the local fence. ` +
                `Verify the worker is dead, restore the backlog state/assignee, then delete that ` +
                `exact ref before retrying.`,
            ),
          );
        }

        store.releaseLease(issueId, lease.runId);
        ctx.emit(
          `Cleared the local lease for ${issueId}; the remote ref was absent.`,
          { resolved: true, issueId, runId: lease.runId },
        );
      } catch (err) {
        ctx.fail(err);
      } finally {
        store.close();
      }
    });
}

// -- external-effect reconciliation ---------------------------------------

function registerEffects(program: Command, ctx: CommandContext): void {
  const effects = program
    .command("effects")
    .description("Inspect and explicitly reconcile ambiguous external effects");

  effects
    .command("list")
    .description("List effects that block new delivery runs")
    .action(() => {
      const store = StateStore.open(join(ctx.dataDir(), "runmill.db"));
      try {
        const pending = store.pendingSideEffects();
        ctx.emit(
          pending.length === 0
            ? "Pending external effects: (none)"
            : [
                "Pending external effects (verify each outcome in the named remote system):",
                ...pending.map(
                  (effect) =>
                    `  ${effect.key}  ${effect.status.padEnd(9)} ${effect.system} ` +
                    `${effect.operation} → ${effect.target}`,
                ),
              ].join("\n"),
          { pending },
        );
      } finally {
        store.close();
      }
    });

  effects
    .command("resolve")
    .argument("<key>", "side-effect key shown by `runmill effects list`")
    .requiredOption(
      "--outcome <outcome>",
      "outcome you verified in the remote system: applied or not-applied",
    )
    .description("Record a human-verified outcome and unblock future runs")
    .action((key: string, opts: { outcome: string }) => {
      if (opts.outcome !== "applied" && opts.outcome !== "not-applied") {
        ctx.fail(new Error("--outcome must be either applied or not-applied"));
      }

      const store = StateStore.open(join(ctx.dataDir(), "runmill.db"));
      try {
        const effect = store.getSideEffect(key);
        if (effect === undefined)
          ctx.fail(new Error(`side effect ${key} does not exist`));
        store.resolveSideEffect(key, opts.outcome);
        ctx.emit(
          `Resolved ${key} as ${opts.outcome}. New delivery runs are allowed only when no other ` +
            `effects remain pending.`,
          { resolved: true, key, outcome: opts.outcome },
        );
      } catch (err) {
        ctx.fail(err);
      } finally {
        store.close();
      }
    });
}

// -- gc --------------------------------------------------------------------

/** Run states after which a workspace is no longer needed. */
const TERMINAL_STATES = new Set([
  "COMPLETED",
  "PR_DELIVERED",
  "NEEDS_HUMAN",
  "QUARANTINED",
  "AWAITING_APPROVAL",
  "ABORTED",
]);

/**
 * Reconcile workspaces left behind by crashed runs.
 *
 * This command existed only as advice: WorkspaceManager tells a developer to
 * "run `runmill gc` to reconcile" when a workspace directory is already there,
 * and no such command had been written. That advice arrives at the worst
 * possible moment — right after a crash — and sent them looking for something
 * that was never real.
 *
 * Deliberately conservative: a workspace whose run is still in flight is
 * reported, never removed. A live run's working tree is the only copy of work
 * in progress, and deleting it to tidy up is not a trade worth making.
 */
function registerGc(program: Command, ctx: CommandContext): void {
  program
    .command("gc")
    .description(
      "Reconcile workspaces and worktrees left behind by crashed runs",
    )
    .option("--dry-run", "report what would be removed, and remove nothing")
    .action(async (cmdOpts: { dryRun?: boolean }) => {
      const dry = cmdOpts.dryRun === true;
      const runsRoot = join(ctx.dataDir(), "runs");
      const store = StateStore.open(join(ctx.dataDir(), "runmill.db"));

      try {
        const byId = new Map(store.listRuns(1000).map((r) => [r.runId, r]));
        const removed: string[] = [];
        const kept: { path: string; reason: string }[] = [];

        // `git worktree prune` clears verification checkouts whose directories
        // are already gone. Safe regardless of run state.
        const pruned = await tryGit(ctx.repoRoot(), ["worktree", "prune"]);

        const entries = existsSync(runsRoot)
          ? readdirSync(runsRoot, { withFileTypes: true }).filter((e) =>
              e.isDirectory(),
            )
          : [];

        for (const entry of entries) {
          const path = join(runsRoot, entry.name);
          // Verification checkouts are named <run>-verify-<sha> and belong to
          // whichever run owns the prefix.
          const runId = entry.name.split("-verify-")[0] ?? entry.name;
          const row = byId.get(runId);

          if (row === undefined) {
            // No record at all: the database was reset or the run never got
            // far enough to be recorded. Nothing can resume it.
            if (!dry) rmSync(path, { recursive: true, force: true });
            removed.push(path);
            continue;
          }
          if (TERMINAL_STATES.has(row.state)) {
            if (!dry) rmSync(path, { recursive: true, force: true });
            removed.push(path);
            continue;
          }
          kept.push({ path, reason: `run ${runId} is still in ${row.state}` });
        }

        const lines = [
          dry
            ? `Would remove ${removed.length} workspace(s):`
            : `Removed ${removed.length} workspace(s):`,
          ...removed.map((p) => `  ${p}`),
          ...(removed.length === 0 ? ["  (none)"] : []),
        ];
        if (kept.length > 0) {
          lines.push(
            "",
            `Kept ${kept.length} — a live run's working tree is the only copy of it:`,
          );
          for (const k of kept) lines.push(`  ${k.path}\n    ${k.reason}`);
        }
        if (!pruned.ok) {
          lines.push(
            "",
            `  note: git worktree prune did not run (${ctx.repoRoot()} may not be a repository)`,
          );
        }

        ctx.emit(lines.join("\n"), {
          dryRun: dry,
          removed,
          kept,
          worktreePruned: pruned.ok,
        });
        process.exit(ctx.exitCodes.ok);
      } finally {
        store.close();
      }
    });
}

// -- init ------------------------------------------------------------------

/** Repository-owned files stay versioned; mutable state lives outside the repo. */
const RUNTIME_GITIGNORE = `# runmill runtime state. Machine-local, changes every run.
state/
workspaces/

# Everything else here is project configuration, and is tracked on purpose.
`;

async function runDoctorAfterInit(
  input: InitDoctorInput,
): Promise<readonly CheckResult[]> {
  let backlogProvider = "linear" as const;
  let providers: readonly ProviderCheckTarget[] = [];
  try {
    const config = loadConfig(input.configPath, {
      repoRoot: input.repoRoot,
    }).config;
    backlogProvider = config.backlog.provider;
    providers = [config.providers.implementer, resolveReviewerAgent(config)];
  } catch {
    // checkConfiguration below owns the actionable parse error. Do not spend a
    // provider turn against a guessed default when the written policy cannot
    // tell us which configured model to probe.
  }
  return runAllChecks(
    {
      repoRoot: input.repoRoot,
      configPath: input.configPath,
      backlogProvider,
    },
    providers,
  );
}

function registerInit(program: Command, ctx: CommandContext): void {
  program
    .command("init")
    .description(
      "Configure Runmill and add any missing project checks and review skills",
    )
    .option(
      "--defaults",
      "accept discovered values and sane defaults without prompting",
    )
    .action(async (opts: { defaults?: boolean }) => {
      try {
        const root = ctx.repoRoot();
        const configPath = ctx.configPath();
        const created: string[] = [];
        const preserved: string[] = [];
        let discovered: DiscoveredSetup | undefined;

        // The operator policy is the only interactive part of setup. Never
        // recreate it: re-running init is how missing repository assets are
        // repaired, not a way to reset authority or credentials.
        if (existsSync(configPath)) {
          preserved.push(configPath);
          const schemaPath = join(dirname(configPath), SCHEMA_FILENAME);
          if (writeSchemaBeside(configPath)) created.push(schemaPath);
          else if (existsSync(schemaPath)) preserved.push(schemaPath);
        } else {
          const result = await (ctx.createConfiguration ?? createConfiguration)(
            {
              root,
              path: configPath,
              // Piped and CI invocations cannot answer questions. Interactive
              // terminals get discovery with preselected answers by default.
              defaults: opts.defaults === true || process.stdin.isTTY !== true,
            },
          );
          discovered = result.discovered;
          created.push(result.path);
          const schemaPath = join(dirname(result.path), SCHEMA_FILENAME);
          if (existsSync(schemaPath)) created.push(schemaPath);
        }

        const write = (relative: string, content: string): void => {
          const path = join(root, relative);
          if (existsSync(path)) {
            preserved.push(path);
            return;
          }
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, content);
          created.push(path);
        };

        write(".runmill/checks.yaml", starterChecksForRepository(root).content);
        write(".runmill/.gitignore", RUNTIME_GITIGNORE);
        for (const skill of SKILL_FILES) write(skill.path, skill.content);
        recordMilestone(ctx.dataDir(), "init_completed_at", new Date());

        // Setup is not complete merely because files were written. Run the
        // same proof as `runmill doctor` now, including a one-turn request for
        // every distinct configured provider/model inside the real sandbox.
        const probed = await (ctx.runDoctor ?? runDoctorAfterInit)({
          repoRoot: root,
          configPath,
        });
        // Test seams and custom embedders may supply only host/provider
        // probes. Verification readiness is local, deterministic, and must
        // never disappear from init merely because those probes are injected.
        const probedIds = new Set(probed.map((result) => result.id));
        const localVerification = await Promise.all([
          ...(probedIds.has("verification")
            ? []
            : [Promise.resolve(checkVerificationPolicy({ repoRoot: root, configPath }))]),
          ...(probedIds.has("verification:dependencies")
            ? []
            : [
                checkVerificationDependencies({
                  repoRoot: root,
                  // Production's full doctor result already contains the
                  // exact-remote dependency proof. An injected partial doctor
                  // is a test/embedder seam; keep its mandatory fallback
                  // deterministic and local rather than silently networking.
                  ...(ctx.runDoctor === undefined ? { configPath } : {}),
                }),
              ]),
        ]);
        const doctorResults = [
          ...probed,
          ...localVerification,
        ];
        const doctorStatus = worstStatus(doctorResults);
        recordMilestone(ctx.dataDir(), "first_doctor_run_at", new Date());
        for (const result of doctorResults) {
          if (result.status === "fail" && result.code !== undefined) {
            recordDoctorFailure(ctx.dataDir(), result.code);
          }
        }
        if (doctorStatus !== "fail") {
          recordMilestone(ctx.dataDir(), "first_doctor_pass_at", new Date());
        }

        const relative = (path: string): string =>
          path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
        ctx.emit(
          [
            created.length === 0
              ? "Runmill is already initialized."
              : "Runmill is initialized.",
            "",
            ...(created.length === 0
              ? []
              : [
                  "Created:",
                  ...created.map((path) => `  ${relative(path)}`),
                  "",
                ]),
            ...(preserved.length === 0
              ? []
              : [
                  "Preserved:",
                  ...preserved.map((path) => `  ${relative(path)}`),
                  "",
                ]),
            `Operator policy: ${configPath}`,
            ...(discovered === undefined
              ? []
              : [
                  `GitHub: ${discovered.githubAuthenticated ? "credential found; repository metadata loaded when available" : "not configured; local git defaults used"}`,
                  `Linear: ${discovered.linearCredential ? "authenticated; team options loaded" : "not configured yet"}`,
                ]),
            "",
            "Readiness check:",
            renderDoctor(doctorResults),
            `  overall: ${doctorStatus.toUpperCase()}`,
            "",
            ...(doctorStatus === "fail"
              ? [
                  "Setup files are ready, but Runmill cannot start yet.",
                  "Fix the failed checks above, then rerun `runmill init`.",
                ]
              : [
                  `Review ${configPath}, then:`,
                  "  runmill next    preview the first eligible issue",
                  "  runmill start   begin the delivery loop in the background",
                ]),
          ].join("\n"),
          {
            configPath,
            created,
            preserved,
            discovery: discovered,
            doctor: { overall: doctorStatus, checks: doctorResults },
          },
        );
        if (doctorStatus === "fail") process.exit(ctx.exitCodes.blocked);
      } catch (err) {
        ctx.fail(err);
      }
    });
}

// -- auth ------------------------------------------------------------------

function registerAuth(program: Command, ctx: CommandContext): void {
  const auth = program.command("auth").description("Manage credentials");
  const store = ctx.credentialStore ?? new CredentialStore();

  auth
    .command("status")
    .description("Show which credentials resolve, and from where")
    .action(async () => {
      try {
        const rows = await Promise.all(
          CREDENTIAL_NAMES.map(async (name) => ({
            name,
            resolved: (await store.get(name)) !== undefined,
          })),
        );
        ctx.emit(
          rows
            .map(
              (r) =>
                `  ${r.resolved ? "✓" : "✗"} ${r.name.padEnd(16)} ${r.resolved ? "resolved" : "not found"}`,
            )
            .join("\n"),
          rows,
        );
        process.exit(
          rows.some((r) => !r.resolved) ? ctx.exitCodes.ok : ctx.exitCodes.ok,
        );
      } catch (err) {
        ctx.fail(err);
      }
    });

  auth
    .command("login")
    .argument("<system>", "linear | github | runmill-policy")
    // Recognize the removed form only so Commander cannot reflect a legacy
    // `--token=value` secret in its unknown-option diagnostic. It is hidden,
    // rejected before stdin is read, and never reaches credential storage.
    .addOption(new Option("--token <discarded>").hideHelp())
    .description(
      "Read a credential from stdin and store it in the macOS keychain",
    )
    .action(async (system: string, opts: { token?: string }) => {
      try {
        if (!isCredentialName(system)) {
          throw RunmillError.fromCatalog("RM-AUTH-003", {
            whatHappened: `Unknown credential "${system}". Expected one of: ${CREDENTIAL_NAMES.join(", ")}`,
          });
        }
        if (opts.token !== undefined) {
          throw RunmillError.fromCatalog("RM-AUTH-003", {
            whatHappened:
              "The --token credential option is not accepted because process arguments are public. " +
              "Pass the credential only on redirected stdin.",
          });
        }
        const envName =
          system === "linear"
            ? "LINEAR_API_KEY"
            : system === "github"
              ? "GITHUB_TOKEN"
              : "RUNMILL_POLICY_KEY";
        const safeCommand = `printenv ${envName} | runmill auth login ${system}`;
        if (ctx.stdinIsTTY?.() ?? process.stdin.isTTY === true) {
          throw RunmillError.fromCatalog("RM-AUTH-003", {
            whatHappened:
              "Credential input is accepted only on redirected stdin; Runmill never accepts " +
              "a secret as a command option.\n" +
              `  Pipe an existing environment value without echoing it: ${safeCommand}`,
          });
        }
        const token = (
          ctx.readStdin === undefined
            ? await readCredentialStdin()
            : await ctx.readStdin()
        ).trim();
        if (token === "") {
          throw RunmillError.fromCatalog("RM-AUTH-003", {
            whatHappened:
              "No credential was received on stdin.\n" +
              `  Pipe an existing environment value without echoing it: ${safeCommand}`,
          });
        }
        await store.set(system, token);
        ctx.emit(`Stored ${system} credential in the OS keychain.`, {
          system,
          stored: true,
        });
      } catch (err) {
        ctx.fail(err);
      }
    });

  auth
    .command("logout")
    .argument("<system>", "linear | github | runmill-policy")
    .description("Remove a stored credential")
    .action(async (system: string) => {
      try {
        if (!isCredentialName(system)) {
          throw RunmillError.fromCatalog("RM-AUTH-003", {
            whatHappened: `Unknown credential "${system}".`,
          });
        }
        await store.remove(system);
        ctx.emit(`Removed the ${system} credential.`, {
          system,
          removed: true,
        });
      } catch (err) {
        ctx.fail(err);
      }
    });
}

// -- inspect ---------------------------------------------------------------

function registerInspect(program: Command, ctx: CommandContext): void {
  program
    .command("inspect")
    .argument("<run-id>", "run to inspect")
    .description("Show a run's state, transitions, checks, and pending effects")
    .action((runId: string) => {
      const store = StateStore.open(join(ctx.dataDir(), "runmill.db"));
      try {
        const run = store.getRun(runId);
        if (run === undefined) {
          ctx.emit(
            `No run ${runId}. Run \`runmill list\` to see recent runs.`,
            { found: false },
          );
          process.exit(ctx.exitCodes.ok);
        }

        const transitions = store.transitionHistory(runId);
        const events = store.eventsFor(runId);
        const pending = store
          .pendingSideEffects()
          .filter((e) => e.runId === runId);
        const lease = store.getLease(run.issueId);

        ctx.emit(
          [
            `${run.runId}  ${run.issueId}  ${run.state}`,
            `  repository   ${run.repo}`,
            `  provider     ${run.provider}`,
            `  branch       ${run.branch ?? "-"}`,
            `  base commit  ${run.baseCommit ?? "-"}`,
            `  lease        ${lease === undefined ? "released" : `held, generation ${lease.generation}, expires ${lease.expiresAt}`}`,
            "",
            "  transitions",
            ...transitions.map((t) => `    ${t.at}  ${t.from} → ${t.to}`),
            ...(events.length === 0
              ? []
              : [
                  "",
                  "  events",
                  ...events.map((e) => `    ${e.seq}  ${e.type}`),
                ]),
            ...(pending.length === 0
              ? []
              : [
                  "",
                  "  pending external effects (new runs block until you reconcile these)",
                  ...pending.map(
                    (p) =>
                      `    ${p.status.padEnd(10)} ${p.operation} → ${p.target}`,
                  ),
                ]),
          ].join("\n"),
          { run, transitions, events, pending, lease },
        );
      } finally {
        store.close();
      }
    });
}

// -- resume ----------------------------------------------------------------

function registerResume(program: Command, ctx: CommandContext): void {
  program
    .command("resume")
    .argument("<run-id>", "run whose recovery status to inspect")
    .option(
      "--answer <choice>",
      "deprecated; answers are not replayed in the developer preview",
    )
    .description(
      "Explain safe recovery for a stopped run (checkpoint resume is unavailable)",
    )
    .action((runId: string) => {
      const store = StateStore.open(join(ctx.dataDir(), "runmill.db"));
      try {
        const run = store.getRun(runId);
        if (run === undefined) {
          ctx.emit(
            `No run ${runId}. Run \`runmill list\` to see recent runs.`,
            { resumed: false },
          );
          process.exit(ctx.exitCodes.ok);
        }

        const resumable = new Set([
          "NEEDS_HUMAN",
          "AWAITING_APPROVAL",
          "RETRY_WAIT",
        ]);
        if (!resumable.has(run.state)) {
          ctx.emit(
            `${runId} is ${run.state}, which is not waiting on a human.\n` +
              `  Resumable states: ${[...resumable].join(", ")}`,
            { resumed: false, state: run.state },
          );
          process.exit(ctx.exitCodes.ok);
        }

        ctx.emit(
          `${runId} is ${run.state}, but checkpoint continuation is not implemented in this ` +
            `developer preview. No state was changed.\n` +
            `  Inspect it:     runmill inspect ${runId}\n` +
            `  Reconcile I/O: runmill effects list\n` +
            `  Then return the issue to an eligible state and start a fresh attempt.`,
          { resumed: false, supported: false, runId, state: run.state },
        );
        process.exit(ctx.exitCodes.blocked);
      } finally {
        store.close();
      }
    });
}

// -- policy explain --------------------------------------------------------

function registerPolicy(program: Command, ctx: CommandContext): void {
  const policy = program
    .command("policy")
    .description("Explain policy decisions");

  policy
    .command("explain")
    .argument("<run-id>", "run to explain")
    .description("Explain why a run may or may not merge")
    .action((runId: string) => {
      const store = StateStore.open(join(ctx.dataDir(), "runmill.db"));
      try {
        const run = store.getRun(runId);
        if (run === undefined) {
          ctx.emit(`No run ${runId}.`, { found: false });
          process.exit(ctx.exitCodes.ok);
        }

        const terminal: Record<string, string> = {
          PR_DELIVERED:
            "Delivered a pull request. `pr-only` never merges by design.",
          COMPLETED: "Every gate passed and the change was merged.",
          NEEDS_HUMAN:
            "A gate could not be satisfied deterministically, so it escalated.",
          AWAITING_APPROVAL: "Branch protection requires an approving review.",
          QUARANTINED: "Something happened that policy could not classify.",
        };

        ctx.emit(
          [
            `${runId}  ${run.issueId}  ${run.state}`,
            "",
            `  ${terminal[run.state] ?? "Run is still in progress."}`,
            "",
            "  Gates, in the order they are evaluated:",
            "    1. lease held with the current fencing generation",
            "    2. local checks: discovered, executed, fresh, no undeclared skip",
            "    3. review verdict, cross-checked against risk-escalating paths",
            "    4. branch protection readable (unreadable is refused, not assumed empty)",
            "    5. every required GitHub context satisfied",
            "    6. merge credential provably cannot edit branch protection",
            "    7. autonomy mode permits the classified risk",
            "",
            `  Detail:  runmill inspect ${runId}`,
          ].join("\n"),
          {
            runId,
            state: run.state,
            explanation: terminal[run.state] ?? "in progress",
          },
        );
      } finally {
        store.close();
      }
    });
}

// -- prepare ---------------------------------------------------------------

function registerPrepare(program: Command, ctx: CommandContext): void {
  program
    .command("prepare")
    .argument("<issue>", "issue identifier, e.g. ENG-123")
    .description("Score how ready an issue is to run, and say what is missing")
    .action(async (identifier: string) => {
      try {
        const { config } = loadConfig(ctx.configPath(), {
          repoRoot: ctx.repoRoot(),
        });
        const { backlog } = await buildAdapters(config, { need: ["backlog"] });
        const issue = await backlog.getIssue(identifier);
        if (issue === undefined) {
          ctx.emit(`No issue ${identifier} in the configured backlog.`, {
            found: false,
          });
          process.exit(ctx.exitCodes.ok);
        }

        const report = assessReadiness(issue);
        ctx.emit(renderReadiness(report), report);
        process.exit(
          report.dispatchable ? ctx.exitCodes.ok : ctx.exitCodes.blocked,
        );
      } catch (err) {
        ctx.fail(err);
      }
    });
}

// -- skills ----------------------------------------------------------------

function registerSkills(program: Command, ctx: CommandContext): void {
  const skills = program.command("skills").description("Manage review skills");

  skills
    .command("eject")
    .option("--force", "overwrite existing skill files")
    .description("Write the built-in review skills so you can edit them")
    .action((opts: { force?: boolean }) => {
      try {
        const root = ctx.repoRoot();
        const created: string[] = [];
        const skipped: string[] = [];
        for (const skill of SKILL_FILES) {
          const path = join(root, skill.path);
          if (existsSync(path) && opts.force !== true) {
            skipped.push(skill.path);
            continue;
          }
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, skill.content);
          created.push(skill.path);
        }
        ctx.emit(
          [
            ...created.map((f) => `  wrote   ${f}`),
            ...skipped.map((f) => `  exists  ${f}  (--force to overwrite)`),
            "",
            "  These are yours to edit. runmill reads them at review time.",
          ].join("\n"),
          { created, skipped },
        );
      } catch (err) {
        ctx.fail(err);
      }
    });

  skills
    .command("validate")
    .description("Check that the configured review skills are well formed")
    .action(() => {
      try {
        const root = ctx.repoRoot();
        const results = SKILL_FILES.map((skill) => {
          const path = join(root, skill.path);
          if (!existsSync(path)) {
            return {
              path: skill.path,
              valid: false,
              errors: ["file does not exist"],
            };
          }
          const { valid, errors } = validateSkill(readFileSync(path, "utf8"));
          return { path: skill.path, valid, errors };
        });

        const bad = results.filter((r) => !r.valid);
        ctx.emit(
          results
            .map((r) =>
              r.valid
                ? `  ✓ ${r.path}`
                : `  ✗ ${r.path}\n${r.errors.map((e) => `      ${e}`).join("\n")}`,
            )
            .join("\n") +
            (bad.length > 0 ? "\n\n  Fix:  runmill skills eject --force" : ""),
          results,
        );
        process.exit(
          bad.length > 0 ? ctx.exitCodes.configInvalid : ctx.exitCodes.ok,
        );
      } catch (err) {
        ctx.fail(err);
      }
    });
}

// -- feedback --------------------------------------------------------------

function registerFeedback(program: Command, ctx: CommandContext): void {
  program
    .command("feedback")
    .description("Open an issue, or print a support bundle to paste into one")
    .option("--print", "print the bundle instead of opening a browser")
    .action(async (opts: { print?: boolean }) => {
      try {
        const url = "https://github.com/mikigraf/runmill/issues/new";
        if (opts.print === true) {
          ctx.emit(
            `Run \`runmill doctor --report\` for a bundle to attach, then file at:\n  ${url}`,
            { url },
          );
          process.exit(ctx.exitCodes.ok);
        }
        const opened = await runProcess("open", [url]);
        ctx.emit(opened.ok ? `Opened ${url}` : `File an issue at:\n  ${url}`, {
          url,
          opened: opened.ok,
        });
      } catch (err) {
        ctx.fail(errorMessage(err));
      }
    });
}

export { resolve };
