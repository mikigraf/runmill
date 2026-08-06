import type { RemoteCheck, CheckConclusion } from "./adapter.js";

/**
 * A check identity spans three namespaces that are easy to conflate: the local
 * manifest id, the GitHub context name, and the workflow job name (which
 * differs again under `merge_group`). A required check may additionally be
 * scoped to an expected App id.
 */
export interface CheckMapping {
  readonly localId: string;
  readonly contextName: string;
  readonly mergeGroupContextName?: string | undefined;
  readonly expectedAppId?: string | undefined;
}

export type ReconcileVerdict =
  | { readonly state: "satisfied"; readonly detail: string }
  | { readonly state: "waiting"; readonly detail: string }
  | { readonly state: "failed"; readonly detail: string }
  | { readonly state: "never-scheduled"; readonly detail: string }
  | { readonly state: "unmapped"; readonly detail: string };

export interface ReconcileInput {
  readonly requiredContexts: readonly string[];
  readonly mappings: readonly CheckMapping[];
  readonly observed: readonly RemoteCheck[];
  readonly headSha: string;
  readonly waitedMs: number;
  readonly scheduleDeadlineMs: number;
  readonly event?: "pull_request" | "merge_group" | undefined;
}

/** Conclusions GitHub treats as satisfying protection but runmill does not. */
const NOT_COVERAGE: ReadonlySet<CheckConclusion> = new Set(["neutral", "skipped"]);

function latest(checks: readonly RemoteCheck[]): RemoteCheck | undefined {
  // Re-runs create new check-runs under the same name; take the newest.
  return [...checks].sort((a, b) =>
    (a.completedAt ?? "").localeCompare(b.completedAt ?? ""),
  ).at(-1);
}

/**
 * Decide the state of every required check.
 *
 * The case this exists for: a workflow with `on.pull_request.paths` filters
 * never posts a status for a diff that does not match, and GitHub shows the
 * context as permanently expected. Without a terminal classification the run
 * sits in CI_WAIT for its whole wall budget — on every run, for any repository
 * with a path-filtered required check.
 */
export function reconcileChecks(input: ReconcileInput): Map<string, ReconcileVerdict> {
  const verdicts = new Map<string, ReconcileVerdict>();

  for (const context of input.requiredContexts) {
    const mapping = input.mappings.find(
      (m) =>
        m.contextName === context ||
        m.mergeGroupContextName === context ||
        m.localId === context,
    );

    if (mapping === undefined) {
      // Fail closed: an unmapped required context cannot be reasoned about,
      // and a similarly-named untrusted status must not satisfy it.
      verdicts.set(context, {
        state: "unmapped",
        detail:
          `required context "${context}" has no mapping to a local check; ` +
          `refusing to treat an unmapped status as coverage`,
      });
      continue;
    }

    const expectedName =
      input.event === "merge_group" && mapping.mergeGroupContextName !== undefined
        ? mapping.mergeGroupContextName
        : mapping.contextName;

    const matching = input.observed.filter(
      (c) =>
        c.name === expectedName &&
        c.headSha === input.headSha &&
        (mapping.expectedAppId === undefined || c.appId === mapping.expectedAppId),
    );

    const current = latest(matching);

    if (current === undefined) {
      verdicts.set(
        context,
        input.waitedMs >= input.scheduleDeadlineMs
          ? {
              state: "never-scheduled",
              detail:
                `"${expectedName}" was never scheduled after ${Math.round(input.waitedMs / 1000)}s. ` +
                `Most likely a workflow paths: filter does not match this diff, so the ` +
                `required context will never report and the PR can never merge.`,
            }
          : { state: "waiting", detail: `"${expectedName}" has not reported yet` },
      );
      continue;
    }

    if (current.conclusion === "pending") {
      verdicts.set(context, { state: "waiting", detail: `"${expectedName}" is running` });
      continue;
    }

    if (NOT_COVERAGE.has(current.conclusion)) {
      verdicts.set(context, {
        state: "failed",
        detail:
          `"${expectedName}" concluded "${current.conclusion}", which satisfies branch ` +
          `protection but does not prove the check ran`,
      });
      continue;
    }

    verdicts.set(
      context,
      current.conclusion === "success"
        ? { state: "satisfied", detail: `"${expectedName}" passed` }
        : { state: "failed", detail: `"${expectedName}" concluded "${current.conclusion}"` },
    );
  }

  return verdicts;
}

export function summarize(verdicts: ReadonlyMap<string, ReconcileVerdict>): {
  allSatisfied: boolean;
  waiting: string[];
  blocked: string[];
} {
  const waiting: string[] = [];
  const blocked: string[] = [];
  for (const [context, verdict] of verdicts) {
    if (verdict.state === "waiting") waiting.push(context);
    else if (verdict.state !== "satisfied") blocked.push(context);
  }
  return { allSatisfied: waiting.length === 0 && blocked.length === 0, waiting, blocked };
}
