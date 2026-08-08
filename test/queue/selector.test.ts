import { describe, expect, it } from "vitest";
import { selectNext } from "../../src/queue/selector.js";
import { FakeBacklogAdapter } from "../../src/testing/fake-backlog.js";
import { parseConfig } from "../../src/config/load.js";
import type { BacklogIssue } from "../../src/domain/types.js";

const CONFIG = parseConfig(`
version: 1
autonomy: pr-only
providers:
  implementer:
    implementation: codex
backlog:
  provider: linear
  team: ENG
  eligible_states: [Todo, Ready]
  claim_state: In Progress
  include_labels: [agent-ready]
  exclude_labels: [no-agent]
github:
  repositories:
    - match: { team: ENG, label: mobile }
      repo: acme/ios
      base_branch: main
    - match: { team: ENG }
      repo: acme/platform
      base_branch: main
`);

function issue(over: Partial<BacklogIssue> & Pick<BacklogIssue, "identifier">): BacklogIssue {
  return {
    title: "t",
    description:
      "A sufficiently detailed description of the problem, with acceptance " +
      "criteria that a task packet can actually be built from.",
    priority: 3,
    labels: ["agent-ready"],
    state: "Todo",
    teamKey: "ENG",
    createdAt: "2026-01-01T00:00:00Z",
    canceled: false,
    completed: false,
    blockedBy: [],
    ...over,
  };
}

describe("selectNext", () => {
  it("picks the highest-priority eligible issue", async () => {
    const backlog = new FakeBacklogAdapter([
      issue({ identifier: "ENG-1", priority: 4 }),
      issue({ identifier: "ENG-2", priority: 1 }),
      issue({ identifier: "ENG-3", priority: 3 }),
    ]);
    const result = await selectNext({ backlog, config: CONFIG, leasedIssueIds: new Set() });
    expect(result.selected?.issue.identifier).toBe("ENG-2");
  });

  it("resolves the target repository for the selected issue", async () => {
    const backlog = new FakeBacklogAdapter([issue({ identifier: "ENG-1", labels: ["agent-ready", "mobile"] })]);
    const result = await selectNext({ backlog, config: CONFIG, leasedIssueIds: new Set() });
    expect(result.selected?.target.repo).toBe("acme/ios");
  });

  it("never returns an unprioritized issue ahead of a prioritized one", async () => {
    const backlog = new FakeBacklogAdapter([
      issue({ identifier: "ENG-NONE", priority: 0, createdAt: "2019-01-01T00:00:00Z" }),
      issue({ identifier: "ENG-LOW", priority: 4 }),
    ]);
    const result = await selectNext({ backlog, config: CONFIG, leasedIssueIds: new Set() });
    expect(result.selected?.issue.identifier).toBe("ENG-LOW");
  });

  it("explains every rejected candidate rule by rule", async () => {
    // FR-03. The explanation is the product surface here, not a debug aid.
    const backlog = new FakeBacklogAdapter([
      issue({ identifier: "ENG-OK" }),
      issue({ identifier: "ENG-BLOCKED", blockedBy: ["ENG-99"] }),
      issue({ identifier: "ENG-NOLABEL", labels: [] }),
    ]);
    const result = await selectNext({ backlog, config: CONFIG, leasedIssueIds: new Set() });

    expect(result.rejected).toHaveLength(2);
    const blocked = result.rejected.find((r) => r.issue.identifier === "ENG-BLOCKED");
    expect(blocked?.decision.rules.find((r) => r.rule === "dependencies")?.passed).toBe(false);
    // Every rule is reported for every rejected candidate, not just the failing one.
    expect(blocked?.decision.rules).toHaveLength(9);
  });

  it("skips issues already leased by another run", async () => {
    const backlog = new FakeBacklogAdapter([
      issue({ identifier: "ENG-1", priority: 1 }),
      issue({ identifier: "ENG-2", priority: 2 }),
    ]);
    const result = await selectNext({
      backlog,
      config: CONFIG,
      leasedIssueIds: new Set(["ENG-1"]),
    });
    expect(result.selected?.issue.identifier).toBe("ENG-2");
  });

  it("selects nothing when the backlog is empty, without throwing", async () => {
    const result = await selectNext({
      backlog: new FakeBacklogAdapter([]),
      config: CONFIG,
      leasedIssueIds: new Set(),
    });
    expect(result.selected).toBeUndefined();
    expect(result.rejected).toEqual([]);
  });

  it("selects nothing when every candidate is rejected", async () => {
    const backlog = new FakeBacklogAdapter([issue({ identifier: "ENG-1", labels: ["no-agent", "agent-ready"] })]);
    const result = await selectNext({ backlog, config: CONFIG, leasedIssueIds: new Set() });
    expect(result.selected).toBeUndefined();
    expect(result.rejected).toHaveLength(1);
  });

  it("reports capacity exhaustion as a rejection reason rather than an empty queue", async () => {
    const backlog = new FakeBacklogAdapter([issue({ identifier: "ENG-1" })]);
    const result = await selectNext({
      backlog,
      config: CONFIG,
      leasedIssueIds: new Set(),
      capacityAvailable: false,
    });
    expect(result.selected).toBeUndefined();
    expect(result.rejected[0]?.decision.rules.find((r) => r.rule === "capacity")?.passed).toBe(false);
  });

  it("only asks the adapter for the configured team and states", async () => {
    const backlog = new FakeBacklogAdapter([issue({ identifier: "ENG-1" })]);
    await selectNext({ backlog, config: CONFIG, leasedIssueIds: new Set() });
    expect(backlog.calls[0]).toMatchObject({
      op: "listCandidates",
      args: { team: "ENG", states: ["Todo", "Ready"] },
    });
  });
});
