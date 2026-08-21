#!/usr/bin/env node
import { Command } from "commander";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join, dirname } from "node:path";
import { loadConfig, parseConfig, validateConfig } from "../config/load.js";
import {
  RunmillError,
  renderError,
  errorMessage,
} from "../errors/runmill-error.js";
import {
  runAllChecks,
  worstStatus,
  type ProviderCheckTarget,
} from "../doctor/checks.js";
import { renderDoctor, renderSelection } from "./render.js";
import { selectNext } from "../queue/selector.js";
import type { BacklogIssue, RepositoryTarget } from "../domain/types.js";
import { StateStore, CURRENT_SCHEMA_VERSION } from "../state/store.js";
import {
  buildAdapters,
  resolveReviewerAgent,
  type AdapterSet,
} from "../factory.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { GitRefLease } from "../queue/git-lease.js";
import { SystemClock } from "../platform/clock.js";
import {
  Daemon,
  CircuitBreakers,
  DEFAULT_BREAKERS,
} from "../orchestrator/daemon.js";
import {
  registerExtraCommands,
  type CommandContext,
} from "./extra-commands.js";
import { registerEvalCommands } from "./eval-commands.js";
import { EXPLANATIONS, buildSupportBundle } from "./explain.js";
import {
  recordMilestone,
  recordDoctorFailure,
  readFunnel,
} from "../state/funnel.js";
import type { CheckSpec } from "../verification/engine.js";
import {
  loadChecksManifest,
  mergeCheckSources,
} from "../verification/manifest.js";
import type { RunmillConfig } from "../config/types.js";
import { createConfiguration } from "../config/create.js";
import { startKeepAwake } from "../platform/keep-awake.js";
import {
  defaultConfigPath,
  defaultDataDir,
  findRepositoryRoot,
} from "../platform/paths.js";
import { repositoryIdentity } from "../workspace/repository-identity.js";
import { fetchTrustedBase } from "../workspace/manager.js";
import { runDemo } from "./demo.js";
import {
  DaemonControlServer,
  type ControlRequest,
  type DaemonLogLine,
  type DaemonPhase,
  type DaemonSnapshot,
  type RunDetail,
  requestDaemon,
} from "../daemon/control.js";
import packageJson from "../../package.json" with { type: "json" };

/** Terminal states in which a branch exists for a later layer to build on. */

const VERSION = packageJson.version;

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

function findConfigPath(
  explicit: string | undefined,
  repoRoot: string,
): string {
  if (explicit !== undefined) return resolve(explicit);
  return defaultConfigPath(repoRoot);
}

