import type { BacklogIssue, RepositoryTarget } from "../domain/types.js";

/**
 * One ordered mapping rule. Every key present in `match` must hold for the
 * rule to fire (AND, never OR).
 */
export interface RepositoryRule {
  readonly match: {
    readonly team?: string | undefined;
    readonly project?: string | undefined;
    readonly label?: string | undefined;
  };
  readonly repo: string;
  readonly baseBranch: string;
}

export interface RepositoryResolution {
  readonly resolved: boolean;
  readonly target?: RepositoryTarget | undefined;
  readonly matchedRuleIndex?: number | undefined;
  readonly reason?: string | undefined;
  readonly code?: string | undefined;
}

function ruleMatches(issue: BacklogIssue, rule: RepositoryRule): boolean {
  const { team, project, label } = rule.match;
  if (team !== undefined && issue.teamKey !== team) return false;
  if (project !== undefined && issue.projectName !== project) return false;
  if (label !== undefined && !issue.labels.includes(label)) return false;
  // A match block with no keys would match everything; treat it as invalid
  // rather than as a catch-all, so a typo cannot silently capture the backlog.
  if (team === undefined && project === undefined && label === undefined) return false;
  return true;
}

/**
 * Resolve an issue to exactly one repository. Ordered, first match wins.
 *
 * Never guesses. An issue that matches no rule is unresolved, which makes it
 * ineligible with a named reason — the lease ref lives in the mapped
 * repository, so an unresolvable mapping has no lease target and must fail at
 * eligibility rather than at runtime.
 */
export function resolveRepository(
  issue: BacklogIssue,
  rules: readonly RepositoryRule[],
): RepositoryResolution {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule !== undefined && ruleMatches(issue, rule)) {
      return {
        resolved: true,
        target: { repo: rule.repo, baseBranch: rule.baseBranch },
        matchedRuleIndex: index,
      };
    }
  }
  return {
    resolved: false,
    code: "RM-SELECT-002",
    reason:
      `no repository rule matched issue ${issue.identifier} ` +
      `(team=${issue.teamKey}, project=${issue.projectName ?? "-"}, labels=[${issue.labels.join(",")}])`,
  };
}

export type RuleConflictKind = "duplicate" | "shadowed";

export interface RuleConflict {
  readonly kind: RuleConflictKind;
  readonly indices: readonly [number, number];
  readonly message: string;
}

function matchKeys(rule: RepositoryRule): string[] {
  return Object.entries(rule.match)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .sort();
}

/** True when everything `narrow` matches is also matched by `broad`. */
function isShadowedBy(narrow: RepositoryRule, broad: RepositoryRule): boolean {
  const broadKeys = matchKeys(broad);
  const narrowKeys = new Set(matchKeys(narrow));
  if (broadKeys.length === 0 || broadKeys.length >= narrowKeys.size) return false;
  return broadKeys.every((k) => narrowKeys.has(k));
}

/**
 * Static analysis of a rule set, run by `runmill config validate` and `doctor`.
 *
 * Ordered first-match-wins cannot produce a runtime ambiguity, so ambiguity is
 * caught here instead: two rules with identical match specs pointing at
 * different repositories, and rules that can never fire because an earlier,
 * broader rule always wins first.
 */
export function findConflictingRules(rules: readonly RepositoryRule[]): RuleConflict[] {
  const conflicts: RuleConflict[] = [];

  for (let i = 0; i < rules.length; i += 1) {
    const a = rules[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < rules.length; j += 1) {
      const b = rules[j];
      if (b === undefined) continue;

      const sameMatch = matchKeys(a).join("&") === matchKeys(b).join("&");
      if (sameMatch && a.repo !== b.repo) {
        conflicts.push({
          kind: "duplicate",
          indices: [i, j],
          message:
            `rules ${i} and ${j} have identical match conditions but resolve to ` +
            `different repositories (${a.repo} vs ${b.repo}); rule ${j} can never fire`,
        });
        continue;
      }

      if (!sameMatch && isShadowedBy(b, a)) {
        conflicts.push({
          kind: "shadowed",
          indices: [i, j],
          message:
            `rule ${j} is shadowed by the broader rule ${i}; every issue rule ${j} ` +
            `would match is already captured by rule ${i}. Move rule ${j} earlier.`,
        });
      }
    }
  }

  return conflicts;
}
