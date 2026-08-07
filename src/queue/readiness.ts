import type { BacklogIssue } from "../domain/types.js";
import { extractAcceptanceCriteria } from "../agent/task-packet.js";

/**
 * How ready an issue is to be executed without a human in the loop.
 *
 * The specification's weakest premise was that a backlog contains enough
 * well-specified issues to keep a worker fed. This is the instrument that
 * answers it: rather than dispatching and discovering the gap after spending
 * money, `runmill prepare` reports what is missing before a run starts.
 */
export interface ReadinessSignal {
  readonly id: string;
  readonly met: boolean;
  readonly weight: number;
  readonly detail: string;
  /** What the human should add. Present only when the signal is unmet. */
  readonly remedy?: string | undefined;
}

export interface ReadinessReport {
  readonly identifier: string;
  /** 0-10. 7+ is dispatchable without an override. */
  readonly score: number;
  readonly dispatchable: boolean;
  readonly signals: readonly ReadinessSignal[];
  readonly acceptanceCriteria: readonly string[];
  readonly missing: readonly string[];
}

const MIN_DESCRIPTION_CHARS = 80;
const DISPATCHABLE_SCORE = 7;

/** Vague phrasing that reads as a request but specifies nothing. */
const VAGUE = /\b(fix it|make it (nicer|better|work)|tidy up|clean up|improve|polish|refactor a bit|etc\.?)\b/i;

export function assessReadiness(issue: BacklogIssue): ReadinessReport {
  const description = issue.description.trim();
  const criteria = extractAcceptanceCriteria(issue.description);
  const signals: ReadinessSignal[] = [];

  signals.push(
    description.length >= MIN_DESCRIPTION_CHARS
      ? { id: "description", met: true, weight: 2, detail: `${description.length} characters` }
      : {
          id: "description",
          met: false,
          weight: 2,
          detail: `${description.length} characters, below the ${MIN_DESCRIPTION_CHARS} needed`,
          remedy: "Describe the observed behavior and the wanted behavior.",
        },
  );

  signals.push(
    criteria.length > 0
      ? {
          id: "acceptance-criteria",
          met: true,
          weight: 4,
          detail: `${criteria.length} criteria found`,
        }
      : {
          id: "acceptance-criteria",
          met: false,
          weight: 4,
          detail: "no acceptance criteria found",
          remedy:
            'Add an "Acceptance criteria:" heading followed by a bullet list. ' +
            "Review verifies each one individually, so an issue without them " +
            "has nothing to verify against.",
        },
  );

  signals.push(
    VAGUE.test(description)
      ? {
          id: "specificity",
          met: false,
          weight: 2,
          detail: "description contains vague phrasing",
          remedy: "Say what specifically is wrong and what specifically should change.",
        }
      : { id: "specificity", met: true, weight: 2, detail: "no vague phrasing detected" },
  );

  signals.push(
    issue.blockedBy.length === 0
      ? { id: "unblocked", met: true, weight: 1, detail: "no known blockers" }
      : {
          id: "unblocked",
          met: false,
          weight: 1,
          detail: `blocked by ${issue.blockedBy.join(", ")}`,
          remedy: "Resolve or unlink the blocking issues.",
        },
  );

  signals.push(
    issue.priority !== 0
      ? { id: "prioritized", met: true, weight: 1, detail: "has an explicit priority" }
      : {
          id: "prioritized",
          met: false,
          weight: 1,
          detail: "no priority set, so it sorts last",
          remedy: "Set a priority, or accept that it runs only when nothing else is eligible.",
        },
  );

  const total = signals.reduce((sum, s) => sum + s.weight, 0);
  const earned = signals.filter((s) => s.met).reduce((sum, s) => sum + s.weight, 0);
  const score = Math.round((earned / total) * 10);

  return {
    identifier: issue.identifier,
    score,
    dispatchable: score >= DISPATCHABLE_SCORE,
    signals,
    acceptanceCriteria: criteria,
    missing: signals.filter((s) => !s.met).map((s) => s.remedy ?? s.detail),
  };
}

export function renderReadiness(report: ReadinessReport): string {
  const out: string[] = [];
  const bar = "█".repeat(report.score) + "░".repeat(10 - report.score);
  out.push(`${report.identifier}  readiness ${bar} ${report.score}/10`);
  out.push(
    report.dispatchable
      ? "  Ready to dispatch."
      : "  Not ready. runmill would escalate rather than guess.",
  );
  out.push("");
  for (const signal of report.signals) {
    out.push(`  ${signal.met ? "✓" : "✗"} ${signal.id.padEnd(20)} ${signal.detail}`);
  }
  if (report.acceptanceCriteria.length > 0) {
    out.push("");
    out.push("  Acceptance criteria runmill would verify against:");
    for (const c of report.acceptanceCriteria) out.push(`    - ${c}`);
  }
  const remedies = report.signals.filter((s) => !s.met && s.remedy !== undefined);
  if (remedies.length > 0) {
    out.push("");
    out.push("  To make this dispatchable:");
    for (const r of remedies) out.push(`    → ${r.remedy}`);
  }
  return out.join("\n");
}
