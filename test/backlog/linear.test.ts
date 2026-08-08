/**
 * The Linear adapter.
 *
 * Every value here crosses a trust boundary, and the failure modes that matter
 * are the ones where a missing or unavailable field could be read as a benign
 * default: an unavailable relation set as "nothing blocks this", a lost mutation
 * response as "the mutation did not happen", `priority: 0` as "most urgent".
 *
 * The SDK is mocked rather than given a test-only injection seam, so the
 * production constructor stays the one real callers use.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const issuesMock = vi.fn();
const workflowStatesMock = vi.fn();
const updateIssueMock = vi.fn();
const createCommentMock = vi.fn();

vi.mock("@linear/sdk", () => ({
  LinearClient: class {
    issues = issuesMock;
    workflowStates = workflowStatesMock;
    updateIssue = updateIssueMock;
    createComment = createCommentMock;
  },
}));

const { LinearBacklogAdapter } = await import("../../src/backlog/linear.js");
const { AmbiguousMutationError, BacklogRateLimitError } = await import(
  "../../src/backlog/adapter.js"
);

/** A raw Linear issue node, with its lazily-resolved relations. */
function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "uuid-1",
    identifier: "ENG-101",
    title: "Prevent duplicate webhook delivery",
    description: "body",
    priority: 2,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    estimate: 3,
    sortOrder: 12.5,
    state: Promise.resolve({ name: "Todo" }),
    team: Promise.resolve({ key: "ENG" }),
    project: Promise.resolve({ name: "Platform" }),
    assignee: Promise.resolve(undefined),
    labels: () => Promise.resolve({ nodes: [{ name: "agent-ready" }] }),
    inverseRelations: () => Promise.resolve({ nodes: [] }),
    ...overrides,
  };
}

function adapter(pageSize?: number) {
  return new LinearBacklogAdapter(
    pageSize === undefined ? { apiKey: "lin_api_test" } : { apiKey: "lin_api_test", pageSize },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listCandidates", () => {
  it("maps a Linear issue onto the domain shape", async () => {
    issuesMock.mockResolvedValue({ nodes: [node()] });
    const [issue] = await adapter().listCandidates({ team: "ENG", states: ["Todo"] });

    expect(issue?.identifier).toBe("ENG-101");
    expect(issue?.title).toBe("Prevent duplicate webhook delivery");
    expect(issue?.state).toBe("Todo");
    expect(issue?.teamKey).toBe("ENG");
    expect(issue?.projectName).toBe("Platform");
    expect(issue?.labels).toEqual(["agent-ready"]);
    expect(issue?.estimate).toBe(3);
    expect(issue?.manualRank).toBe(12.5);
  });

  it("filters by team key and the requested states", async () => {
    issuesMock.mockResolvedValue({ nodes: [] });
    await adapter().listCandidates({ team: "ENG", states: ["Todo", "Ready"] });

    const filter = issuesMock.mock.calls[0]?.[0]?.filter;
    expect(filter.team.key.eq).toBe("ENG");
    expect(filter.state.name.in).toEqual(["Todo", "Ready"]);
  });

  it("bounds the page size rather than fetching the whole backlog", async () => {
    issuesMock.mockResolvedValue({ nodes: [] });
    await adapter(25).listCandidates({ team: "ENG", states: ["Todo"] });
    expect(issuesMock.mock.calls[0]?.[0]?.first).toBe(25);
  });

  it("returns priority RAW, including Linear's 0 = no priority", async () => {
    // Translating here would hide the trap from the ordering rules that exist
    // precisely to handle it: sorting on the raw value ascending puts
    // unprioritized work first.
    issuesMock.mockResolvedValue({ nodes: [node({ priority: 0 })] });
    const [issue] = await adapter().listCandidates({ team: "ENG", states: ["Todo"] });
    expect(issue?.priority).toBe(0);
  });

  it("collects blocking relations into blockedBy", async () => {
    issuesMock.mockResolvedValue({
      nodes: [
        node({
          inverseRelations: () =>
            Promise.resolve({
              nodes: [
                { type: "blocks", issue: Promise.resolve({ identifier: "ENG-99" }) },
                { type: "relates", issue: Promise.resolve({ identifier: "ENG-50" }) },
              ],
            }),
        }),
      ],
    });
    const [issue] = await adapter().listCandidates({ team: "ENG", states: ["Todo"] });
    expect(issue?.blockedBy).toEqual(["ENG-99"]);
  });

  it("propagates a relation failure instead of reporting nothing blocks the issue", async () => {
    // The consequential case: swallowing this would let a blocked issue pass
    // eligibility and be worked on.
    issuesMock.mockResolvedValue({
      nodes: [
        node({
          inverseRelations: () => Promise.reject(new Error("relations unavailable")),
        }),
      ],
    });
    await expect(adapter().listCandidates({ team: "ENG", states: ["Todo"] })).rejects.toThrow(
      /relations unavailable/,
    );
  });

  it("marks an assigned issue as human-held", async () => {
    issuesMock.mockResolvedValue({
      nodes: [node({ assignee: Promise.resolve({ id: "user-7" }) })],
    });
    const [issue] = await adapter().listCandidates({ team: "ENG", states: ["Todo"] });
    expect(issue?.assigneeId).toBe("user-7");
    expect(issue?.assigneeIsHuman).toBe(true);
  });

  it("tolerates absent optional fields without inventing values", async () => {
    issuesMock.mockResolvedValue({
      nodes: [
        node({
          description: null,
          estimate: null,
          sortOrder: null,
          project: Promise.resolve(undefined),
          labels: undefined,
        }),
      ],
    });
    const [issue] = await adapter().listCandidates({ team: "ENG", states: ["Todo"] });
    expect(issue?.description).toBe("");
    expect(issue?.estimate).toBeUndefined();
    expect(issue?.manualRank).toBeUndefined();
    expect(issue?.projectName).toBeUndefined();
    expect(issue?.labels).toEqual([]);
  });

  it("hydrates a full page without firing one request per issue at once", async () => {
    // Each issue fans out to several lazy relation queries; unbounded, a full
    // page would fire hundreds of simultaneous requests against an hourly
    // budget and a 429 on any one would discard every other in-flight response.
    let concurrent = 0;
    let peak = 0;
    const nodes = Array.from({ length: 40 }, (_, i) =>
      node({
        identifier: `ENG-${100 + i}`,
        labels: async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 1));
          concurrent -= 1;
          return { nodes: [] };
        },
      }),
    );
    issuesMock.mockResolvedValue({ nodes });

    const issues = await adapter().listCandidates({ team: "ENG", states: ["Todo"] });
    expect(issues).toHaveLength(40);
    expect(peak).toBeLessThan(40);
  });

  it("preserves order despite bounded concurrency", async () => {
    const nodes = Array.from({ length: 12 }, (_, i) => node({ identifier: `ENG-${100 + i}` }));
    issuesMock.mockResolvedValue({ nodes });
    const issues = await adapter().listCandidates({ team: "ENG", states: ["Todo"] });
    expect(issues.map((i) => i.identifier)).toEqual(nodes.map((n) => n["identifier"]));
  });

  it("maps a rate limit onto a retryable error", async () => {
    issuesMock.mockRejectedValue(new Error("429 Too Many Requests"));
    await expect(adapter().listCandidates({ team: "ENG", states: ["Todo"] })).rejects.toBeInstanceOf(
      BacklogRateLimitError,
    );
  });

  it("does not disguise an ordinary failure as a rate limit", async () => {
    issuesMock.mockRejectedValue(new Error("schema error"));
    await expect(adapter().listCandidates({ team: "ENG", states: ["Todo"] })).rejects.toThrow(
      /schema error/,
    );
  });
});

