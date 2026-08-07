import { createHash } from "node:crypto";
import type { BacklogIssue } from "./types.js";

/**
 * Content hash of the fields a task packet derives from.
 *
 * Lives in the domain, not on the adapter interface: nothing about it is
 * transport-specific, and when each adapter carried its own copy they drifted
 * — the fake omitted `priority`, so a priority edit invalidated the packet on
 * the real path and silently did not in tests.
 */
export function snapshotHash(issue: BacklogIssue): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: issue.title,
        description: issue.description,
        labels: [...issue.labels].sort(),
        state: issue.state,
        priority: issue.priority,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}
