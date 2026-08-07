#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { loadConfig, parseConfig, validateConfig } from "../config/load.js";
import { RunmillError, renderError , errorMessage } from "../errors/runmill-error.js";
import { runAllChecks, worstStatus } from "../doctor/checks.js";
import { renderDoctor, renderSelection } from "./render.js";
import { selectNext } from "../queue/selector.js";
import { StateStore, CURRENT_SCHEMA_VERSION } from "../state/store.js";
import { buildAdapters, type AdapterSet } from "../factory.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { GitRefLease } from "../queue/git-lease.js";
import { SystemClock } from "../platform/clock.js";
import { Daemon, CircuitBreakers, DEFAULT_BREAKERS } from "../orchestrator/daemon.js";
import { registerExtraCommands } from "./extra-commands.js";
import { EXPLANATIONS, buildSupportBundle } from "./explain.js";
import { recordMilestone, recordDoctorFailure, readFunnel } from "../state/funnel.js";
import type { CheckSpec } from "../verification/engine.js";
import type { RunmillConfig } from "../config/types.js";

const VERSION = "0.1.0";

/** Documented, stable exit codes so runmill is scriptable. */
export const EXIT = {
  ok: 0,
  failed: 1,
  configInvalid: 2,
  blocked: 3,
} as const;

interface GlobalOpts {
  json?: boolean;
  quiet?: boolean;
  config?: string;
}

function findConfigPath(explicit: string | undefined, repoRoot: string): string {
  if (explicit !== undefined) return resolve(explicit);
  return resolve(repoRoot, "runmill.yaml");
}

function loadOrExit(opts: GlobalOpts, repoRoot: string): { config: RunmillConfig; path: string } {
  const path = findConfigPath(opts.config, repoRoot);
  return loadConfig(path, { repoRoot });
}

function emit(opts: GlobalOpts, human: string, data: unknown): void {
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else if (opts.quiet !== true) {
    process.stdout.write(`${human}\n`);
  }
}

