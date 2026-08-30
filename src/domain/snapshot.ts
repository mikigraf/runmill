import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "../asf/canonical-json.js";
import type { BacklogIssue } from "./types.js";

/**
 * Canonical, complete authority snapshot used by task packets and revalidation.
 *
 * Lives in the domain, not on the adapter interface: nothing about it is
 * transport-specific, and when each adapter carried its own copy they drifted
 * — a partial hash cannot detect a due-date, dependency, assignment, project,
 * cancellation, or repository-routing edit made while an agent is running.
 */
export interface IssueAuthoritySnapshot {
  readonly body: string;
  readonly fingerprint: `sha256:${string}`;
}

export function createIssueAuthoritySnapshot(
  issue: BacklogIssue,
): IssueAuthoritySnapshot {
  const value = {
    assignee_id: issue.assigneeId ?? null,
    assignee_is_human: issue.assigneeIsHuman ?? null,
    blocked_by: [...issue.blockedBy].sort(),
    canceled: issue.canceled,
    completed: issue.completed,
    created_at: issue.createdAt,
    description: issue.description,
    due_date: issue.dueDate ?? null,
    estimate: issue.estimate ?? null,
    identifier: issue.identifier,
    labels: [...issue.labels].sort(),
    manual_rank: issue.manualRank ?? null,
    priority: issue.priority,
    project_name: issue.projectName ?? null,
    schema: "runmill.issue-snapshot/v1",
    state: issue.state,
    team_key: issue.teamKey,
    title: issue.title,
  } satisfies JsonValue;
  const body = canonicalJson(value);
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  return { body, fingerprint: `sha256:${digest}` };
}

export function snapshotHash(issue: BacklogIssue): string {
  return createIssueAuthoritySnapshot(issue).fingerprint;
}
