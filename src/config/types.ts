import type { AutonomyMode, RiskTier } from "../domain/types.js";
import type { RepositoryRule } from "../queue/repository-mapping.js";

/** Normalized, fully-defaulted configuration. Every optional key has resolved. */
export interface RunmillConfig {
  readonly version: 1;
  readonly autonomy: AutonomyMode;
  readonly provider: {
    readonly implementation: "codex" | "claude";
    readonly execution: "local";
    readonly maxTurns: number;
    readonly timeoutMinutes: number;
  };
  readonly backlog: {
    readonly provider: "linear" | "github-issues";
    readonly team: string;
    readonly eligibleStates: readonly string[];
    readonly claimState: string;
    readonly completedState?: string | undefined;
    readonly blockedState?: string | undefined;
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
      readonly deleteBranch: boolean;
    };
  };
  readonly workspace: {
    readonly strategy: "worktree";
    readonly gitIsolation: "separate-git-dir" | "clone";
    readonly sandbox: "native" | "container" | "none";
    readonly network: "proxy" | "none";
    readonly networkAllowlist: readonly string[];
    readonly allowUnenforced: readonly string[];
    readonly cleanUntrackedFiles: boolean;
  };
  readonly context: {
    readonly entryFiles: readonly string[];
    readonly maxInitialBytes: number;
    readonly progressiveDisclosure: boolean;
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
    readonly provider: "inherit" | "codex" | "claude";
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
    readonly costEnforcement: "auto" | "tokens-estimated" | "wall-and-invocations-only";
  };
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}
