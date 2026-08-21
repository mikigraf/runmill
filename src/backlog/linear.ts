import { LinearClient, LinearDocument } from "@linear/sdk";
import type { BacklogAdapter } from "./adapter.js";
import {
  AmbiguousMutationError,
  BacklogMutationNotStartedError,
  BacklogRateLimitError,
} from "./adapter.js";
import type { BacklogIssue, BacklogPriority } from "../domain/types.js";
import { errorMessage, RunmillError } from "../errors/runmill-error.js";

/** Issues hydrated at once. Each fans out to ~6 relation queries. */
const HYDRATE_CONCURRENCY = 6;

/** Linear rejects larger pages, and smaller requests reduce rate-limit bursts. */
const MAX_PAGE_SIZE = 100;
/** Never present an arbitrarily large or changing backlog snapshot as complete. */
const MAX_CANDIDATES = 1_000;
/** A changing remote must not keep discovery following cursors forever. */
const MAX_DISCOVERY_PAGES = 100;

/**
 * Map with a ceiling on in-flight work.
 *
 * Preserves input order, and stops the first rejection from stranding the
 * requests that were already in flight behind it.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface LinearAdapterOptions {
  readonly apiKey: string;
  /** Bounded page size; selection and ordering happen locally. */
  readonly pageSize?: number | undefined;
  /** Test/embedding seam that may only narrow the production safety ceiling. */
  readonly candidateLimit?: number | undefined;
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

interface RawIssueReference {
  readonly id: string;
  readonly identifier: string;
  readonly team: Promise<{ key: string } | undefined>;
}

