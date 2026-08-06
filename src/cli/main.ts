#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadConfig, parseConfig, validateConfig } from "../config/load.js";
import { RunmillError, renderError } from "../errors/runmill-error.js";
import { runAllChecks, worstStatus } from "../doctor/checks.js";
import { renderDoctor, renderSelection } from "./render.js";
import { selectNext } from "../queue/selector.js";
import { FakeBacklogAdapter } from "../testing/fake-backlog.js";
import { StateStore, CURRENT_SCHEMA_VERSION } from "../state/store.js";
import type { BacklogAdapter } from "../backlog/adapter.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { GitRefLease } from "../queue/git-lease.js";
import { FakeProviderAdapter } from "../testing/fake-provider.js";
import { FakeForgeAdapter } from "../testing/fake-forge.js";
import { SystemClock } from "../platform/clock.js";
import type { SelectedCandidate } from "../queue/selector.js";
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
  const local = resolve(repoRoot, "runmill.yaml");
  return local;
}

function loadOrExit(opts: GlobalOpts, repoRoot: string): { config: RunmillConfig; path: string } {
  const path = findConfigPath(opts.config, repoRoot);
  return loadConfig(path, { repoRoot });
}

/**
 * Build the backlog adapter.
 *
 * `RUNMILL_FAKE_BACKLOG` points at a JSON array of issues and selects the
 * in-memory adapter. This is how the end-to-end walkthrough runs without
 * credentials, and how the CLI is tested without a live backlog.
 */
function buildBacklog(config: RunmillConfig): BacklogAdapter {
  const fixture = process.env["RUNMILL_FAKE_BACKLOG"];
  if (fixture !== undefined && existsSync(fixture)) {
    return new FakeBacklogAdapter(JSON.parse(readFileSync(fixture, "utf8")));
  }
  if (config.backlog.provider === "linear") {
    throw RunmillError.fromCatalog("RM-AUTH-003", {
      whatHappened:
        "The Linear adapter needs a credential and none is configured.\n" +
        "Set RUNMILL_FAKE_BACKLOG=<fixture.json> to explore runmill without one.",
    });
  }
  throw RunmillError.fromCatalog("RM-CONFIG-001", {
    whatHappened: `No adapter for backlog.provider "${config.backlog.provider}"`,
  });
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
  process.stderr.write(`${String(err instanceof Error ? err.message : err)}\n`);
  process.exit(EXIT.failed);
}


/**
 * Assemble the orchestrator.
 *
 * Provider and forge adapters resolve from the environment so the loop can be
 * exercised without credentials. `RUNMILL_DEMO=1` substitutes deterministic
 * in-memory implementations for both; without it, the real adapters are
 * required and their absence is a named error rather than a silent fake.
 */
async function buildOrchestrator(
  cfg: RunmillConfig,
  backlog: BacklogAdapter,
  store: StateStore,
  candidate: SelectedCandidate,
  _opts: GlobalOpts,
): Promise<{ orchestrator: Orchestrator; lease: (runId: string) => GitRefLease }> {
  const demo = process.env["RUNMILL_DEMO"] === "1";
  if (!demo) {
    throw RunmillError.fromCatalog("RM-AUTH-003", {
      whatHappened:
        "Live provider and forge adapters are not configured.\n" +
        "Set RUNMILL_DEMO=1 to run the full loop with deterministic in-memory\n" +
        "provider and forge implementations.",
    });
  }

  const sourceRepo = process.env["RUNMILL_SOURCE_REPO"] ?? process.cwd();
  const clock = new SystemClock();

  const provider = new FakeProviderAdapter({
    byRole: {
      implementer: [
        { kind: "say", text: `implementing ${candidate.issue.identifier}` },
        {
          kind: "write",
          path: `runmill-demo-${candidate.issue.identifier}.md`,
          content: `# ${candidate.issue.title}\n\nImplemented by the demo agent.\n`,
        },
      ],
      "local-reviewer": [{ kind: "say", text: "reviewing" }],
    },
    outputByRole: {
      "local-reviewer": {
        verdict: "approved",
        scope_assessment: "within_scope",
        acceptance_criteria_met: [],
        findings: [],
      },
    },
    costUsdPerCall: 0.12,
  });

  const checks: CheckSpec[] = cfg.verification.commands.map((c) => ({
    id: c.id,
    run: c.run,
    required: true,
    source: "repository-policy" as const,
    report: c.report,
  }));

  return {
    orchestrator: new Orchestrator({
      backlog,
      provider,
      forge: new FakeForgeAdapter(),
      store,
      clock,
      config: cfg,
      sourceRepoPath: sourceRepo,
      workspaceRoot: join(
        process.env["RUNMILL_DATA_DIR"] ?? resolve(process.cwd(), ".runmill", "state"),
        "runs",
      ),
      checks,
      onEvent: (m) => {
        if (_opts.quiet !== true && _opts.json !== true) process.stdout.write(`  ${m}\n`);
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

export function buildProgram(): Command {
  const program = new Command();

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
    .action(async (cmdOpts: { check?: string }) => {
      const opts = program.opts<GlobalOpts>();
      const repoRoot = process.cwd();

      let providerImpl = "codex";
      try {
        providerImpl = loadOrExit(opts, repoRoot).config.provider.implementation;
      } catch {
        // doctor must still run without a valid config; the config check
        // itself is what reports that.
      }

      let results = await runAllChecks({ repoRoot }, providerImpl);
      if (cmdOpts.check !== undefined) {
        results = results.filter((r) => r.id.startsWith(cmdOpts.check as string));
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
        const backlog = buildBacklog(config);
        const result = await selectNext({ backlog, config, leasedIssueIds: new Set() });
        emit(opts, renderSelection(result), {
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
        const backlog = buildBacklog(cfg);
        const store = StateStore.open(
          resolve(
            process.env["RUNMILL_DATA_DIR"] ?? resolve(process.cwd(), ".runmill", "state"),
            "runmill.db",
          ),
        );

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

          const { orchestrator, lease } = await buildOrchestrator(cfg, backlog, store, candidate, opts);
          const runId = `run_${Date.now().toString(36)}`;
          const outcome = await orchestrator.run({
            runId,
            issue: candidate.issue,
            target: candidate.target,
            lease: lease(runId),
          });

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
      const path = resolve(
        process.env["RUNMILL_DATA_DIR"] ?? resolve(process.cwd(), ".runmill", "state"),
        "runmill.db",
      );
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

  return program;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  buildProgram().parseAsync(process.argv).catch((err: unknown) => {
    fail(err, {});
  });
}
