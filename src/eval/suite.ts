import { parse as parseYaml } from "yaml";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { RunmillError } from "../errors/runmill-error.js";

/**
 * What a task is supposed to prove.
 *
 * `escalate` and `refuse` are the load-bearing ones. A suite where every task
 * should merge measures only throughput, and optimising against it produces a
 * harness that merges everything — which is exactly the failure this system
 * exists to prevent. A suite must contain tasks whose correct outcome is
 * "stopped and asked a human".
 */
export type ExpectedOutcome = "merge" | "deliver" | "escalate" | "refuse";

export type TaskKind =
  | "bug-fix"
  | "feature"
  | "refactor"
  | "test-addition"
  | "documentation"
  | "dependency"
  | "ui"
  | "operational"
  | "underspecified"
  | "high-risk";

/**
 * Which set a task belongs to.
 *
 * The optimizer may see development traces and validation scores. It must not
 * see held-out task details or evaluator implementations — an optimizer will
 * exploit whatever signal it can modify or infer, so the only defence is that
 * the signal is unavailable.
 */
export type TaskSplit = "development" | "validation" | "held-out";

export interface EvalTask {
  readonly id: string;
  readonly kind: TaskKind;
  readonly split: TaskSplit;
  /** Fixture repository, or a git ref in the repository under evaluation. */
  readonly repoPath?: string | undefined;
  readonly baseCommit?: string | undefined;
  /**
   * Checkout containing an npm install for the exact base commit. Replay
   * validates its manifests and installed inventory before reusing it.
   */
  readonly dependencyPath?: string | undefined;
  readonly issue: {
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
    readonly labels: readonly string[];
    /** Defaults to the configured backlog team. */
    readonly team?: string | undefined;
    /** Defaults to the first configured eligible state. */
    readonly state?: string | undefined;
    /** Participates in repository routing when present. */
    readonly project?: string | undefined;
  };
  readonly expected: ExpectedOutcome;
  /** Why this outcome is correct. Read by a human reviewing a regression. */
  readonly rationale?: string | undefined;
  /** Paths the change is allowed to touch. Anything else is out of scope. */
  readonly allowedPaths?: readonly string[] | undefined;
  /** Commands that must pass against the produced change. */
  readonly checks?: readonly { readonly id: string; readonly run: string }[] | undefined;
}

export interface EvalSuite {
  readonly name: string;
  readonly tasks: readonly EvalTask[];
}

const OUTCOMES = new Set<string>(["merge", "deliver", "escalate", "refuse"]);
const SPLITS = new Set<string>(["development", "validation", "held-out"]);
const KINDS = new Set<string>([
  "bug-fix",
  "feature",
  "refactor",
  "test-addition",
  "documentation",
  "dependency",
  "ui",
  "operational",
  "underspecified",
  "high-risk",
]);
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;

function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asOptionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

export function parseSuite(source: string): EvalSuite {
  const raw = asRecord(parseYaml(source));
  const tasks = asArray<unknown>(raw["tasks"]).map((entry): EvalTask => {
    const t = asRecord(entry);
    const issue = asRecord(t["issue"]);
    return {
      id: String(t["id"] ?? ""),
      kind: (t["kind"] ?? "bug-fix") as TaskKind,
      split: (t["split"] ?? "development") as TaskSplit,
      repoPath: asOptionalString(t["repo_path"]),
      baseCommit: asOptionalString(t["base_commit"]),
      dependencyPath: asOptionalString(t["dependency_path"]),
      issue: {
        identifier: String(issue["identifier"] ?? t["id"] ?? ""),
        title: String(issue["title"] ?? ""),
        description: String(issue["description"] ?? ""),
        labels: asArray<string>(issue["labels"]),
        team: asOptionalString(issue["team"]),
        state: asOptionalString(issue["state"]),
        project: asOptionalString(issue["project"]),
      },
      expected: (t["expected"] ?? "deliver") as ExpectedOutcome,
      rationale: t["rationale"] as string | undefined,
      allowedPaths: t["allowed_paths"] as readonly string[] | undefined,
      checks: asArray<Record<string, unknown>>(t["checks"]).map((c) => ({
        id: String(c["id"] ?? ""),
        run: String(c["run"] ?? ""),
      })),
    };
  });

  return { name: String(raw["name"] ?? "unnamed"), tasks };
}