function toIsoString(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isRateLimit(err: unknown): boolean {
  const message = errorMessage(err);
  return /rate limit|429|too many requests/i.test(message);
}

function parseIdentifier(identifier: string): { teamKey: string; number: number } | undefined {
  const match = identifier.match(/^([A-Za-z][A-Za-z0-9_-]*)-([1-9][0-9]*)$/u);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return undefined;
  return { teamKey: match[1], number };
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
  readonly #candidateLimit: number;
  /** Workflow states are stable for a run; re-querying them per transition is waste. */
  readonly #stateIds = new Map<string, string>();

  constructor(options: LinearAdapterOptions) {
    this.#client = new LinearClient({ apiKey: options.apiKey });
    const pageSize = options.pageSize ?? MAX_PAGE_SIZE;
    const candidateLimit = options.candidateLimit ?? MAX_CANDIDATES;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new RangeError(`Linear pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`);
    }
    if (
      !Number.isSafeInteger(candidateLimit) ||
      candidateLimit < 1 ||
      candidateLimit > MAX_CANDIDATES
    ) {
      throw new RangeError(
        `Linear candidateLimit must be an integer from 1 to ${MAX_CANDIDATES}`,
      );
    }
    this.#pageSize = pageSize;
    this.#candidateLimit = candidateLimit;
  }

  async #wrap<T>(fn: () => Promise<T>): Promise<T> {
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
    return this.#wrap(async () => {
      const nodes: Array<{
        raw: RawIssueShape;
        node: unknown;
      }> = [];
      const seenCursors = new Set<string>();
      let after: string | undefined;

      for (let page = 1; page <= MAX_DISCOVERY_PAGES; page += 1) {
        const remaining = this.#candidateLimit - nodes.length;
        const first = Math.min(this.#pageSize, remaining);
        const connection = await this.#client.issues({
          first,
          ...(after === undefined ? {} : { after }),
          orderBy: LinearDocument.PaginationOrderBy.CreatedAt,
          filter: {
            team: { key: { eq: input.team } },
            state: { name: { in: [...input.states] } },
          },
        });

        if (connection.nodes.length > first) {
          throw RunmillError.fromCatalog("RM-BACKLOG-003", {
            whatHappened:
              `Linear returned ${connection.nodes.length} issues after Runmill requested at most ` +
              `${first}; refusing to use an unbounded candidate response`,
          });
        }
        nodes.push(
          ...connection.nodes.map((node) => ({
            raw: node,
            node,
          })),
        );

        const pageInfo = connection.pageInfo as
          | { hasNextPage?: unknown; endCursor?: unknown }
          | undefined;
        if (typeof pageInfo?.hasNextPage !== "boolean") {
          throw RunmillError.fromCatalog("RM-BACKLOG-003", {
            whatHappened:
              `Linear page ${page} did not include a valid hasNextPage value; ` +
              "Runmill cannot prove candidate discovery is complete",
          });
        }
        if (!pageInfo.hasNextPage) {
          // Bounded concurrency, not unbounded. Each issue fans out to ~6 lazy
          // relation queries, so an unbounded Promise.all over a full backlog
          // can exhaust Linear's hourly request budget.
          return mapWithConcurrency(nodes, HYDRATE_CONCURRENCY, ({ raw, node }) =>
            this.#hydrate(raw, node),
          );
        }

        if (nodes.length >= this.#candidateLimit) {
          throw RunmillError.fromCatalog("RM-BACKLOG-003", {
            whatHappened:
              `Linear still has another page after ${nodes.length} candidates, which reached ` +
              `Runmill's ${this.#candidateLimit}-issue discovery ceiling`,
          });
        }

        const nextCursor = pageInfo.endCursor;
        if (
          typeof nextCursor !== "string" ||
          nextCursor.trim() === "" ||
          nextCursor !== nextCursor.trim()
        ) {
          throw RunmillError.fromCatalog("RM-BACKLOG-003", {
            whatHappened:
              `Linear page ${page} reported hasNextPage without a valid endCursor; ` +
              "Runmill cannot continue discovery safely",
          });
        }
        if (seenCursors.has(nextCursor)) {
          throw RunmillError.fromCatalog("RM-BACKLOG-003", {
            whatHappened:
              `Linear repeated cursor ${JSON.stringify(nextCursor)} on page ${page}; ` +
              "Runmill cannot prove pagination is making progress",
          });
        }
        seenCursors.add(nextCursor);
        after = nextCursor;
      }

      throw RunmillError.fromCatalog("RM-BACKLOG-003", {
        whatHappened:
          `Linear still reported another candidate page after ${MAX_DISCOVERY_PAGES} pages; ` +
          "Runmill stopped rather than using a potentially changing or incomplete queue snapshot",
      });
    });
  }

  async getIssue(identifier: string): Promise<BacklogIssue | undefined> {
    return this.#wrap(async () => {
      const parsed = parseIdentifier(identifier);
      if (parsed === undefined) return undefined;
      const connection = await this.#client.issues({
        first: 1,
        filter: {
          team: { key: { eq: parsed.teamKey } },
          number: { eq: parsed.number },
        },
      });
      const node = connection.nodes[0];
      if (node === undefined || node.identifier !== identifier) return undefined;
      return this.#hydrate(node, node);
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


    // Deliberately NOT wrapped in a catch. An unavailable relation set must
    // not read as "nothing blocks this issue" — that would let a blocked issue
    // pass eligibility and be worked on. A failure here propagates, and the
    // rate-limit mapping on the enclosing call turns it into a retryable error.
    const blockedBy: string[] = [];
    const relations = await issueNode.inverseRelations?.();
    const blocking = (relations?.nodes ?? []).filter((r) => r.type === "blocks");
    const related = await Promise.all(blocking.map((r) => r.issue));
    for (const issue of related) {
      if (issue?.identifier !== undefined) blockedBy.push(issue.identifier);
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
    const cacheKey = `${teamKey}:${stateName}`;
    const cached = this.#stateIds.get(cacheKey);
    if (cached !== undefined) return cached;

    const states = await this.#client.workflowStates({
      first: 100,
      filter: { team: { key: { eq: teamKey } }, name: { eq: stateName } },
    });
    const id = states.nodes[0]?.id;
    if (id === undefined) {
      throw new Error(`workflow state "${stateName}" not found for team ${teamKey}`);
    }
    this.#stateIds.set(cacheKey, id);
    return id;
  }

  async transitionState(input: { identifier: string; toState: string }): Promise<void> {
    const issue = await this.#issueBeforeMutation(input.identifier, "transitionState");
    let stateId: string;
    try {
      const team = await issue.team;
      stateId = await this.#findStateId(team?.key ?? "", input.toState);
    } catch (err) {
      throw new BacklogMutationNotStartedError(
        "transitionState",
        `Linear did not start transitionState: ${errorMessage(err)}`,
        err,
      );
    }

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
    const issue = await this.#issueBeforeMutation(input.identifier, "assign");
    await this.#client.updateIssue(issue.id, { assigneeId: input.assignee ?? null });
  }

  async comment(input: { identifier: string; body: string }): Promise<{ commentId: string }> {
    const issue = await this.#issueBeforeMutation(input.identifier, "comment");
    const payload = await this.#client.createComment({ issueId: issue.id, body: input.body });
    const comment = await payload.comment;
    return { commentId: comment?.id ?? "" };
  }

  async #issueBeforeMutation(
    identifier: string,
    operation: "transitionState" | "assign" | "comment",
  ): Promise<RawIssueReference> {
    try {
      return await this.#rawIssue(identifier);
    } catch (err) {
      throw new BacklogMutationNotStartedError(
        operation,
        `Linear did not start ${operation}: ${errorMessage(err)}`,
        err,
      );
    }
  }

  async #rawIssue(identifier: string): Promise<RawIssueReference> {
    const parsed = parseIdentifier(identifier);
    if (parsed === undefined) throw new Error(`invalid Linear issue identifier ${identifier}`);
    const connection = await this.#client.issues({
      first: 1,
      filter: {
        team: { key: { eq: parsed.teamKey } },
        number: { eq: parsed.number },
      },
    });
    const node = connection.nodes[0];
    if (node === undefined || node.identifier !== identifier) {
      throw new Error(`issue ${identifier} not found`);
    }
    return node as unknown as RawIssueReference;
  }
}
