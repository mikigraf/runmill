import { Command } from "commander";
import { loadSuite, suiteStats, type EvalTask, type TaskSplit } from "../eval/suite.js";
import { orchestratorRunner } from "../eval/orchestrator-runner.js";
import { loadConfig } from "../config/load.js";
import { replaySuite, renderReport, reportToJson } from "../eval/replay.js";
import type { TaskAttempt } from "../eval/score.js";
import type { CommandContext } from "./extra-commands.js";

const SPLITS: readonly TaskSplit[] = ["development", "validation", "held-out"];

/**
 * `runmill eval` — measure the harness against a repository's own history.
 *
 * Public benchmarks compare broad agent capability. What matters in production
 * is whether THIS harness does the right thing on THIS repository's work,
 * including the work it should refuse.
 */
export function registerEvalCommands(program: Command, ctx: CommandContext): void {
  const evaluate = program.command("eval").description("Measure the harness against a task suite");

  evaluate
    .command("validate")
    .argument("<suite>", "path to a suite file")
    .description("Check a suite's structure and report its composition")
    .action((suitePath: string) => {
      try {
        const suite = loadSuite(suitePath, ctx.repoRoot());
        const stats = suiteStats(suite);
        ctx.emit(
          [
            `✓ ${suitePath} is valid`,
            "",
            `  tasks        ${stats.total}`,
            `  development  ${stats.bySplit.development}`,
            `  validation   ${stats.bySplit.validation}`,
            `  held-out     ${stats.bySplit["held-out"]}`,
            "",
            // Surfaced prominently because it is the number that decides
            // whether the suite measures judgment or only throughput.
            `  should stop  ${(stats.refusalShare * 100).toFixed(0)}% of tasks expect escalation or refusal`,
          ].join("\n"),
          { valid: true, path: suitePath, stats },
        );
        process.exit(ctx.exitCodes.ok);
      } catch (err) {
        ctx.fail(err);
      }
    });

  evaluate
    .command("replay")
    .argument("<suite>", "path to a suite file")
    .option("--repeat <n>", "runs per task; agent execution is stochastic", "1")
    .option("--split <split>", `restrict to one of: ${SPLITS.join(", ")}`)
    .option("--dry-run", "score without dispatching an agent")
    .description("Replay a suite and report pass rates with confidence intervals")
    .action(async (suitePath: string, opts: { repeat?: string; split?: string; dryRun?: boolean }) => {
      try {
        const suite = loadSuite(suitePath, ctx.repoRoot());
        const repeats = Number.parseInt(opts.repeat ?? "1", 10);
        if (!Number.isFinite(repeats) || repeats < 1) {
          ctx.fail(new Error(`--repeat must be a positive integer, got "${opts.repeat}"`));
        }
        if (opts.split !== undefined && !SPLITS.includes(opts.split as TaskSplit)) {
          ctx.fail(new Error(`--split must be one of ${SPLITS.join(", ")}`));
        }

        const report = await replaySuite({
          suite,
          repeats,
          split: opts.split as TaskSplit | undefined,
          runner:
            opts.dryRun === true
              ? dryRunner
              : orchestratorRunner({
                  config: loadConfig(ctx.configPath(), { repoRoot: ctx.repoRoot() }).config,
                  defaultRepoPath: ctx.repoRoot(),
                  demo: process.env["RUNMILL_DEMO"] === "1",
                }),
          onProgress: (message) => {
            if (process.env["RUNMILL_QUIET"] !== "1") process.stderr.write(`  ${message}\n`);
          },
        });

        const mode = opts.dryRun === true ? "dry-run (no agent dispatched)" : "live";
        ctx.emit(
          `${renderReport(report)}\n  mode   ${mode}`,
          { ...reportToJson(report), mode },
        );

        // A suite where a refusal task merged is a regression regardless of the
        // aggregate, so it decides the exit code on its own.
        const refusalsIntact =
          report.refusalAccuracy.total === report.refusalAccuracy.correct;
        const allPassed = report.scores.every((s) => s.passRate === 1);
        process.exit(allPassed && refusalsIntact ? ctx.exitCodes.ok : ctx.exitCodes.failed);
      } catch (err) {
        ctx.fail(err);
      }
    });
}

/**
 * Scores a suite without dispatching anything.
 *
 * Every task reports the outcome it declared it expects, so a `--dry-run`
 * always scores 100%. That is useful for exactly one thing — checking that a
 * suite is wired up and its evaluators agree — and useless as evidence, so the
 * report says which mode produced it.
 */
const dryRunner = async (task: EvalTask): Promise<TaskAttempt> => ({
  taskId: task.id,
  finalState: STATE_FOR_EXPECTED[task.expected] ?? "NEEDS_HUMAN",
  costUsd: 0,
  durationMs: 0,
  changedPaths: [],
});

const STATE_FOR_EXPECTED: Record<string, string> = {
  merge: "COMPLETED",
  deliver: "PR_DELIVERED",
  escalate: "NEEDS_HUMAN",
  refuse: "QUARANTINED",
};

