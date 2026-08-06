import { parse as parseYaml } from "yaml";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { RunmillError } from "../errors/runmill-error.js";
import { findConflictingRules, type RepositoryRule } from "../queue/repository-mapping.js";
import type { RunmillConfig, ValidationResult } from "./types.js";

export type { RunmillConfig } from "./types.js";

const DEFAULT_BRANCH_TEMPLATE = "runmill/{issue_identifier}-{slug}-{attempt}";

function asArray<T>(value: unknown, fallback: readonly T[] = []): readonly T[] {
  return Array.isArray(value) ? (value as T[]) : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Parse YAML into a fully-defaulted config.
 *
 * Configuration is explicit rather than inferred, but "explicit" applies to
 * what the operator *decides*, not to boilerplate: every key that has an
 * obvious correct value gets a documented default here so the file stays
 * readable and a missing key never means "undefined behavior".
 */
export function parseConfig(source: string): RunmillConfig {
  const raw = asRecord(parseYaml(source));

  const provider = asRecord(raw["provider"]);
  const backlog = asRecord(raw["backlog"]);
  const selection = asRecord(backlog["selection"]);
  const github = asRecord(raw["github"]);
  const merge = asRecord(github["merge"]);
  const workspace = asRecord(raw["workspace"]);
  const context = asRecord(raw["context"]);
  const verification = asRecord(raw["verification"]);
  const review = asRecord(raw["review"]);
  const risk = asRecord(raw["risk"]);
  const manualApproval = asRecord(risk["manual_approval"]);
  const budgets = asRecord(raw["budgets"]);
  const invocations = asRecord(budgets["max_agent_invocations"]);

  const repositories: RepositoryRule[] = asArray<Record<string, unknown>>(
    github["repositories"],
  ).map((rule) => {
    const r = asRecord(rule);
    const match = asRecord(r["match"]);
    return {
      match: {
        team: match["team"] as string | undefined,
        project: match["project"] as string | undefined,
        label: match["label"] as string | undefined,
      },
      repo: String(r["repo"] ?? ""),
      baseBranch: String(r["base_branch"] ?? "main"),
    };
  });

  return {
    version: (raw["version"] ?? 1) as 1,
    autonomy: (raw["autonomy"] ?? "pr-only") as RunmillConfig["autonomy"],
    provider: {
      implementation: (provider["implementation"] ?? "codex") as "codex" | "claude",
      execution: "local",
      maxTurns: Number(provider["max_turns"] ?? 80),
      timeoutMinutes: Number(provider["timeout_minutes"] ?? 120),
    },
    backlog: {
      provider: (backlog["provider"] ?? "linear") as "linear" | "github-issues",
      team: String(backlog["team"] ?? ""),
      eligibleStates: asArray<string>(backlog["eligible_states"]),
      claimState: String(backlog["claim_state"] ?? ""),
      completedState: backlog["completed_state"] as string | undefined,
      blockedState: backlog["blocked_state"] as string | undefined,
      deliveredState: backlog["delivered_state"] as string | undefined,
      includeLabels: asArray<string>(backlog["include_labels"]),
      excludeLabels: asArray<string>(backlog["exclude_labels"]),
      maxEstimate: backlog["max_estimate"] as number | undefined,
      allowUnassigned: backlog["allow_unassigned"] !== false,
      claimAssignee: backlog["claim_assignee"] as string | undefined,
      selection: {
        priorityFirst: selection["priority_first"] !== false,
        unprioritizedLast: selection["unprioritized_last"] !== false,
        dueDateTiebreaker: selection["due_date_tiebreaker"] !== false,
        oldestFirst: selection["oldest_first"] !== false,
      },
    },
    github: {
      repositories,
      branchTemplate: String(github["branch_template"] ?? DEFAULT_BRANCH_TEMPLATE),
      draftPr: github["draft_pr"] !== false,
      merge: {
        method: (merge["method"] ?? "squash") as "squash" | "merge" | "rebase",
        deleteBranch: merge["delete_branch"] !== false,
      },
    },
    workspace: {
      strategy: "worktree",
      gitIsolation: (workspace["git_isolation"] ?? "separate-git-dir") as
        | "separate-git-dir"
        | "clone",
      sandbox: (workspace["sandbox"] ?? "native") as "native" | "container" | "none",
      network: (workspace["network"] ?? "proxy") as "proxy" | "none",
      networkAllowlist: asArray<string>(workspace["network_allowlist"]),
      allowUnenforced: asArray<string>(workspace["allow_unenforced"]),
      cleanUntrackedFiles: workspace["clean_untracked_files"] !== false,
    },
    context: {
      entryFiles: asArray<string>(context["entry_files"]),
      maxInitialBytes: Number(context["max_initial_bytes"] ?? 50_000),
      progressiveDisclosure: context["progressive_disclosure"] !== false,
    },
    verification: {
      manifest: String(verification["manifest"] ?? ".runmill/checks.yaml"),
      failOnMissingCheck: verification["fail_on_missing_check"] !== false,
      failOnSkippedCheck: verification["fail_on_skipped_check"] !== false,
      commands: asArray<Record<string, unknown>>(verification["commands"]).map((c) => {
        const cmd = asRecord(c);
        const report = cmd["report"] === undefined ? undefined : asRecord(cmd["report"]);
        return {
          id: String(cmd["id"] ?? ""),
          run: String(cmd["run"] ?? ""),
          report:
            report === undefined
              ? undefined
              : { path: String(report["path"] ?? ""), format: String(report["format"] ?? "") },
        };
      }),
    },
    review: {
      localReviewSkill: review["local_review_skill"] as string | undefined,
      prReviewSkill: review["pr_review_skill"] as string | undefined,
      freshContext: true,
      provider: (review["provider"] ?? "inherit") as "inherit" | "codex" | "claude",
      maxFixIterations: Number(review["max_fix_iterations"] ?? 3),
      mergeBlockingSeverities: asArray<string>(review["merge_blocking_severities"], [
        "critical",
        "high",
      ]),
      requireAllFindingsResolved: review["require_all_findings_resolved"] !== false,
    },
    risk: {
      default: (risk["default"] ?? "medium") as RunmillConfig["risk"]["default"],
      manualApproval: {
        paths: asArray<string>(manualApproval["paths"]),
        labels: asArray<string>(manualApproval["labels"]),
        conditions: asArray<string>(manualApproval["conditions"]),
      },
    },
    budgets: {
      maxCostUsdPerIssue: budgets["max_cost_usd_per_issue"] as number | undefined,
      maxWallMinutesPerIssue: Number(budgets["max_wall_minutes_per_issue"] ?? 240),
      dailyCostUsd: budgets["daily_cost_usd"] as number | undefined,
      dailyWindow: (budgets["daily_window"] ?? "utc") as "utc" | "local",
      maxAgentInvocations: {
        total: Number(invocations["total"] ?? 14),
        implementer: Number(invocations["implementer"] ?? 1),
        localReview: Number(invocations["local_review"] ?? 4),
        fixer: Number(invocations["fixer"] ?? 3),
        prReview: Number(invocations["pr_review"] ?? 3),
        prFixer: Number(invocations["pr_fixer"] ?? 2),
      },
      clampInvocationTimeoutToRemaining: budgets["clamp_invocation_timeout_to_remaining"] !== false,
      costEnforcement: (budgets["cost_enforcement"] ?? "auto") as
        | "auto"
        | "tokens-estimated"
        | "wall-and-invocations-only",
    },
  };
}

const AUTONOMY_MODES = new Set(["observe", "pr-only", "guarded-merge", "continuous"]);

/**
 * Structural and cross-field validation.
 *
 * Reports every violation rather than the first, because a developer fixing
 * configuration one error per run is the friction this product exists to
 * remove.
 */
export function validateConfig(config: RunmillConfig): ValidationResult {
  const errors: string[] = [];

  if (config.version !== 1) {
    errors.push(`version must be 1, got ${String(config.version)}`);
  }
  if (!AUTONOMY_MODES.has(config.autonomy)) {
    errors.push(
      `autonomy must be one of ${[...AUTONOMY_MODES].join(", ")}, got "${String(config.autonomy)}"`,
    );
  }
  if (config.backlog.team === "") {
    errors.push("backlog.team is required");
  }
  if (config.backlog.eligibleStates.length === 0) {
    errors.push("backlog.eligible_states must list at least one state");
  }
  if (config.backlog.claimState === "") {
    errors.push("backlog.claim_state is required");
  }

  if (config.github.repositories.length === 0) {
    errors.push("github.repositories must contain at least one mapping rule");
  }
  for (const [i, rule] of config.github.repositories.entries()) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(rule.repo)) {
      errors.push(`github.repositories[${i}].repo must be "owner/name", got "${rule.repo}"`);
    }
    const keys = Object.values(rule.match).filter((v) => v !== undefined);
    if (keys.length === 0) {
      errors.push(`github.repositories[${i}].match needs at least one condition`);
    }
  }
  for (const conflict of findConflictingRules(config.github.repositories)) {
    errors.push(
      conflict.kind === "duplicate"
        ? `github.repositories: identical match conditions at ${conflict.indices.join(" and ")} resolve to different repositories`
        : `github.repositories: ${conflict.message}`,
    );
  }

  if (!config.github.branchTemplate.includes("{attempt}")) {
    errors.push(
      "github.branch_template must contain {attempt}; without it a retry reuses the " +
        "previous run's branch and silently adopts its pull request",
    );
  }

  if (config.review.maxFixIterations > config.budgets.maxAgentInvocations.fixer) {
    errors.push(
      `review.max_fix_iterations (${config.review.maxFixIterations}) exceeds ` +
        `budgets.max_agent_invocations.fixer (${config.budgets.maxAgentInvocations.fixer}); ` +
        "the fix loop would exhaust its budget mid-flight",
    );
  }

  const perRole =
    config.budgets.maxAgentInvocations.implementer +
    config.budgets.maxAgentInvocations.localReview +
    config.budgets.maxAgentInvocations.fixer +
    config.budgets.maxAgentInvocations.prReview +
    config.budgets.maxAgentInvocations.prFixer;
  if (perRole > config.budgets.maxAgentInvocations.total) {
    errors.push(
      `budgets.max_agent_invocations: per-role budgets sum to ${perRole}, above total ` +
        `${config.budgets.maxAgentInvocations.total}`,
    );
  }

  if (config.workspace.sandbox === "none" && config.autonomy !== "observe") {
    errors.push('workspace.sandbox "none" is only permitted in observe mode');
  }

  return { valid: errors.length === 0, errors };
}

