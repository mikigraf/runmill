import type { RunmillConfig } from "../config/types.js";
import { matchesRiskPath } from "../review/schema.js";

export { matchesRiskPath } from "../review/schema.js";

export type AutomaticMergeRiskDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "manual-approval"; readonly reasons: readonly string[] }
  | { readonly decision: "unknown"; readonly reasons: readonly string[] };

export interface AutomaticMergeRiskEvidence {
  readonly changedPaths: readonly string[];
  readonly issueLabels: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly checkManifestPath: string;
}

const RISK_TIERS = new Set(["low", "medium", "high", "critical"]);
const LOCKFILES = new Set([
  "Cargo.lock",
  "Gemfile.lock",
  "Package.resolved",
  "Pipfile.lock",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "flake.lock",
  "go.sum",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-lock.yml",
  "poetry.lock",
  "pubspec.lock",
  "uv.lock",
  "yarn.lock",
]);

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function conditionResult(
  condition: string,
  evidence: AutomaticMergeRiskEvidence,
): { readonly matched?: string; readonly unknown?: string } {
  switch (condition) {
    case "missing_acceptance_criteria":
      return !evidence.acceptanceCriteria.some((criterion) => criterion.trim() !== "")
        ? { matched: "the task packet has no acceptance criteria" }
        : {};
    case "check_config_changed": {
      if (matchesRiskPath("", evidence.checkManifestPath) === undefined) {
        return {
          unknown:
            `verification.manifest ${JSON.stringify(evidence.checkManifestPath)} cannot be ` +
            "matched against repository-relative changed paths",
        };
      }
      const changed = evidence.changedPaths.find(
        (path) => matchesRiskPath(path, evidence.checkManifestPath) === true,
      );
      return changed === undefined ? {} : { matched: `check manifest changed at ${changed}` };
    }
    case "lockfile_changed": {
      const changed = evidence.changedPaths.find((path) => {
        const segments = normalizePath(path).split("/");
        return LOCKFILES.has(segments.at(-1) ?? "");
      });
      return changed === undefined ? {} : { matched: `lockfile changed at ${changed}` };
    }
    case "public_api_change":
    case "permissions_change":
    case "secret_related_change":
      return {
        unknown:
          `risk.manual_approval.conditions contains ${condition}, which cannot be ` +
          "proved absent from changed paths and task metadata",
      };
    default:
      return {
        unknown: `risk.manual_approval.conditions contains unknown condition ${condition}`,
      };
  }
}

/**
 * Decide whether deterministic evidence permits automatic merge.
 *
 * This can only subtract permission. A low default and no matching rule do not
 * themselves authorize merge; every other merge gate still has to pass.
 */
export function evaluateAutomaticMergeRisk(
  risk: RunmillConfig["risk"],
  evidence: AutomaticMergeRiskEvidence,
): AutomaticMergeRiskDecision {
  const manualReasons: string[] = [];
  const unknownReasons: string[] = [];

  if (!RISK_TIERS.has(risk.default)) {
    unknownReasons.push(`risk.default has unknown tier ${String(risk.default)}`);
  } else if (risk.default !== "low") {
    manualReasons.push(
      `risk.default is ${risk.default}; only low-risk runs may merge automatically`,
    );
  }

  for (const rule of risk.manualApproval.paths) {
    if (matchesRiskPath("", rule) === undefined) {
      unknownReasons.push(
        `risk.manual_approval.paths rule ${JSON.stringify(rule)} uses unsupported or invalid syntax`,
      );
      continue;
    }
    for (const path of evidence.changedPaths) {
      const matched = matchesRiskPath(path, rule);
      if (matched) {
        manualReasons.push(
          `changed path ${JSON.stringify(path)} matches risk.manual_approval.paths rule ` +
            JSON.stringify(rule),
        );
        break;
      }
    }
  }

  const issueLabels = new Set(evidence.issueLabels.map((label) => label.trim().toLowerCase()));
  for (const label of risk.manualApproval.labels) {
    const normalizedLabel = label.trim().toLowerCase();
    if (normalizedLabel === "") {
      unknownReasons.push("risk.manual_approval.labels contains an empty label");
      continue;
    }
    if (issueLabels.has(normalizedLabel)) {
      manualReasons.push(
        `issue label ${JSON.stringify(label)} matches risk.manual_approval.labels`,
      );
    }
  }

  for (const condition of risk.manualApproval.conditions) {
    const result = conditionResult(condition, evidence);
    if (result.matched !== undefined) {
      manualReasons.push(
        `risk.manual_approval.conditions matched ${condition}: ${result.matched}`,
      );
    }
    if (result.unknown !== undefined) unknownReasons.push(result.unknown);
  }

  if (unknownReasons.length > 0) return { decision: "unknown", reasons: unknownReasons };
  if (manualReasons.length > 0) {
    return { decision: "manual-approval", reasons: manualReasons };
  }
  return { decision: "allow" };
}
