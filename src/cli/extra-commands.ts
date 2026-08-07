import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RunmillError, errorMessage } from "../errors/runmill-error.js";
import { CredentialStore, type CredentialName } from "../credentials/store.js";
import { StateStore } from "../state/store.js";
import { SKILL_FILES, DEFAULT_CHECKS_MANIFEST, validateSkill } from "../review/default-skills.js";
import { assessReadiness, renderReadiness } from "../queue/readiness.js";
import { buildAdapters } from "../factory.js";
import { loadConfig } from "../config/load.js";
import { run as runProcess } from "../platform/process.js";
import { tryGit } from "../platform/git.js";

export interface CommandContext {
  readonly emit: (human: string, data: unknown) => void;
  readonly fail: (err: unknown) => never;
  readonly dataDir: () => string;
  readonly configPath: () => string;
  readonly repoRoot: () => string;
  readonly exitCodes: { ok: number; failed: number; configInvalid: number; blocked: number };
}

const CREDENTIAL_NAMES: readonly CredentialName[] = ["linear", "github", "runmill-policy"];

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
export function registerExtraCommands(program: Command, ctx: CommandContext): void {
  registerInit(program, ctx);
  registerAuth(program, ctx);
  registerInspect(program, ctx);
  registerResume(program, ctx);
  registerPolicy(program, ctx);
  registerPrepare(program, ctx);
  registerSkills(program, ctx);
  registerFeedback(program, ctx);
}

// -- init ------------------------------------------------------------------

const STARTER_CONFIG = (repo: string, baseBranch: string): string => `# yaml-language-server: $schema=./runmill.schema.json
version: 1

# observe   plan only, no repository mutation
# pr-only   implement, verify, review, open a PR. Never merge. (default)
# guarded-merge / continuous  require a GitHub App token that cannot edit
#                             branch protection. Run \`runmill doctor\` first.
autonomy: pr-only

provider:
  implementation: codex # codex | claude

backlog:
  provider: linear
  team: ENG
  eligible_states: [Todo, Ready]
  claim_state: In Progress
  delivered_state: In Review
  completed_state: Done
  include_labels: [agent-ready]
  exclude_labels: [needs-design, no-agent]

github:
  # Ordered rules, first match wins. No match, or two matches at the same
  # precedence, makes an issue ineligible with a named reason rather than a guess.
  repositories:
    - match: { team: ENG }
      repo: ${repo}
      base_branch: ${baseBranch}

workspace:
  git_isolation: clone
  sandbox: native # Seatbelt on macOS, bubblewrap on Linux. Verified by \`doctor\`.

verification:
  manifest: .runmill/checks.yaml
`;

function registerInit(program: Command, ctx: CommandContext): void {
  program
    .command("init")
    .description("Create runmill.yaml, the check manifest, and the review skills")
    .option("--force", "overwrite files that already exist")
    .action(async (opts: { force?: boolean }) => {
      try {
        const root = ctx.repoRoot();
        const configPath = join(root, "runmill.yaml");

        if (existsSync(configPath) && opts.force !== true) {
          ctx.emit(
            `runmill.yaml already exists at ${configPath}\n` +
              `  Re-run with --force to overwrite, or edit it directly.`,
            { created: [], skipped: [configPath] },
          );
          process.exit(ctx.exitCodes.ok);
        }

        // Infer what can be inferred; everything else is a placeholder the
        // operator edits. Guessing a repository is cheap and visible; guessing
        // a merge policy would not be.
        const remote = await tryGit(root, ["remote", "get-url", "origin"]);
        const repo = remote.ok
          ? (remote.stdout.trim().match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? "owner/repo")
          : "owner/repo";
        const head = await tryGit(root, ["symbolic-ref", "--short", "HEAD"]);
        const baseBranch = head.ok ? head.stdout.trim() : "main";

        const created: string[] = [];
        const write = (relative: string, content: string): void => {
          const path = join(root, relative);
          if (existsSync(path) && opts.force !== true) return;
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, content);
          created.push(relative);
        };

        write("runmill.yaml", STARTER_CONFIG(repo, baseBranch));
        write(".runmill/checks.yaml", DEFAULT_CHECKS_MANIFEST);
        for (const skill of SKILL_FILES) write(skill.path, skill.content);

        ctx.emit(
          [
            "Created:",
            ...created.map((f) => `  ${f}`),
            "",
            `  repository  ${repo}${remote.ok ? "" : "  (no git remote found — edit this)"}`,
            `  base branch ${baseBranch}`,
            "",
            "Next:",
            "  1. Edit runmill.yaml — team, states, and repository mapping",
            "  2. runmill doctor          verify this host can run safely",
            "  3. runmill next --dry-run  see what would be selected, and why",
          ].join("\n"),
          { created, repo, baseBranch },
        );
      } catch (err) {
        ctx.fail(err);
      }
    });
}

// -- auth ------------------------------------------------------------------

