#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, parseConfig, validateConfig } from "../config/load.js";
import { RunmillError, renderError } from "../errors/runmill-error.js";
import { runAllChecks, worstStatus } from "../doctor/checks.js";
import { renderDoctor, renderSelection } from "./render.js";
import { selectNext } from "../queue/selector.js";
import { FakeBacklogAdapter } from "../testing/fake-backlog.js";
import { StateStore, CURRENT_SCHEMA_VERSION } from "../state/store.js";
import type { BacklogAdapter } from "../backlog/adapter.js";
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