export interface LoadOptions {
  /** Root used to resolve relative paths referenced by the config. */
  readonly repoRoot: string;
}

/**
 * Load, validate, and eagerly check every referenced path.
 *
 * FR-22: nothing config-shaped may first fail after an agent has been
 * dispatched. A missing review skill discovered at LOCAL_REVIEW costs twenty
 * minutes and real model spend; discovered here it costs nothing.
 */
export function loadConfig(
  path: string,
  options: LoadOptions,
): { config: RunmillConfig; path: string } {
  if (!existsSync(path)) {
    throw RunmillError.fromCatalog("RM-CONFIG-002", {
      whatHappened: `No configuration file at ${path}`,
    });
  }

  const config = parseConfig(readFileSync(path, "utf8"));

  const result = validateConfig(config);
  if (!result.valid) {
    throw RunmillError.fromCatalog("RM-CONFIG-001", {
      whatHappened: `${path}\n\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
    });
  }

  const referenced: { key: string; value: string }[] = [];
  if (config.review.localReviewSkill !== undefined) {
    referenced.push({ key: "review.local_review_skill", value: config.review.localReviewSkill });
  }
  if (config.review.prReviewSkill !== undefined) {
    referenced.push({ key: "review.pr_review_skill", value: config.review.prReviewSkill });
  }
  for (const entry of config.context.entryFiles) {
    referenced.push({ key: "context.entry_files", value: entry });
  }

  const missing = referenced.filter(({ value }) => {
    const abs = isAbsolute(value) ? value : resolve(options.repoRoot, value);
    return !existsSync(abs);
  });

  if (missing.length > 0) {
    throw RunmillError.fromCatalog("RM-CONFIG-002", {
      whatHappened:
        `${path} references files that do not exist:\n` +
        missing.map((m) => `  - ${m.key}: ${m.value}`).join("\n"),
    });
  }

  return { config, path };
}
