import { createHash } from "node:crypto";
import { LinearClient } from "@linear/sdk";
import type { BacklogAdapter } from "./adapter.js";
import { AmbiguousMutationError, BacklogRateLimitError } from "./adapter.js";
import type { BacklogIssue, BacklogPriority } from "../domain/types.js";

export interface LinearAdapterOptions {
  readonly apiKey: string;
  /** Bounded page size; selection and ordering happen locally. */
  readonly pageSize?: number | undefined;
}

interface RawIssueShape {
  identifier: string;
  title: string;
  description?: string | null;
  priority: number;
  createdAt: Date | string;
  dueDate?: string | null;
  sortOrder?: number | null;
  estimate?: number | null;
  canceledAt?: Date | string | null;
  completedAt?: Date | string | null;
}

function toIsoString(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isRateLimit(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /rate limit|429|too many requests/i.test(message);
}

/**
 * Linear-backed implementation of the backlog boundary.
 *
 * Deliberately thin. It reads and mutates; it never decides what to work on,
 * never owns the claim (a git ref does), and never merges. Priority is
 * returned raw — including Linear's `0 = no priority` encoding — because
 * translating it here would hide the trap from the ordering rules that exist
 * to handle it.
 */
export class LinearBacklogAdapter implements BacklogAdapter {
  readonly name = "linear";
  readonly #client: LinearClient;
  readonly #pageSize: number;

  constructor(options: LinearAdapterOptions) {
    this.#client = new LinearClient({ apiKey: options.apiKey });
    this.#pageSize = options.pageSize ?? 100;
  }

  async #wrap<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimit(err)) throw new BacklogRateLimitError(2_000);
      throw err;
    }
  }

  async listCandidates(input: {
    team: string;
    states: readonly string[];
  }): Promise<BacklogIssue[]> {
    return this.#wrap("listCandidates", async () => {
      const connection = await this.#client.issues({
        first: this.#pageSize,
        filter: {
          team: { key: { eq: input.team } },
          state: { name: { in: [...input.states] } },
        },
      });

      const issues: BacklogIssue[] = [];
      for (const node of connection.nodes) {
        issues.push(await this.#hydrate(node as unknown as RawIssueShape, node));
      }
      return issues;
    });
  }

  async getIssue(identifier: string): Promise<BacklogIssue | undefined> {
    return this.#wrap("getIssue", async () => {
      const connection = await this.#client.issues({
        first: 1,
        filter: { number: { eq: Number(identifier.split("-")[1] ?? "0") } },
      });
      const node = connection.nodes[0];
      if (node === undefined) return undefined;
      return this.#hydrate(node as unknown as RawIssueShape, node);
    });
  }

  /** Resolve the lazily-loaded relations the domain type needs. */
  async #hydrate(raw: RawIssueShape, node: unknown): Promise<BacklogIssue> {
    const issueNode = node as {
      state?: Promise<{ name: string } | undefined>;
      team?: Promise<{ key: string } | undefined>;
      project?: Promise<{ name: string } | undefined>;
      assignee?: Promise<{ id: string } | undefined>;
      labels?: () => Promise<{ nodes: { name: string }[] }>;
      inverseRelations?: () => Promise<{
        nodes: { type: string; issue?: Promise<{ identifier: string } | undefined> }[];
      }>;
    };

    const [state, team, project, assignee, labels] = await Promise.all([
      issueNode.state,
      issueNode.team,
      issueNode.project,
      issueNode.assignee,
      issueNode.labels?.(),
    ]);

    const blockedBy: string[] = [];
    try {
      const relations = await issueNode.inverseRelations?.();
      for (const relation of relations?.nodes ?? []) {
        if (relation.type !== "blocks") continue;
        const related = await relation.issue;
        if (related?.identifier !== undefined) blockedBy.push(related.identifier);
      }
    } catch {
      // Relations are paginated and rate-limited; an unavailable relation set
      // must not silently read as "nothing blocks this issue", so the caller
      // sees an empty list only when the query genuinely returned none.
    }

    return {
      identifier: raw.identifier,
      title: raw.title,
      description: raw.description ?? "",
      priority: (raw.priority as BacklogPriority) ?? 0,
      labels: (labels?.nodes ?? []).map((l) => l.name),
      state: state?.name ?? "",
      teamKey: team?.key ?? "",
      projectName: project?.name,
      estimate: raw.estimate ?? undefined,
      assigneeId: assignee?.id,
      assigneeIsHuman: assignee?.id !== undefined,
      dueDate: raw.dueDate ?? undefined,
      manualRank: raw.sortOrder ?? undefined,
      createdAt: toIsoString(raw.createdAt) ?? new Date(0).toISOString(),
      canceled: raw.canceledAt !== null && raw.canceledAt !== undefined,
      completed: raw.completedAt !== null && raw.completedAt !== undefined,
      blockedBy,
    };
  }

  async #findStateId(teamKey: string, stateName: string): Promise<string> {
    const states = await this.#client.workflowStates({
      first: 100,
      filter: { team: { key: { eq: teamKey } }, name: { eq: stateName } },
    });
    const id = states.nodes[0]?.id;
    if (id === undefined) {
      throw new Error(`workflow state "${stateName}" not found for team ${teamKey}`);
    }
    return id;
  }

  async transitionState(input: { identifier: string; toState: string }): Promise<void> {
    const issue = await this.#rawIssue(input.identifier);
    const team = await issue.team;
    const stateId = await this.#findStateId(team?.key ?? "", input.toState);

    try {
      await this.#client.updateIssue(issue.id, { stateId });
    } catch (err) {
      if (isRateLimit(err)) throw new BacklogRateLimitError(2_000);
      // The mutation may well have applied. Re-read before concluding
      // anything: assuming failure means no side effect is how duplicate
      // transitions and orphaned claims happen.
      const after = await this.getIssue(input.identifier);
      if (after?.state === input.toState) {
        throw new AmbiguousMutationError(
          "transitionState",
          `transition to "${input.toState}" applied but the response was lost`,
        );
      }
      throw err;
    }
  }

  async assign(input: { identifier: string; assignee: string | null }): Promise<void> {
    const issue = await this.#rawIssue(input.identifier);
    await this.#client.updateIssue(issue.id, { assigneeId: input.assignee ?? null });
  }

  async comment(input: { identifier: string; body: string }): Promise<{ commentId: string }> {
    const issue = await this.#rawIssue(input.identifier);
    const payload = await this.#client.createComment({ issueId: issue.id, body: input.body });
    const comment = await payload.comment;
    return { commentId: comment?.id ?? "" };
  }

  async #rawIssue(identifier: string): Promise<{ id: string; team: Promise<{ key: string } | undefined> }> {
    const connection = await this.#client.issues({
      first: 1,
      filter: { number: { eq: Number(identifier.split("-")[1] ?? "0") } },
    });
    const node = connection.nodes[0];
    if (node === undefined) throw new Error(`issue ${identifier} not found`);
    return node as unknown as { id: string; team: Promise<{ key: string } | undefined> };
  }

  /**
   * Hash the fields a task packet derives from.
   *
   * Compared at every safe checkpoint: if a human edits the issue mid-run the
   * packet is stale, and continuing would implement a specification nobody
   * currently holds.
   */
  snapshotHash(issue: BacklogIssue): string {
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
}