function registerAuth(program: Command, ctx: CommandContext): void {
  const auth = program.command("auth").description("Manage credentials");
  const store = new CredentialStore();

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
            .map((r) => `  ${r.resolved ? "✓" : "✗"} ${r.name.padEnd(16)} ${r.resolved ? "resolved" : "not found"}`)
            .join("\n"),
          rows,
        );
        process.exit(rows.some((r) => !r.resolved) ? ctx.exitCodes.ok : ctx.exitCodes.ok);
      } catch (err) {
        ctx.fail(err);
      }
    });

  auth
    .command("login")
    .argument("<system>", "linear | github | runmill-policy")
    .option("--token <token>", "credential value; omit to read from stdin")
    .description("Store a credential in the OS keychain")
    .action(async (system: string, opts: { token?: string }) => {
      try {
        if (!isCredentialName(system)) {
          throw RunmillError.fromCatalog("RM-AUTH-003", {
            whatHappened: `Unknown credential "${system}". Expected one of: ${CREDENTIAL_NAMES.join(", ")}`,
          });
        }
        if (system === "github" && opts.token === undefined) {
          ctx.emit(
            "GitHub credentials are read from `gh` automatically.\n" +
              "  Run: gh auth login\n" +
              "  Or pass an App installation token with --token.",
            { system, delegated: "gh" },
          );
          process.exit(ctx.exitCodes.ok);
        }
        const token = opts.token ?? readFileSync(0, "utf8").trim();
        if (token === "") {
          throw RunmillError.fromCatalog("RM-AUTH-003", {
            whatHappened: "No token supplied. Pass --token or pipe it on stdin.",
          });
        }
        await store.set(system, token);
        ctx.emit(`Stored ${system} credential in the OS keychain.`, { system, stored: true });
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
        ctx.emit(`Removed the ${system} credential.`, { system, removed: true });
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
          ctx.emit(`No run ${runId}. Run \`runmill list\` to see recent runs.`, { found: false });
          process.exit(ctx.exitCodes.ok);
        }

        const transitions = store.transitionHistory(runId);
        const events = store.eventsFor(runId);
        const pending = store.pendingSideEffects().filter((e) => e.runId === runId);
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
            ...(events.length === 0 ? [] : ["", "  events", ...events.map((e) => `    ${e.seq}  ${e.type}`)]),
            ...(pending.length === 0
              ? []
              : [
                  "",
                  "  pending external effects (the recovery sweep reconciles these)",
                  ...pending.map((p) => `    ${p.status.padEnd(10)} ${p.operation} → ${p.target}`),
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
    .argument("<run-id>", "run to resume")
    .option("--answer <choice>", "answer the decision the run is waiting on")
    .description("Resume a run that is waiting on a human")
    .action((runId: string, opts: { answer?: string }) => {
      const store = StateStore.open(join(ctx.dataDir(), "runmill.db"));
      try {
        const run = store.getRun(runId);
        if (run === undefined) {
          ctx.emit(`No run ${runId}. Run \`runmill list\` to see recent runs.`, { resumed: false });
          process.exit(ctx.exitCodes.ok);
        }

        const resumable = new Set(["NEEDS_HUMAN", "AWAITING_APPROVAL", "RETRY_WAIT"]);
        if (!resumable.has(run.state)) {
          ctx.emit(
            `${runId} is ${run.state}, which is not waiting on a human.\n` +
              `  Resumable states: ${[...resumable].join(", ")}`,
            { resumed: false, state: run.state },
          );
          process.exit(ctx.exitCodes.ok);
        }

        if (opts.answer === undefined) {
          ctx.emit(
            `${runId} is ${run.state} and needs a decision.\n` +
              `  Answer it:  runmill resume ${runId} --answer <choice>\n` +
              `  See why:    runmill inspect ${runId}`,
            { resumed: false, state: run.state, needsAnswer: true },
          );
          process.exit(ctx.exitCodes.blocked);
        }

        store.appendEvent({
          runId,
          seq: store.eventsFor(runId).length + 1,
          type: "human.decision",
          payload: { answer: opts.answer },
        });

        // Recording the decision is the durable half. Re-dispatch happens on
        // the next `runmill run`/`daemon`, which re-reads state rather than
        // trusting anything held in this process.
        ctx.emit(
          `Recorded "${opts.answer}" for ${runId}.\n` +
            `  The next \`runmill run\` or \`runmill daemon\` picks it up.`,
          { resumed: true, runId, answer: opts.answer },
        );
      } finally {
        store.close();
      }
    });
}

// -- policy explain --------------------------------------------------------

function registerPolicy(program: Command, ctx: CommandContext): void {
  const policy = program.command("policy").description("Explain policy decisions");

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
          PR_DELIVERED: "Delivered a pull request. `pr-only` never merges by design.",
          COMPLETED: "Every gate passed and the change was merged.",
          NEEDS_HUMAN: "A gate could not be satisfied deterministically, so it escalated.",
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
          { runId, state: run.state, explanation: terminal[run.state] ?? "in progress" },
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
        const { config } = loadConfig(ctx.configPath(), { repoRoot: ctx.repoRoot() });
        const { backlog } = await buildAdapters(config, { need: ["backlog"] });
        const issue = await backlog.getIssue(identifier);
        if (issue === undefined) {
          ctx.emit(`No issue ${identifier} in the configured backlog.`, { found: false });
          process.exit(ctx.exitCodes.ok);
        }

        const report = assessReadiness(issue);
        ctx.emit(renderReadiness(report), report);
        process.exit(report.dispatchable ? ctx.exitCodes.ok : ctx.exitCodes.blocked);
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
            return { path: skill.path, valid: false, errors: ["file does not exist"] };
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
            .join("\n") + (bad.length > 0 ? "\n\n  Fix:  runmill skills eject --force" : ""),
          results,
        );
        process.exit(bad.length > 0 ? ctx.exitCodes.configInvalid : ctx.exitCodes.ok);
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
        ctx.emit(
          opened.ok ? `Opened ${url}` : `File an issue at:\n  ${url}`,
          { url, opened: opened.ok },
        );
      } catch (err) {
        ctx.fail(errorMessage(err));
      }
    });
}

export { resolve };