describe("getIssue", () => {
  it("looks an issue up by its numeric part", async () => {
    issuesMock.mockResolvedValue({ nodes: [node()] });
    const issue = await adapter().getIssue("ENG-101");
    expect(issue?.identifier).toBe("ENG-101");
    expect(issuesMock.mock.calls[0]?.[0]?.filter.number.eq).toBe(101);
  });

  it("returns undefined for an issue that does not exist", async () => {
    issuesMock.mockResolvedValue({ nodes: [] });
    expect(await adapter().getIssue("ENG-999")).toBeUndefined();
  });

  it("does not throw on a malformed identifier", async () => {
    issuesMock.mockResolvedValue({ nodes: [] });
    expect(await adapter().getIssue("nonsense")).toBeUndefined();
  });
});

describe("transitionState", () => {
  it("resolves the workflow state id for the issue's team", async () => {
    issuesMock.mockResolvedValue({ nodes: [node()] });
    workflowStatesMock.mockResolvedValue({ nodes: [{ id: "state-uuid" }] });
    updateIssueMock.mockResolvedValue({ success: true });

    await adapter().transitionState({ identifier: "ENG-101", toState: "In Progress" });

    const filter = workflowStatesMock.mock.calls[0]?.[0]?.filter;
    expect(filter.team.key.eq).toBe("ENG");
    expect(filter.name.eq).toBe("In Progress");
    expect(updateIssueMock).toHaveBeenCalledWith("uuid-1", { stateId: "state-uuid" });
  });

  it("caches the state id rather than re-querying per transition", async () => {
    issuesMock.mockResolvedValue({ nodes: [node()] });
    workflowStatesMock.mockResolvedValue({ nodes: [{ id: "state-uuid" }] });
    updateIssueMock.mockResolvedValue({ success: true });

    const a = adapter();
    await a.transitionState({ identifier: "ENG-101", toState: "In Progress" });
    await a.transitionState({ identifier: "ENG-101", toState: "In Progress" });
    expect(workflowStatesMock).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when the configured state does not exist on the team", async () => {
    issuesMock.mockResolvedValue({ nodes: [node()] });
    workflowStatesMock.mockResolvedValue({ nodes: [] });
    await expect(
      adapter().transitionState({ identifier: "ENG-101", toState: "Nonexistent" }),
    ).rejects.toThrow(/workflow state "Nonexistent" not found/);
  });

  it("reports an AMBIGUOUS mutation when the response was lost but the change landed", async () => {
    // A failed request does not prove the effect did not happen. Assuming it
    // did not is how duplicate transitions and orphaned claims happen.
    issuesMock.mockResolvedValue({ nodes: [node({ state: Promise.resolve({ name: "In Progress" }) })] });
    workflowStatesMock.mockResolvedValue({ nodes: [{ id: "state-uuid" }] });
    updateIssueMock.mockRejectedValue(new Error("socket hang up"));

    await expect(
      adapter().transitionState({ identifier: "ENG-101", toState: "In Progress" }),
    ).rejects.toBeInstanceOf(AmbiguousMutationError);
  });

  it("rethrows when a re-read shows the change did NOT land", async () => {
    issuesMock.mockResolvedValue({ nodes: [node({ state: Promise.resolve({ name: "Todo" }) })] });
    workflowStatesMock.mockResolvedValue({ nodes: [{ id: "state-uuid" }] });
    updateIssueMock.mockRejectedValue(new Error("socket hang up"));

    await expect(
      adapter().transitionState({ identifier: "ENG-101", toState: "In Progress" }),
    ).rejects.toThrow(/socket hang up/);
  });

  it("maps a rate-limited transition onto a retryable error", async () => {
    issuesMock.mockResolvedValue({ nodes: [node()] });
    workflowStatesMock.mockResolvedValue({ nodes: [{ id: "state-uuid" }] });
    updateIssueMock.mockRejectedValue(new Error("rate limit exceeded"));

    await expect(
      adapter().transitionState({ identifier: "ENG-101", toState: "In Progress" }),
    ).rejects.toBeInstanceOf(BacklogRateLimitError);
  });

  it("throws for an issue that cannot be found", async () => {
    issuesMock.mockResolvedValue({ nodes: [] });
    await expect(
      adapter().transitionState({ identifier: "ENG-404", toState: "Done" }),
    ).rejects.toThrow(/not found/);
  });
});

