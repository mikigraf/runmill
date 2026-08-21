import type { AutonomyMode, RiskTier } from "../domain/types.js";
import type { RepositoryRule } from "../queue/repository-mapping.js";

/** Normalized, fully-defaulted configuration. Every optional key has resolved. */
export interface RunmillConfig {
  readonly version: 1;
  readonly autonomy: AutonomyMode;
  readonly experimental: {
    /** Second, explicit acknowledgement required before Runmill may merge. */
    readonly automaticMerge: boolean;
  };
  /**
   * Which agent runs which role.
   *
   * One block rather than two, because picking the implementer and picking the
   * reviewer is one decision made twice. Splitting it across `provider` and
   * `review.provider` meant the second half was easy to miss, and the section
   * that held it was also holding review policy that has nothing to do with
   * which agent runs.
   */
  readonly providers: {
    readonly execution: "local";
    /** Claude per-invocation turn cap; Codex has no equivalent CLI flag. */
    readonly maxTurns: number;
    readonly timeoutMinutes: number;
    readonly implementer: {
      readonly implementation: "codex" | "claude";
      /** Model id passed to the CLI. Undefined means the CLI's own default. */
      readonly model?: string | undefined;
    };
    readonly reviewer: {
      /** `inherit` reuses the implementer's CLI. */
      readonly implementation: "inherit" | "codex" | "claude";
      /** Inherits the model only when the reviewer uses the implementer's CLI. */
      readonly model?: string | undefined;
    };
  };
  readonly backlog: {
    readonly provider: "linear";
    readonly team: string;
    readonly eligibleStates: readonly string[];
    readonly claimState: string;
    readonly completedState?: string | undefined;
    readonly deliveredState?: string | undefined;
    readonly includeLabels: readonly string[];
    readonly excludeLabels: readonly string[];
    readonly maxEstimate?: number | undefined;
    readonly allowUnassigned: boolean;
    readonly claimAssignee?: string | undefined;
    readonly selection: {
      readonly priorityFirst: boolean;
      readonly unprioritizedLast: boolean;
      readonly dueDateTiebreaker: boolean;
      readonly oldestFirst: boolean;
    };
  };
  readonly github: {
    readonly repositories: readonly RepositoryRule[];
    readonly branchTemplate: string;
    readonly draftPr: boolean;
    readonly merge: {
      readonly method: "squash" | "merge" | "rebase";
    };
  };
  readonly workspace: {
    readonly strategy: "worktree";
    readonly gitIsolation: "clone";
    readonly sandbox: "native" | "none";
    readonly network: "proxy" | "none";
    readonly networkAllowlist: readonly string[];
    readonly allowUnenforced: readonly string[];
  };
  readonly verification: {
    readonly manifest: string;
    readonly failOnMissingCheck: boolean;
    readonly failOnSkippedCheck: boolean;
    readonly commands: readonly {
      readonly id: string;
      readonly run: string;
      readonly report?: { readonly path: string; readonly format: string } | undefined;
    }[];
  };
  readonly review: {
    readonly localReviewSkill?: string | undefined;
    readonly prReviewSkill?: string | undefined;
    readonly freshContext: true;
    readonly maxFixIterations: number;
    readonly mergeBlockingSeverities: readonly string[];
    readonly requireAllFindingsResolved: boolean;
  };
  readonly risk: {
    readonly default: RiskTier;
    readonly manualApproval: {
      readonly paths: readonly string[];
      readonly labels: readonly string[];
      readonly conditions: readonly string[];
    };
  };
  readonly budgets: {
    readonly maxCostUsdPerIssue?: number | undefined;
    readonly maxWallMinutesPerIssue: number;
    readonly dailyCostUsd?: number | undefined;
    readonly dailyWindow: "utc" | "local";
    readonly maxAgentInvocations: {
      readonly total: number;
      readonly implementer: number;
      readonly localReview: number;
      readonly fixer: number;
      readonly prReview: number;
      readonly prFixer: number;
    };
    readonly clampInvocationTimeoutToRemaining: boolean;
    readonly costEnforcement: "auto" | "wall-and-invocations-only";
  };
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}