function fail(err: unknown, opts: GlobalOpts): never {
  if (err instanceof RunmillError) {
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify(err.toJSON(), null, 2)}\n`);
    } else {
      process.stderr.write(`${renderError(err)}\n`);
    }
    process.exit(err.code.startsWith("RM-CONFIG") ? EXIT.configInvalid : EXIT.failed);
  }
  process.stderr.write(`${errorMessage(err)}\n`);
  process.exit(EXIT.failed);
}


/**
 * Assemble the orchestrator around whichever adapters resolved.
 *
 * Live adapters are used whenever their credentials exist; the in-memory
 * substitutes only appear under an explicit RUNMILL_DEMO=1, and which ones are
 * live is reported to the operator rather than inferred.
 */
function buildOrchestrator(
  cfg: RunmillConfig,
  adapters: AdapterSet,
  store: StateStore,
  opts: GlobalOpts,
): { orchestrator: Orchestrator; lease: (runId: string) => GitRefLease } {
  const sourceRepo = process.env["RUNMILL_SOURCE_REPO"] ?? process.cwd();
  const clock = new SystemClock();

  const checks: CheckSpec[] = cfg.verification.commands.map((c) => ({
    id: c.id,
    run: c.run,
    required: true,
    source: "repository-policy" as const,
    report: c.report,
  }));

  return {
    orchestrator: new Orchestrator({
      backlog: adapters.backlog,
      provider: adapters.provider,
      forge: adapters.forge,
      store,
      clock,
      config: cfg,
      sourceRepoPath: sourceRepo,
      workspaceRoot: join(dataDir(), "runs"),
      checks,
      onEvent: (m) => {
        if (opts.quiet !== true && opts.json !== true) process.stdout.write(`  ${m}\n`);
      },
    }),
    lease: (runId: string) =>
      new GitRefLease({
        cwd: sourceRepo,
        runId,
        clock,
        ttlMinutes: 20,
        hostId: process.env["HOSTNAME"] ?? "local",
        pid: process.pid,
      }),
  };
}

function dataDir(): string {
  return process.env["RUNMILL_DATA_DIR"] ?? resolve(process.cwd(), ".runmill", "state");
}

export function buildProgram(): Command {
  const program = new Command();

  // First invocation of anything starts the clock. Local only.
  program.hook("preAction", () => {
    recordMilestone(dataDir(), "installed_at", new Date());
  });

  program
    .name("runmill")
    .description("A control plane for autonomous software engineering.")
    .version(VERSION, "-V, --version")
    .option("--json", "machine-readable output")
    .option("-q, --quiet", "suppress non-essential output")
    .option("--no-color", "disable colored output")
    .option("--config <path>", "path to runmill.yaml");

  program
    .command("doctor")
    .description("Verify this host can run runmill safely")
    .option("--check <id>", "run only checks whose id starts with this prefix")
    .option("--explain <topic>", "explain what a check requires and why")
    .option("--report", "print a support bundle to attach to an issue")
    .action(async (cmdOpts: { check?: string; explain?: string; report?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const repoRoot = process.cwd();

      let providerImpl = "codex";
      try {
        providerImpl = loadOrExit(opts, repoRoot).config.provider.implementation;
      } catch {
        // doctor must still run without a valid config; the config check
        // itself is what reports that.
      }

      if (cmdOpts.explain !== undefined) {
        const topic = EXPLANATIONS[cmdOpts.explain];
        if (topic === undefined) {
          emit(
            opts,
            `No explanation for "${cmdOpts.explain}".\n  Available: ${Object.keys(EXPLANATIONS).join(", ")}`,
            { topics: Object.keys(EXPLANATIONS) },
          );
          process.exit(EXIT.ok);
        }
        emit(opts, topic, { topic: cmdOpts.explain, explanation: topic });
        process.exit(EXIT.ok);
      }

      let results = await runAllChecks({ repoRoot }, providerImpl);
      if (cmdOpts.check !== undefined) {
        const prefix = cmdOpts.check;
        const matched = results.filter((r) => r.id.startsWith(prefix));
        if (matched.length === 0) {
          // A filter that matches nothing used to report `overall: PASS`,
          // which told a developer their setup was fine when nothing had
          // been checked at all.
          emit(
            opts,
            `No check matches "${prefix}".\n  Available: ${results.map((r) => r.id).join(", ")}`,
            { overall: "fail", checks: [], reason: `no check matches "${prefix}"` },
          );
          process.exit(EXIT.configInvalid);
        }
        results = matched;
      }

      recordMilestone(dataDir(), "first_doctor_run_at", new Date());
      for (const r of results) {
        if (r.status === "fail" && r.code !== undefined) recordDoctorFailure(dataDir(), r.code);
      }
      if (worstStatus(results) !== "fail") {
        recordMilestone(dataDir(), "first_doctor_pass_at", new Date());
      }

      if (cmdOpts.report === true) {
        const bundle = buildSupportBundle(results, repoRoot, readFunnel(dataDir()));
        emit(opts, bundle.human, bundle.data);
        process.exit(EXIT.ok);
      }

      const overall = worstStatus(results);
      emit(opts, `${renderDoctor(results)}\n\n  overall: ${overall.toUpperCase()}`, {
        overall,
        checks: results,
      });
      process.exit(overall === "fail" ? EXIT.blocked : EXIT.ok);
    });

  program
    .command("next")
    .description("Show which issue would be selected, and why every other was not")
    .option("--dry-run", "explain the selection without claiming anything", true)
    .action(async () => {
      const opts = program.opts<GlobalOpts>();
      try {
        const { config } = loadOrExit(opts, process.cwd());
        const { backlog } = await buildAdapters(config, { need: ["backlog"] });
        const result = await selectNext({ backlog, config, leasedIssueIds: new Set() });
        emit(opts, renderSelection(result, config.backlog.team), {
          selected: result.selected === undefined
            ? null
            : {
                identifier: result.selected.issue.identifier,
                title: result.selected.issue.title,
                repo: result.selected.target.repo,
              },
          rejected: result.rejected.map((r) => ({
            identifier: r.issue.identifier,
            rules: r.decision.rules,
          })),
        });
        process.exit(result.selected === undefined ? EXIT.ok : EXIT.ok);
      } catch (err) {
        fail(err, opts);
      }
    });

  program
    .command("run")
    .argument("[issue]", "issue identifier; omitted selects the next eligible issue")
    .description("Process one issue end to end")
    .action(async (issueId: string | undefined) => {
      const opts = program.opts<GlobalOpts>();
      try {
        const { config: cfg } = loadOrExit(opts, process.cwd());
        const adapters = await buildAdapters(cfg);
        const backlog = adapters.backlog;
        const store = StateStore.open(join(dataDir(), "runmill.db"));

        if (opts.quiet !== true && opts.json !== true) {
          const mark = (live: boolean): string => (live ? "live" : "in-memory");
          process.stdout.write(
            `  adapters: backlog=${mark(adapters.live.backlog)} ` +
              `provider=${mark(adapters.live.provider)} forge=${mark(adapters.live.forge)}\n`,
          );
        }

        try {
          const selection = await selectNext({
            backlog,
            config: cfg,
            leasedIssueIds: store.activeLeaseIssueIds(),
          });

          const candidate =
            issueId === undefined
              ? selection.selected
              : [selection.selected, ...selection.runnersUp].find(
                  (c) => c?.issue.identifier === issueId,
                );

          if (candidate === undefined) {
            const rejected = selection.rejected.find((r) => r.issue.identifier === issueId);
            const detail =
              rejected === undefined
                ? "no eligible issue"
                : rejected.decision.rules
                    .filter((r) => !r.passed)
                    .map((r) => `  ✗ ${r.rule}: ${r.reason}`)
                    .join("\n");
            emit(opts, `Nothing to run.\n${detail}`, { ran: false, reason: detail });
            process.exit(EXIT.ok);
          }

          const { orchestrator, lease } = buildOrchestrator(cfg, adapters, store, opts);
          recordMilestone(dataDir(), "first_run_started_at", new Date());
          const runId = `run_${Date.now().toString(36)}`;
          const outcome = await orchestrator.run({
            runId,
            issue: candidate.issue,
            target: candidate.target,
            lease: lease(runId),
          });
          if (outcome.prNumber !== undefined) {
            recordMilestone(dataDir(), "first_pr_opened_at", new Date());
          }

          emit(
            opts,
            [
              "",
              `${outcome.issueId}  →  ${outcome.finalState}`,
              outcome.prUrl === undefined ? "" : `  pull request  ${outcome.prUrl}`,
              outcome.mergeSha === undefined ? "" : `  merged        ${outcome.mergeSha}`,
              `  cost          $${outcome.costUsd.toFixed(2)}`,
              outcome.reason === undefined ? "" : `  reason        ${outcome.reason}`,
            ]
              .filter((l) => l !== "")
              .join("\n"),
            outcome,
          );

          const blocked =
            outcome.finalState === "NEEDS_HUMAN" ||
            outcome.finalState === "QUARANTINED" ||
            outcome.finalState === "AWAITING_APPROVAL";
          process.exit(blocked ? EXIT.blocked : EXIT.ok);
        } finally {
          store.close();
        }
      } catch (err) {
        fail(err, opts);
      }
    });

  program
    .command("daemon")
    .description("Continuously process eligible issues until the work or the budget runs out")
    .option("--max-runs <n>", "stop after this many runs", (v: string) => Number(v))
    .action(async (cmdOpts: { maxRuns?: number }) => {
      const opts = program.opts<GlobalOpts>();
      try {
        const { config: cfg } = loadOrExit(opts, process.cwd());
        if (cfg.autonomy === "observe") {
          emit(opts, "autonomy is `observe`; the daemon has nothing to do.", { ran: false });
          process.exit(EXIT.ok);
        }

        const adapters = await buildAdapters(cfg);
        const store = StateStore.open(join(dataDir(), "runmill.db"));
        const clock = new SystemClock();
        const breakers = new CircuitBreakers({
          ...DEFAULT_BREAKERS,
          ...(cfg.budgets.dailyCostUsd === undefined
            ? {}
            : { dailyCostUsd: cfg.budgets.dailyCostUsd }),
        });

        const daemon = new Daemon({
          clock,
          store,
          breakers,
          ...(cmdOpts.maxRuns === undefined ? {} : { maxRuns: cmdOpts.maxRuns }),
          onEvent: (m) => {
            if (opts.quiet !== true && opts.json !== true) process.stdout.write(`${m}\n`);
          },
          onIdle: () => {
            if (opts.quiet !== true && opts.json !== true) {
              process.stdout.write("no eligible work remaining\n");
            }
          },
        });

        // A signal stops at the next boundary rather than mid-run, so a lease
        // is never abandoned with a workspace half-written.
        process.on("SIGINT", () => daemon.requestStop());
        process.on("SIGTERM", () => daemon.requestStop());

        try {
          const result = await daemon.loop(async () => {
            const selection = await selectNext({
              backlog: adapters.backlog,
              config: cfg,
              leasedIssueIds: store.activeLeaseIssueIds(),
            });
            if (selection.selected === undefined) return undefined;

            const { orchestrator, lease } = buildOrchestrator(cfg, adapters, store, opts);
            const runId = `run_${Date.now().toString(36)}`;
            return orchestrator.run({
              runId,
              issue: selection.selected.issue,
              target: selection.selected.target,
              lease: lease(runId),
            });
          });

          emit(
            opts,
            [
              "",
              `stopped: ${result.stoppedBecause}`,
              result.breaker === undefined ? "" : `  breaker: ${result.breaker.name} — ${result.breaker.reason ?? ""}`,
              `  runs:    ${result.outcomes.length}`,
              `  spend:   $${breakers.spendUsd.toFixed(2)}`,
            ]
              .filter((l) => l !== "")
              .join("\n"),
            { ...result, spendUsd: breakers.spendUsd },
          );
          process.exit(result.stoppedBecause === "breaker" ? EXIT.blocked : EXIT.ok);
        } finally {
          store.close();
        }
      } catch (err) {
        fail(err, opts);
      }
    });

  program
    .command("list")
    .description("Show runs, or only those waiting on a human")
    .option("--needs-attention", "only runs blocked on a human decision")
    .action((cmdOpts: { needsAttention?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      try {
        const store = StateStore.open(join(dataDir(), "runmill.db"));
        try {
          const blocked = new Set(["NEEDS_HUMAN", "AWAITING_APPROVAL", "QUARANTINED"]);
          const rows = store
            .listRuns()
            .filter((r) => cmdOpts.needsAttention !== true || blocked.has(r.state));

          emit(
            opts,
            rows.length === 0
              ? cmdOpts.needsAttention === true
                ? "Nothing is waiting on you."
                : "No runs yet."
              : rows
                  .map((r) => `  ${r.runId}  ${r.issueId.padEnd(10)} ${r.state}`)
                  .join("\n"),
            rows,
          );
        } finally {
          store.close();
        }
      } catch (err) {
        fail(err, opts);
      }
    });

  const config = program.command("config").description("Inspect and verify configuration");

  config
    .command("validate")
    .description("Validate runmill.yaml against the schema and cross-field rules")
    .action(() => {
      const opts = program.opts<GlobalOpts>();
      const path = findConfigPath(opts.config, process.cwd());
      if (!existsSync(path)) {
        fail(
          RunmillError.fromCatalog("RM-CONFIG-002", { whatHappened: `No config at ${path}` }),
          opts,
        );
      }
      const parsed = parseConfig(readFileSync(path, "utf8"));
      const result = validateConfig(parsed);
      if (result.valid) {
        emit(opts, `✓ ${path} is valid`, { valid: true, path, errors: [] });
        process.exit(EXIT.ok);
      }
      emit(
        opts,
        `✗ ${path}\n${result.errors.map((e) => `    - ${e}`).join("\n")}`,
        { valid: false, path, errors: result.errors },
      );
      process.exit(EXIT.configInvalid);
    });

  config
    .command("show")
    .description("Print the resolved configuration, including defaults")
    .action(() => {
      const opts = program.opts<GlobalOpts>();
      try {
        const { config: cfg } = loadOrExit(opts, process.cwd());
        emit(opts, JSON.stringify(cfg, null, 2), cfg);
      } catch (err) {
        fail(err, opts);
      }
    });

  program
    .command("state")
    .description("Show state store health")
    .action(() => {
      const opts = program.opts<GlobalOpts>();
      const path = join(dataDir(), "runmill.db");
      try {
        const store = StateStore.open(path);
        const info = {
          path,
          schemaVersion: store.schemaVersion(),
          expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
          journalMode: store.pragma("journal_mode"),
          pendingSideEffects: store.pendingSideEffects().length,
          activeLeases: [...store.activeLeaseIssueIds()],
        };
        store.close();
        emit(
          opts,
          [
            `  path            ${info.path}`,
            `  schema          ${info.schemaVersion} (binary supports ${info.expectedSchemaVersion})`,
            `  journal         ${info.journalMode}`,
            `  pending effects ${info.pendingSideEffects}`,
            `  active leases   ${info.activeLeases.length}`,
          ].join("\n"),
          info,
        );
      } catch (err) {
        fail(err, opts);
      }
    });

  registerExtraCommands(program, {
    emit: (human, data) => emit(program.opts<GlobalOpts>(), human, data),
    fail: (err) => fail(err, program.opts<GlobalOpts>()),
    dataDir,
    configPath: () => findConfigPath(program.opts<GlobalOpts>().config, process.cwd()),
    repoRoot: () => process.cwd(),
    exitCodes: EXIT,
  });

  return program;
}

/**
 * Are we the entrypoint?
 *
 * Comparing `import.meta.url` to `process.argv[1]` directly is wrong once the
 * package is installed: npm links `node_modules/.bin/runmill` to the real file,
 * so argv[1] is the SYMLINK and the two never match. The CLI then parsed
 * nothing and exited 0 — installed, on PATH, and silently inert. Resolving the
 * real path of argv[1] first is what makes the shipped binary work.
 */
function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  buildProgram().parseAsync(process.argv).catch((err: unknown) => {
    fail(err, {});
  });
}