function loadOrExit(
  opts: GlobalOpts,
  repoRoot: string,
): { config: RunmillConfig; path: string } {
  const canonicalRoot = findRepositoryRoot(repoRoot);
  const path = findConfigPath(opts.config, canonicalRoot);
  return loadConfig(path, { repoRoot: canonicalRoot });
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
    process.exit(
      err.code.startsWith("RM-CONFIG") ? EXIT.configInvalid : EXIT.failed,
    );
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
async function buildOrchestrator(
  cfg: RunmillConfig,
  adapters: AdapterSet,
  store: StateStore,
  opts: GlobalOpts,
  target: RepositoryTarget,
  eventSink?: (message: string) => void,
): Promise<{
  orchestrator: Orchestrator;
  lease: (runId: string) => GitRefLease;
}> {
  const sourceRepo = findRepositoryRoot(
    process.env["RUNMILL_SOURCE_REPO"] ?? process.cwd(),
  );
  const clock = new SystemClock();
  const sourceRepository =
    process.env["RUNMILL_DEMO"] === "1"
      ? cfg.github.repositories[0]?.repo
      : await repositoryIdentity(sourceRepo);
  if (sourceRepository === undefined) {
    throw RunmillError.fromCatalog("RM-WORKSPACE-003", {
      whatHappened:
        `the origin for ${sourceRepo} is not a GitHub owner/name repository; ` +
        "Runmill cannot prove that the selected route and cloned source are the same",
    });
  }
  if (sourceRepository.toLowerCase() !== target.repo.toLowerCase()) {
    throw RunmillError.fromCatalog("RM-WORKSPACE-003", {
      whatHappened:
        `the selected route targets ${target.repo}, but the source origin is ${sourceRepository}; ` +
        "refusing to fetch or mutate either repository",
    });
  }

  // Observe the configured remote on every ordinary run. The fetch updates a
  // Runmill-owned ref, never the operator's local branch, and the returned SHA
  // binds both policy discovery and the workspace to one immutable base.
  const sourceBaseRef =
    process.env["RUNMILL_DEMO"] === "1"
      ? target.baseBranch
      : (
          await fetchTrustedBase(
            sourceRepo,
            target.baseBranch,
            adapters.gitCredential?.repositoryUrl(target.repo) ?? "origin",
            adapters.gitCredential,
          )
        ).commit;

  const configured: CheckSpec[] = cfg.verification.commands.map((c) => ({
    id: c.id,
    run: c.run,
    required: true,
    source: "repository-policy" as const,
    report: c.report,
  }));

  // Repository policy may add checks. On an id conflict, the operator-owned
  // definition wins so repository content cannot replace a command run with
  // orchestrator authority. Read repository rules from the base branch so a
  // pull request cannot relax the checks that govern its own merge.
  const manifest = loadChecksManifest({
    repoRoot: sourceRepo,
    manifestPath: cfg.verification.manifest,
    baseRef: sourceBaseRef,
  });
  const checks = mergeCheckSources(manifest?.checks ?? [], configured);

  return {
    orchestrator: new Orchestrator({
      backlog: adapters.backlog,
      provider: adapters.provider,
      reviewProvider: adapters.reviewProvider,
      forge: adapters.forge,
      store,
      clock,
      config: cfg,
      sourceRepoPath: sourceRepo,
      sourceRepository,
      sourceBaseRef,
      workspaceRoot: join(dataDir(), "runs"),
      checks,
      onEvent: (m) => {
        eventSink?.(m);
        if (opts.quiet !== true && opts.json !== true)
          process.stdout.write(`  ${m}\n`);
      },
    }),
    lease: (runId: string) =>
      new GitRefLease({
        cwd: sourceRepo,
        runId,
        clock,
        ...(adapters.gitCredential === undefined
          ? {}
          : {
              credential: adapters.gitCredential,
              remote: adapters.gitCredential.repositoryUrl(target.repo),
            }),
        // There is no background heartbeat yet. Keep a legitimate bounded run
        // fenced for longer than its maximum wall time; the separate takeover
        // grace still governs recovery after this expiry.
        ttlMinutes: Math.max(
          20,
          Math.ceil(cfg.budgets.maxWallMinutesPerIssue) + 1,
        ),
        hostId: process.env["HOSTNAME"] ?? "local",
        pid: process.pid,
      }),
  };
}

function dataDir(): string {
  return defaultDataDir(process.cwd());
}

function detachDaemon(
  configPath: string,
  options: { maxRuns?: number; once?: boolean; pollSeconds: number },
): { pid: number; logPath: string } {
  const directory = dataDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const logPath = join(directory, "daemon.log");
  const log = openSync(logPath, "a", 0o600);
  const entry = realpathSync(process.argv[1] ?? "");
  const args = [
    ...process.execArgv,
    entry,
    "--config",
    configPath,
    "daemon",
    "--poll-seconds",
    String(options.pollSeconds),
    ...(options.maxRuns === undefined
      ? []
      : ["--max-runs", String(options.maxRuns)]),
    ...(options.once === true ? ["--once"] : []),
  ];
  try {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      detached: true,
      env: { ...process.env, RUNMILL_DAEMON_CHILD: "1" },
      stdio: ["ignore", log, log],
    });
    child.unref();
    if (child.pid === undefined)
      throw new Error("could not obtain daemon process id");
    return { pid: child.pid, logPath };
  } finally {
    closeSync(log);
  }
}

async function waitForDetachedDaemon(
  pid: number,
  logPath: string,
): Promise<void> {
  // Each configured provider may spend up to 20 seconds proving auth inside
  // the real sandbox before the control socket is opened. Give an independent
  // reviewer enough room too; a shorter deadline reports failure while the
  // child continues starting successfully in the background.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const snapshot = await requestDaemon<DaemonSnapshot>(
        { type: "snapshot" },
        undefined,
        500,
      );
      if (snapshot.daemon.pid === pid) return;
      throw new Error(
        `Runmill daemon ${snapshot.daemon.pid} is already active for ${snapshot.daemon.repoRoot}.`,
      );
    } catch (error) {
      if (error instanceof Error && /already active/.test(error.message))
        throw error;
    }
    try {
      process.kill(pid, 0);
    } catch {
      throw new Error(
        `The background daemon exited before it became ready. See ${logPath}`,
      );
    }
    await new Promise<void>((resolvePromise) =>
      setTimeout(resolvePromise, 100),
    );
  }
  // This is the exact detached child we just launched. Do not leave it to
  // become a surprise live daemon after the foreground command reported a
  // startup failure.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // It exited between the deadline and cleanup.
    }
  }
  throw new Error(`The background daemon did not become ready. See ${logPath}`);
}

function daemonIsUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/No Runmill daemon is registered/.test(error.message) ||
      /Cannot connect to Runmill daemon/.test(error.message))
  );
}

async function launchTui(registry: string | undefined): Promise<number> {
  // OpenTUI's native renderer works directly under Bun. Its Node renderer
  // currently needs Node 26.4+ with experimental FFI. Supported Node 22 and 24
  // cannot load OpenTUI's FFI bindings, so the normal CLI delegates only this
  // command to Bun.
  if (
    process.versions.bun !== undefined ||
    process.execArgv.includes("--experimental-ffi")
  ) {
    const { runTui } = await import("../tui/app.js");
    await runTui({
      ...(registry === undefined ? {} : { registryPath: registry }),
    });
    return EXIT.ok;
  }

  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const entry = resolve(
    dirname(fileURLToPath(import.meta.url)),
    `../tui/entry.${extension}`,
  );
  return new Promise<number>((resolvePromise, reject) => {
    const child = spawn(
      "bun",
      [entry, ...(registry === undefined ? [] : ["--registry", registry])],
      {
        stdio: "inherit",
        env: process.env,
      },
    );
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            "OpenTUI needs Bun, or Node 26.4+ started with --experimental-ffi. " +
              "Install Bun and run `runmill tui` again.",
          ),
        );
      } else {
        reject(error);
      }
    });
    child.once("exit", (code, signal) => {
      if (signal !== null) reject(new Error(`OpenTUI exited on ${signal}`));
      else resolvePromise(code ?? EXIT.failed);
    });
  });
}