/** Every structural problem, reported at once. */
export function validateSuite(suite: EvalSuite): readonly string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const [index, task] of suite.tasks.entries()) {
    const where = task.id === "" ? `tasks[${index}]` : `task "${task.id}"`;
    if (task.id === "") errors.push(`${where}: missing id`);
    else if (!SAFE_TASK_ID.test(task.id)) {
      errors.push(
        `${where}: id must be 1-80 ASCII letters, digits, dots, underscores, or hyphens, ` +
          "and must start with a letter or digit",
      );
    }
    if (seen.has(task.id)) errors.push(`${where}: duplicate id`);
    seen.add(task.id);

    if (!OUTCOMES.has(task.expected)) {
      errors.push(`${where}: expected must be one of ${[...OUTCOMES].join(", ")}`);
    }
    if (!SPLITS.has(task.split)) {
      errors.push(`${where}: split must be one of ${[...SPLITS].join(", ")}`);
    }
    if (!KINDS.has(task.kind)) {
      errors.push(`${where}: unknown kind "${task.kind}"`);
    }
    if (task.issue.title === "") errors.push(`${where}: issue.title is required`);
    for (const [field, value] of [
      ["repo_path", task.repoPath],
      ["base_commit", task.baseCommit],
      ["dependency_path", task.dependencyPath],
      ["issue.team", task.issue.team],
      ["issue.state", task.issue.state],
      ["issue.project", task.issue.project],
    ] as const) {
      if (value !== undefined && value.trim() === "") {
        errors.push(`${where}: ${field} must not be empty when provided`);
      }
    }
  }

  if (suite.tasks.length === 0) {
    errors.push("suite contains no tasks");
    return errors;
  }

  // A suite that only contains work the agent should complete measures
  // throughput and nothing else. Optimising against it rewards a harness that
  // merges everything, which is the exact failure mode the product exists to
  // prevent.
  const refusals = suite.tasks.filter((t) => t.expected === "escalate" || t.expected === "refuse");
  if (refusals.length === 0) {
    errors.push(
      "suite has no task that should escalate or be refused — a suite of only " +
        "completable work rewards a harness that merges everything",
    );
  }

  return errors;
}

export interface SuiteStats {
  readonly total: number;
  readonly bySplit: Readonly<Record<TaskSplit, number>>;
  readonly byExpected: Readonly<Record<string, number>>;
  readonly refusalShare: number;
}

export function suiteStats(suite: EvalSuite): SuiteStats {
  const bySplit = { development: 0, validation: 0, "held-out": 0 };
  const byExpected: Record<string, number> = {};
  for (const task of suite.tasks) {
    bySplit[task.split] = (bySplit[task.split] ?? 0) + 1;
    byExpected[task.expected] = (byExpected[task.expected] ?? 0) + 1;
  }
  const refusals = (byExpected["escalate"] ?? 0) + (byExpected["refuse"] ?? 0);
  return {
    total: suite.tasks.length,
    bySplit,
    byExpected,
    refusalShare: suite.tasks.length === 0 ? 0 : refusals / suite.tasks.length,
  };
}

export function loadSuite(path: string, cwd = process.cwd()): EvalSuite {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  if (!existsSync(absolute)) {
    throw RunmillError.fromCatalog("RM-EVAL-001", {
      whatHappened: `No evaluation suite at ${absolute}`,
    });
  }

  let suite: EvalSuite;
  try {
    suite = parseSuite(readFileSync(absolute, "utf8"));
  } catch (cause) {
    throw RunmillError.fromCatalog("RM-EVAL-001", {
      whatHappened: `${path} is not valid YAML.\n  ${(cause as Error).message}`,
    });
  }

  const errors = validateSuite(suite);
  if (errors.length > 0) {
    throw RunmillError.fromCatalog("RM-EVAL-001", {
      whatHappened: `${path} is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    });
  }
  return suite;
}

/**
 * A task as it may appear in output.
 *
 * Held-out tasks are reduced to an id and an outcome. Printing their titles,
 * descriptions, or rationales into a trace an optimizer can read is how a
 * held-out set stops being held out — and it would happen by accident, through
 * a debug log, long before anyone did it deliberately.
 */
export function redactForReport(task: EvalTask): Record<string, unknown> {
  if (task.split !== "held-out") {
    return {
      id: task.id,
      kind: task.kind,
      split: task.split,
      title: task.issue.title,
      expected: task.expected,
    };
  }
  return { id: task.id, split: task.split, kind: task.kind };
}