describe("assign", () => {
  it("assigns by user id", async () => {
    issuesMock.mockResolvedValue({ nodes: [node()] });
    updateIssueMock.mockResolvedValue({ success: true });
    await adapter().assign({ identifier: "ENG-101", assignee: "user-7" });
    expect(updateIssueMock).toHaveBeenCalledWith("uuid-1", { assigneeId: "user-7" });
  });

  it("unassigns with an explicit null rather than omitting the field", async () => {
    // Omitting it would leave the previous assignee in place.
    issuesMock.mockResolvedValue({ nodes: [node()] });
    updateIssueMock.mockResolvedValue({ success: true });
    await adapter().assign({ identifier: "ENG-101", assignee: null });
    expect(updateIssueMock).toHaveBeenCalledWith("uuid-1", { assigneeId: null });
  });
});

describe("comment", () => {
  it("posts a comment and returns its id", async () => {
    issuesMock.mockResolvedValue({ nodes: [node()] });
    createCommentMock.mockResolvedValue({ comment: Promise.resolve({ id: "comment-1" }) });
    const result = await adapter().comment({ identifier: "ENG-101", body: "hello" });
    expect(createCommentMock).toHaveBeenCalledWith({ issueId: "uuid-1", body: "hello" });
    expect(result.commentId).toBe("comment-1");
  });

  it("returns an empty id rather than throwing when the payload has no comment", async () => {
    issuesMock.mockResolvedValue({ nodes: [node()] });
    createCommentMock.mockResolvedValue({ comment: Promise.resolve(undefined) });
    expect((await adapter().comment({ identifier: "ENG-101", body: "x" })).commentId).toBe("");
  });
});

describe("the adapter's boundaries", () => {
  it("exposes a stable name for logs and support bundles", () => {
    expect(adapter().name).toBe("linear");
  });

  it("has no method that claims, merges, or selects", () => {
    // The adapter reads and mutates. Ownership belongs to the git-ref lease and
    // selection happens above this layer.
    const a = adapter() as unknown as Record<string, unknown>;
    for (const forbidden of ["claim", "merge", "selectNext", "acquire"]) {
      expect(a[forbidden]).toBeUndefined();
    }
  });
});