export function buildProgram(): Command {
  const program = new Command();

  // First invocation of anything starts the clock. Local only.
  program.hook("preAction", (_rootCommand, actionCommand) => {
    // The TUI is a remote client. Running it from an arbitrary directory must
    // not create a local .runmill directory or attempt config discovery.
    if (["demo", "status", "stop", "tui"].includes(actionCommand.name()))
      return;
    recordMilestone(dataDir(), "installed_at", new Date());
  });

  program
    .name("runmill")
    .description(
      "Loop orchestrator daemon for autonomous software engineering.",
    )
    .version(VERSION, "-V, --version")
    .option("--json", "machine-readable output")
    .option("-q, --quiet", "suppress non-essential output")
    .option("--no-color", "disable colored output")
    .option("--config <path>", "path to the operator policy YAML");

  program
    .command("doctor")
    .description("Verify this host can run runmill safely")
    .option("--check <id>", "run only checks whose id starts with this prefix")
    .option("--explain <topic>", "explain what a check requires and why")
    .option("--report", "print a support bundle to attach to an issue")
    .action(
      async (cmdOpts: {
        check?: string;
        explain?: string;
        report?: boolean;
      }) => {
        const opts = program.opts<GlobalOpts>();
        const repoRoot = findRepositoryRoot(process.cwd());
        const configPath = findConfigPath(opts.config, repoRoot);

        let providerTargets: readonly ProviderCheckTarget[] = [
          { implementation: "codex" },
        ];
        let backlogProvider = "linear" as const;
        try {
          const loadedConfig = loadOrExit(opts, repoRoot).config;
          const providers = loadedConfig.providers;
          backlogProvider = loadedConfig.backlog.provider;
          // Observe mode never dispatches an agent. Do not spend a provider
          // request or certify a network shape the daemon will never use.
          providerTargets =
            loadedConfig.autonomy === "observe"
              ? []
              : [providers.implementer, resolveReviewerAgent(loadedConfig)];
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

        let results = await runAllChecks(
          { repoRoot, configPath, backlogProvider, checkPrefix: cmdOpts.check },
          providerTargets,
        );
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
              {
                overall: "fail",
                checks: [],
                reason: `no check matches "${prefix}"`,
              },
            );
            process.exit(EXIT.configInvalid);
          }
          results = matched;
        }

        recordMilestone(dataDir(), "first_doctor_run_at", new Date());
        for (const r of results) {
          if (r.status === "fail" && r.code !== undefined)
            recordDoctorFailure(dataDir(), r.code);
        }
        if (worstStatus(results) !== "fail") {
          recordMilestone(dataDir(), "first_doctor_pass_at", new Date());
        }

        if (cmdOpts.report === true) {
          const bundle = buildSupportBundle(
            results,
            repoRoot,
            readFunnel(dataDir()),
          );
          emit(opts, bundle.human, bundle.data);
          process.exit(EXIT.ok);
        }

        const overall = worstStatus(results);
        emit(
          opts,
          `${renderDoctor(results)}\n\n  overall: ${overall.toUpperCase()}`,
          {
            overall,
            checks: results,
          },
        );
        process.exit(overall === "fail" ? EXIT.blocked : EXIT.ok);
      },
    );

  program
    .command("demo")
    .description(
      "Run a complete simulated delivery loop without credentials or repository changes",
    )
    .action(async () => {
      const opts = program.opts<GlobalOpts>();
      try {
        if (opts.quiet !== true && opts.json !== true) {
          process.stdout.write(
            "Runmill demo — temporary repository, in-memory integrations, no credentials\n\n",
          );
        }
        const result = await runDemo((message) => {
          if (opts.quiet !== true && opts.json !== true)
            process.stdout.write(`  ${message}\n`);
        });
        emit(
          opts,
          [
            "",
            `Delivered ${result.issue.identifier} as a simulated pull request.`,
            `  issue       ${result.issue.title}`,
            "  candidate   verified at the exact commit",
            "  review      approved with fresh context",
            `  pull request ${result.outcome.prUrl ?? "simulated"}`,
            `  loop         ${result.transitions.join(" → ")}`,
            "",
            "The temporary repository and state were removed. Your working tree was not touched.",
            "",
            "Next: runmill init",
          ].join("\n"),
          result,
        );
        process.exitCode = EXIT.ok;
      } catch (err) {
        fail(err, opts);
      }
    });

  program
    .command("next")
    .description(
      "Show which issue would be selected, and why every other was not",
    )
    .option(
      "--dry-run",
      "explain the selection without claiming anything",
      true,
    )
    .action(async () => {
      const opts = program.opts<GlobalOpts>();
      try {
        const { config } = loadOrExit(opts, process.cwd());
        const { backlog } = await buildAdapters(config, { need: ["backlog"] });
        const result = await selectNext({
          backlog,
          config,
          leasedIssueIds: new Set(),
        });
        emit(opts, renderSelection(result, config.backlog.team), {
          selected:
            result.selected === undefined
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
    .argument(
      "[issue]",
      "issue identifier; omitted selects the next eligible issue",
    )
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
            const rejected = selection.rejected.find(
              (r) => r.issue.identifier === issueId,
            );
            const detail =
              rejected === undefined
                ? "no eligible issue"
                : rejected.decision.rules
                    .filter((r) => !r.passed)
                    .map((r) => `  ✗ ${r.rule}: ${r.reason}`)
                    .join("\n");
            emit(opts, `Nothing to run.\n${detail}`, {
              ran: false,
              reason: detail,
            });
            process.exit(EXIT.ok);
          }

          const { orchestrator, lease } = await buildOrchestrator(
            cfg,
            adapters,
            store,
            opts,
            candidate.target,
          );
          recordMilestone(dataDir(), "first_run_started_at", new Date());
          const runId = `run_${Date.now().toString(36)}`;
          const keepAwake = startKeepAwake();
          if (opts.quiet !== true && opts.json !== true) {
            const prefix = keepAwake.active ? "  " : "  warning: ";
            process.stdout.write(`${prefix}${keepAwake.message}\n`);
          }
          let outcome;
          try {
            outcome = await orchestrator.run({
              runId,
              issue: candidate.issue,
              target: candidate.target,
              lease: lease(runId),
            });
          } finally {
            keepAwake.release();
          }
          if (outcome.prNumber !== undefined) {
            recordMilestone(dataDir(), "first_pr_opened_at", new Date());
          }

          emit(
            opts,
            [
              "",
              `${outcome.issueId}  →  ${outcome.finalState}`,
              outcome.prUrl === undefined
                ? ""
                : `  pull request  ${outcome.prUrl}`,
              outcome.mergeSha === undefined
                ? ""
                : `  merged        ${outcome.mergeSha}`,
              `  cost          $${outcome.costUsd.toFixed(2)}`,
              outcome.reason === undefined
                ? ""
                : `  reason        ${outcome.reason}`,
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
    .command("start")
    .description("Start the Runmill delivery loop in the background")
    .option(
      "--poll-seconds <seconds>",
      "seconds between backlog checks while idle",
      (value: string) => Number(value),
      30,
    )
    .action(async (cmdOpts: { pollSeconds: number }) => {
      const opts = program.opts<GlobalOpts>();
      try {
        if (!Number.isFinite(cmdOpts.pollSeconds) || cmdOpts.pollSeconds <= 0) {
          throw new Error("--poll-seconds must be a positive number");
        }
        const loaded = loadOrExit(opts, process.cwd());
        try {
          const running = await requestDaemon<DaemonSnapshot>(
            { type: "snapshot" },
            undefined,
            300,
          );
          throw new Error(
            `Runmill is already running (pid ${running.daemon.pid}) for ${running.daemon.repoRoot}.`,
          );
        } catch (error) {
          if (error instanceof Error && /already running/.test(error.message))
            throw error;
        }
        const detached = detachDaemon(loaded.path, {
          pollSeconds: cmdOpts.pollSeconds,
        });
        await waitForDetachedDaemon(detached.pid, detached.logPath);
        emit(
          opts,
          [
            `Runmill started in the background (pid ${detached.pid}).`,
            `  log     ${detached.logPath}`,
            "  status  runmill status",
            "  ui      runmill tui",
            "  stop    runmill stop",
          ].join("\n"),
          { running: true, ...detached },
        );
        process.exitCode = EXIT.ok;
      } catch (err) {
        fail(err, opts);
      }
    });

  program
    .command("status")
    .description("Show whether Runmill is running and what it is doing")
    .action(async () => {
      const opts = program.opts<GlobalOpts>();
      try {
        const snapshot = await requestDaemon<DaemonSnapshot>({
          type: "snapshot",
        });
        emit(
          opts,
          [
            `Runmill is ${snapshot.daemon.phase}.`,
            `  pid       ${snapshot.daemon.pid}`,
            `  project   ${snapshot.daemon.repoRoot}`,
            `  policy    ${snapshot.daemon.configPath}`,
            ...(snapshot.daemon.activeIssue === undefined
              ? []
              : [`  issue     ${snapshot.daemon.activeIssue}`]),
            `  runs      ${snapshot.runs.length}`,
            `  started   ${snapshot.daemon.startedAt}`,
            "",
            "Open the live dashboard with: runmill tui",
          ].join("\n"),
          { running: true, ...snapshot },
        );
        process.exitCode = EXIT.ok;
      } catch (err) {
        if (daemonIsUnavailable(err)) {
          emit(
            opts,
            "Runmill is not running.\n\nStart it with: runmill start",
            {
              running: false,
            },
          );
          process.exitCode = EXIT.failed;
          return;
        }
        fail(err, opts);
      }
    });

  program
    .command("stop")
    .description("Ask the background Runmill process to stop safely")
    .action(async () => {
      const opts = program.opts<GlobalOpts>();
      try {
        await requestDaemon({ type: "stop" });
        emit(
          opts,
          "Runmill is stopping after the current safe boundary.\nCheck with: runmill status",
          { stopping: true },
        );
        process.exitCode = EXIT.ok;
      } catch (err) {
        if (daemonIsUnavailable(err)) {
          emit(opts, "Runmill is not running.", {
            stopping: false,
            running: false,
          });
          process.exitCode = EXIT.ok;
          return;
        }
        fail(err, opts);
      }
    });

  program
    .command("daemon")
    .description("Watch the backlog and process eligible issues continuously")
    .option("--max-runs <n>", "stop after this many runs", (v: string) =>
      Number(v),
    )
    .option("--once", "drain currently eligible work, then exit")
    .option(
      "--poll-seconds <seconds>",
      "seconds between backlog checks while idle",
      (v: string) => Number(v),
      30,
    )
    .option("--detach", "start in the background and return")
    .action(
      async (cmdOpts: {
        maxRuns?: number;
        once?: boolean;
        pollSeconds: number;
        detach?: boolean;
      }) => {
        const opts = program.opts<GlobalOpts>();
        try {
          if (
            !Number.isFinite(cmdOpts.pollSeconds) ||
            cmdOpts.pollSeconds <= 0
          ) {
            throw new Error("--poll-seconds must be a positive number");
          }
          if (
            cmdOpts.maxRuns !== undefined &&
            (!Number.isInteger(cmdOpts.maxRuns) || cmdOpts.maxRuns <= 0)
          ) {
            throw new Error("--max-runs must be a positive integer");
          }
          if (cmdOpts.detach === true && cmdOpts.once === true) {
            throw new Error("--detach and --once cannot be used together");
          }
          const loaded = loadOrExit(opts, process.cwd());
          const { config: cfg } = loaded;
          if (
            cmdOpts.detach === true &&
            process.env["RUNMILL_DAEMON_CHILD"] !== "1"
          ) {
            try {
              const running = await requestDaemon<DaemonSnapshot>(
                { type: "snapshot" },
                undefined,
                300,
              );
              throw new Error(
                `Runmill daemon ${running.daemon.pid} is already active for ${running.daemon.repoRoot}.`,
              );
            } catch (error) {
              if (
                error instanceof Error &&
                /already active/.test(error.message)
              )
                throw error;
            }
            const detached = detachDaemon(loaded.path, cmdOpts);
            await waitForDetachedDaemon(detached.pid, detached.logPath);
            emit(
              opts,
              `Runmill daemon started in the background (pid ${detached.pid}).\n` +
                `  log  ${detached.logPath}\n` +
                "  ui   runmill tui",
              { detached: true, ...detached },
            );
            process.exitCode = EXIT.ok;
            return;
          }
          if (cfg.autonomy === "observe") {
            emit(opts, "autonomy is `observe`; the daemon has nothing to do.", {
              ran: false,
            });
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
          const startedAt = new Date().toISOString();
          let phase: DaemonPhase = "starting";
          let activeIssue: string | undefined;
          const logs: DaemonLogLine[] = [];
          const recordLog = (
            message: string,
            level: DaemonLogLine["level"] = "info",
          ): void => {
            logs.push({ at: new Date().toISOString(), level, message });
            if (logs.length > 200) logs.splice(0, logs.length - 200);
          };

          const daemon = new Daemon({
            clock,
            store,
            breakers,
            ...(cmdOpts.maxRuns === undefined
              ? {}
              : { maxRuns: cmdOpts.maxRuns }),
            stopWhenIdle: cmdOpts.once === true,
            pollIntervalMs: cmdOpts.pollSeconds * 1_000,
            ...(cfg.budgets.dailyCostUsd === undefined ||
            cfg.github.repositories[0] === undefined
              ? {}
              : {
                  dailyBudgetLedger: {
                    repo: cfg.github.repositories[0].repo,
                    window: cfg.budgets.dailyWindow,
                  },
                }),
            onEvent: (m) => {
              recordLog(m);
              if (opts.quiet !== true && opts.json !== true)
                process.stdout.write(`${m}\n`);
            },
            onIdle: () => {
              phase = "idle";
              recordLog(
                `idle; checking for new work in ${cmdOpts.pollSeconds}s`,
              );
              if (opts.quiet !== true && opts.json !== true) {
                process.stdout.write(
                  cmdOpts.once === true
                    ? "no eligible work remaining\n"
                    : `idle; checking for new work in ${cmdOpts.pollSeconds}s\n`,
                );
              }
            },
          });

          const keepAwake = startKeepAwake();
          if (opts.quiet !== true && opts.json !== true) {
            const prefix = keepAwake.active ? "" : "warning: ";
            process.stdout.write(`${prefix}${keepAwake.message}\n`);
          }
          recordLog(keepAwake.message, keepAwake.active ? "info" : "warn");

          let control: DaemonControlServer;
          try {
            control = await DaemonControlServer.start({
              repoRoot: findRepositoryRoot(process.cwd()),
              configPath: loaded.path,
              startedAt,
              handle: (
                request: ControlRequest,
              ): DaemonSnapshot | RunDetail | null | { stopping: true } => {
                if (request.type === "stop") {
                  phase = "stopping";
                  recordLog("stop requested from TUI");
                  daemon.requestStop();
                  return { stopping: true };
                }
                if (request.type === "inspect") {
                  const run = store.getRun(request.runId);
                  if (run === undefined) return null;
                  return {
                    run,
                    transitions: store.transitionHistory(request.runId),
                    events: store.eventsFor(request.runId),
                    pending: store
                      .pendingSideEffects()
                      .filter((item) => item.runId === request.runId),
                  };
                }
                return {
                  protocolVersion: 1,
                  daemon: {
                    pid: process.pid,
                    phase,
                    startedAt,
                    repoRoot: findRepositoryRoot(process.cwd()),
                    configPath: loaded.path,
                    pollSeconds: cmdOpts.pollSeconds,
                    ...(activeIssue === undefined ? {} : { activeIssue }),
                    sleepInhibitor: keepAwake.active
                      ? (keepAwake.name ?? "active")
                      : "unavailable",
                  },
                  runs: store.listRuns(50),
                  pendingEffects: store.pendingSideEffects().length,
                  activeLeases: store.activeLeaseIssueIds().size,
                  logs,
                };
              },
            });
          } catch (error) {
            keepAwake.release();
            store.close();
            throw error;
          }
          phase = "watching";
          recordLog(`control socket ready; connect with runmill tui`);

          // A signal stops at the next boundary rather than mid-run, so a lease
          // is never abandoned with a workspace half-written.
          const requestStop = (): void => {
            phase = "stopping";
            daemon.requestStop();
          };
          process.on("SIGINT", requestStop);
          process.on("SIGTERM", requestStop);

          let pending: { issue: BacklogIssue; target: RepositoryTarget }[] = [];

          try {
            const result = await daemon.loop(async () => {
              if (pending.length === 0) {
                phase = "watching";
                const selection = await selectNext({
                  backlog: adapters.backlog,
                  config: cfg,
                  leasedIssueIds: store.activeLeaseIssueIds(),
                });
                if (selection.selected === undefined) {
                  phase = "idle";
                  activeIssue = undefined;
                  return undefined;
                }

                const chosen = selection.selected;
                activeIssue = chosen.issue.identifier;
                pending = [{ issue: chosen.issue, target: chosen.target }];
              }

              const layer = pending.shift();
              if (layer === undefined) return undefined;
              phase = "running";
              activeIssue = layer.issue.identifier;

              const { orchestrator, lease } = await buildOrchestrator(
                cfg,
                adapters,
                store,
                opts,
                layer.target,
                recordLog,
              );
              const runId = `run_${Date.now().toString(36)}`;
              const outcome = await orchestrator.run({
                runId,
                issue: layer.issue,
                target: layer.target,
                lease: lease(runId),
              });

              activeIssue = pending[0]?.issue.identifier;
              phase = activeIssue === undefined ? "watching" : "running";

              return outcome;
            });

            emit(
              opts,
              [
                "",
                `stopped: ${result.stoppedBecause}`,
                result.breaker === undefined
                  ? ""
                  : `  breaker: ${result.breaker.name} — ${result.breaker.reason ?? ""}`,
                `  runs:    ${result.outcomes.length}`,
                `  spend:   $${breakers.spendUsd.toFixed(2)}`,
              ]
                .filter((l) => l !== "")
                .join("\n"),
              { ...result, spendUsd: breakers.spendUsd },
            );
            process.exitCode =
              result.stoppedBecause === "breaker" ? EXIT.blocked : EXIT.ok;
          } finally {
            process.off("SIGINT", requestStop);
            process.off("SIGTERM", requestStop);
            await control.close();
            keepAwake.release();
            store.close();
          }
        } catch (err) {
          fail(err, opts);
        }
      },
    );

  program
    .command("tui")
    .description("Open the terminal interface for the running daemon")
    .option("--registry <path>", "override daemon registry path")
    .action(async (cmdOpts: { registry?: string }) => {
      const opts = program.opts<GlobalOpts>();
      try {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new Error("runmill tui needs an interactive terminal");
        }
        process.exitCode = await launchTui(
          cmdOpts.registry === undefined
            ? undefined
            : resolve(cmdOpts.registry),
        );
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
          const blocked = new Set([
            "NEEDS_HUMAN",
            "AWAITING_APPROVAL",
            "QUARANTINED",
          ]);
          const rows = store
            .listRuns()
            .filter(
              (r) => cmdOpts.needsAttention !== true || blocked.has(r.state),
            );

          emit(
            opts,
            rows.length === 0
              ? cmdOpts.needsAttention === true
                ? "Nothing is waiting on you."
                : "No runs yet."
              : rows
                  .map(
                    (r) => `  ${r.runId}  ${r.issueId.padEnd(10)} ${r.state}`,
                  )
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

  const config = program
    .command("config")
    .description("Inspect and verify configuration");

  config
    .command("create", { hidden: true })
    .description("Legacy configuration-only setup; prefer runmill init")
    .option("--force", "overwrite an existing configuration")
    .option(
      "--defaults",
      "accept discovered values and sane defaults without prompting",
    )
    .action(async (cmdOpts: { force?: boolean; defaults?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const root = process.cwd();
      const path = findConfigPath(opts.config, root);
      try {
        const created = await createConfiguration({
          root,
          path,
          force: cmdOpts.force,
          defaults: cmdOpts.defaults,
        });
        emit(
          opts,
          [
            `Created ${created.path}`,
            `  GitHub  ${created.discovered.githubAuthenticated ? "credential found; repository metadata loaded when available" : "not configured; local git defaults used"}`,
            `  Linear  ${created.discovered.linearCredential ? "credential found" : "not configured"}`,
            "",
            "Next: runmill init",
          ].join("\n"),
          {
            created: created.path,
            discovery: {
              githubAuthenticated: created.discovered.githubAuthenticated,
              linearCredential: created.discovered.linearCredential,
              repositories: created.discovered.repositories.length,
              teams: created.discovered.linearTeams.length,
              providers: created.discovered.providers,
            },
          },
        );
      } catch (err) {
        fail(err, opts);
      }
    });

  config
    .command("validate")
    .description(
      "Validate the operator policy against the schema and cross-field rules",
    )
    .action(() => {
      const opts = program.opts<GlobalOpts>();
      const path = findConfigPath(opts.config, process.cwd());
      if (!existsSync(path)) {
        fail(
          RunmillError.fromCatalog("RM-CONFIG-003", {
            whatHappened: `No operator policy at ${path}`,
          }),
          opts,
        );
      }
      const parsed = parseConfig(readFileSync(path, "utf8"));
      const result = validateConfig(parsed);

      // The check manifest is configuration too, and it is the file the
      // verification errors tell people to come back and fix. Validating one
      // and not the other means `config validate` can say "valid" about a
      // repository whose checks will not load.
      const manifestErrors: string[] = [];
      let manifestPath: string | undefined;
      try {
        const resolvedCheckIds = new Set(
          parsed.verification.commands.map((check) => check.id),
        );
        const loaded = loadChecksManifest({
          // The operator policy lives outside the repository. Repository-owned
          // check paths still resolve from the project Runmill is managing.
          repoRoot: findRepositoryRoot(process.cwd()),
          manifestPath: parsed.verification.manifest,
        });
        if (loaded !== undefined) {
          manifestPath = loaded.path;
          for (const check of loaded.checks) resolvedCheckIds.add(check.id);
        }
        if (resolvedCheckIds.size === 0) {
          manifestErrors.push(
            `${loaded?.path ?? parsed.verification.manifest}: declares no checks, and ` +
              "verification.commands is empty",
          );
        }
      } catch (err) {
        // The detail IS the fix — "the manifest is invalid" without naming the
        // offending check leaves the developer to bisect the file by hand.
        manifestErrors.push(
          err instanceof RunmillError
            ? `${err.code}: ${err.whatHappened}`.split("\n").join("\n      ")
            : errorMessage(err),
        );
      }

      const errors = [...result.errors, ...manifestErrors];
      if (errors.length === 0) {
        emit(
          opts,
          `✓ ${path} is valid` +
            (manifestPath === undefined ? "" : `\n✓ ${manifestPath} is valid`),
          { valid: true, path, manifest: manifestPath ?? null, errors: [] },
        );
        process.exit(EXIT.ok);
      }
      emit(opts, `✗ ${path}\n${errors.map((e) => `    - ${e}`).join("\n")}`, {
        valid: false,
        path,
        manifest: manifestPath ?? null,
        errors,
      });
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

  const commandContext: CommandContext = {
    emit: (human, data) => emit(program.opts<GlobalOpts>(), human, data),
    fail: (err) => fail(err, program.opts<GlobalOpts>()),
    dataDir,
    configPath: () =>
      findConfigPath(program.opts<GlobalOpts>().config, process.cwd()),
    repoRoot: () => findRepositoryRoot(process.cwd()),
    exitCodes: EXIT,
  };
  registerExtraCommands(program, commandContext);
  registerEvalCommands(program, commandContext);

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
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      fail(err, {});
    });
}
