import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalSuite, EvalTask, TaskSplit } from "./suite.js";
import { redactForReport } from "./suite.js";
import { scoreTask, summarize, type SuiteReport, type TaskAttempt } from "./score.js";
import { RunmillError } from "../errors/runmill-error.js";

/**
 * How one task is executed.
 *
 * Injected so replay can drive the real orchestrator, a recorded trace, or a
 * deterministic stub without this module knowing which. The evaluation harness
 * must not become a second implementation of the run loop — if it diverges,
 * it stops measuring the thing that ships.
 */
export type TaskRunner = (task: EvalTask, attempt: number) => Promise<TaskAttempt>;

export interface ReplayOptions {
  readonly suite: EvalSuite;
  readonly runner: TaskRunner;
  /** Repeats per task. Agent execution is stochastic; one sample is anecdote. */
  readonly repeats?: number | undefined;
  /** Restrict to one split. Held-out runs are deliberate, never incidental. */
  readonly split?: TaskSplit | undefined;
  readonly onProgress?: ((message: string) => void) | undefined;
}

export async function replaySuite(options: ReplayOptions): Promise<SuiteReport> {
  const repeats = Math.max(1, options.repeats ?? 1);
  const tasks = options.split === undefined
    ? options.suite.tasks
    : options.suite.tasks.filter((t) => t.split === options.split);

  const scores = [];
  for (const task of tasks) {
    const attempts: TaskAttempt[] = [];
    for (let attempt = 1; attempt <= repeats; attempt += 1) {
      // A task that throws is a failed attempt, not a failed suite: one broken
      // fixture must not discard the results of everything after it.
      try {
        attempts.push(await options.runner(task, attempt));
      } catch (err) {
        attempts.push({
          taskId: task.id,
          finalState: "HARNESS_ERROR",
          costUsd: 0,
          durationMs: 0,
          reason:
            err instanceof RunmillError && task.split !== "held-out"
              ? `${err.message}: ${err.whatHappened}`
              : err instanceof Error
                ? err.message
                : String(err),
        });
      }
    }
    const score = scoreTask(task, attempts);
    options.onProgress?.(
      `${score.passRate === 1 ? "✓" : "✗"} ${task.id}  ${(score.passRate * 100).toFixed(0)}%`,
    );
    scores.push(score);
  }

  return summarize(options.suite.name, scores, repeats);
}

/** Scratch directory for a task's fixture repository. */
export function makeTaskWorkspace(taskId: string): { path: string; cleanup: () => void } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(taskId)) {
    throw new Error(`unsafe evaluation task id ${JSON.stringify(taskId)}`);
  }
  const path = mkdtempSync(join(tmpdir(), `runmill-eval-${taskId}-`));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

function bar(rate: number, width = 20): string {
  const filled = Math.round(rate * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

export function renderReport(report: SuiteReport): string {
  const out: string[] = [
    `${report.suite}  —  ${report.repeats} run(s) per task`,
    "",
  ];

  for (const split of report.splits) {
    const [low, high] = split.interval;
    out.push(
      `  ${split.split.padEnd(12)} ${bar(split.passRate)} ${pct(split.passRate).padStart(4)}` +
        `  (${split.passed}/${split.tasks}, 95% CI ${pct(low)}–${pct(high)})`,
    );
  }

  // Reported on its own line, always. An aggregate score can be lifted by
  // merging changes that should have been stopped, and the aggregate alone
  // would read that as an improvement.
  const { correct, total } = report.refusalAccuracy;
  if (total > 0) {
    out.push("");
    out.push(
      `  correctly refused  ${correct}/${total}` +
        (correct === total ? "" : "   ← a harness that merges these is worse, not faster"),
    );
  }

  const failures = report.scores.filter((s) => s.passRate < 1);
  if (failures.length > 0) {
    out.push("");
    out.push(`Failures (${failures.length}):`);
    for (const score of failures) {
      const shown = redactForReport(score.task);
      out.push(`  ${score.task.id}  ${pct(score.passRate)}  ${shown["title"] ?? "(held out)"}`);
      for (const evaluator of score.evaluators) {
        if (evaluator.passed) continue;
        out.push(`      ✗ ${evaluator.evaluator}: ${evaluator.detail}`);
      }
    }
  }

  const totalCost = report.scores
    .flatMap((s) => s.attempts)
    .reduce((sum, a) => sum + a.costUsd, 0);
  out.push("");
  out.push(`  spend  $${totalCost.toFixed(2)}`);

  return out.join("\n");
}

/** Machine-readable form, with held-out task details redacted. */
export function reportToJson(report: SuiteReport): Record<string, unknown> {
  return {
    suite: report.suite,
    repeats: report.repeats,
    splits: report.splits,
    refusalAccuracy: report.refusalAccuracy,
    tasks: report.scores.map((score) => ({
      ...redactForReport(score.task),
      passRate: score.passRate,
      interval: score.interval,
      evaluators: score.task.split === "held-out" ? undefined : score.evaluators,
    })),
  };
}
