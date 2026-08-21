import { describe, expect, it } from "vitest";
import { compareIssues, orderIssues, prioritySortKey } from "../../src/queue/ordering.js";
import type { BacklogIssue, BacklogPriority } from "../../src/domain/types.js";

function issue(over: Partial<BacklogIssue> & Pick<BacklogIssue, "identifier">): BacklogIssue {
  return {
    title: "t",
    description: "d",
    priority: 3,
    labels: [],
    state: "Todo",
    teamKey: "ENG",
    createdAt: "2026-01-01T00:00:00Z",
    canceled: false,
    completed: false,
    blockedBy: [],
    ...over,
  };
}

describe("prioritySortKey", () => {
  it("maps no-priority (0) to +Infinity so it sorts last", () => {
    // This is the single most likely implementation bug: Linear encodes
    // "no priority" as 0 and "urgent" as 1, so ascending sort inverts it.
    expect(prioritySortKey(0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("preserves ascending order for real priorities", () => {
    expect(prioritySortKey(1)).toBe(1);
    expect(prioritySortKey(2)).toBe(2);
    expect(prioritySortKey(3)).toBe(3);
    expect(prioritySortKey(4)).toBe(4);
  });

  it("orders urgent before high before medium before low before none", () => {
    const keys = ([1, 2, 3, 4, 0] as BacklogPriority[]).map(prioritySortKey);
    const sorted = [...keys].sort((a, b) => a - b);
    expect(sorted).toEqual(keys);
  });
});

describe("orderIssues", () => {
  it("puts unprioritized issues last even when they are oldest", () => {
    const ordered = orderIssues([
      issue({ identifier: "ENG-1", priority: 0, createdAt: "2020-01-01T00:00:00Z" }),
      issue({ identifier: "ENG-2", priority: 4, createdAt: "2026-01-01T00:00:00Z" }),
    ]);
    expect(ordered.map((i) => i.identifier)).toEqual(["ENG-2", "ENG-1"]);
  });

  it("orders by priority first", () => {
    const ordered = orderIssues([
      issue({ identifier: "LOW", priority: 4 }),
      issue({ identifier: "URGENT", priority: 1 }),
      issue({ identifier: "MED", priority: 3 }),
      issue({ identifier: "HIGH", priority: 2 }),
    ]);
    expect(ordered.map((i) => i.identifier)).toEqual(["URGENT", "HIGH", "MED", "LOW"]);
  });

  it("breaks priority ties by nearest due date, absent due dates last", () => {
    const ordered = orderIssues([
      issue({ identifier: "NO-DUE", priority: 2 }),
      issue({ identifier: "LATER", priority: 2, dueDate: "2026-12-01" }),
      issue({ identifier: "SOONER", priority: 2, dueDate: "2026-02-01" }),
    ]);
    expect(ordered.map((i) => i.identifier)).toEqual(["SOONER", "LATER", "NO-DUE"]);
  });

  it("breaks due-date ties by manual rank when present", () => {
    const ordered = orderIssues([
      issue({ identifier: "B", priority: 2, manualRank: 20 }),
      issue({ identifier: "A", priority: 2, manualRank: 10 }),
    ]);
    expect(ordered.map((i) => i.identifier)).toEqual(["A", "B"]);
  });

  it("breaks remaining ties by oldest creation timestamp", () => {
    const ordered = orderIssues([
      issue({ identifier: "NEW", priority: 2, createdAt: "2026-06-01T00:00:00Z" }),
      issue({ identifier: "OLD", priority: 2, createdAt: "2026-01-01T00:00:00Z" }),
    ]);
    expect(ordered.map((i) => i.identifier)).toEqual(["OLD", "NEW"]);
  });

  it("uses the stable identifier as the final tie-breaker", () => {
    const ordered = orderIssues([
      issue({ identifier: "ENG-9", priority: 2 }),
      issue({ identifier: "ENG-2", priority: 2 }),
    ]);
    expect(ordered.map((i) => i.identifier)).toEqual(["ENG-2", "ENG-9"]);
  });

  it("honors configured selection keys instead of silently using defaults", () => {
    const ordered = orderIssues(
      [
        issue({
          identifier: "Z-OLD-URGENT",
          priority: 1,
          dueDate: "2026-01-01",
          createdAt: "2020-01-01T00:00:00Z",
        }),
        issue({
          identifier: "A-NEW-LOW",
          priority: 4,
          dueDate: "2027-01-01",
          createdAt: "2026-01-01T00:00:00Z",
        }),
      ],
      {
        priorityFirst: false,
        unprioritizedLast: false,
        dueDateTiebreaker: false,
        oldestFirst: false,
      },
    );

    expect(ordered.map((i) => i.identifier)).toEqual(["A-NEW-LOW", "Z-OLD-URGENT"]);
  });

  it("is a total order: every input permutation yields the same result", () => {
    const issues = [
      issue({ identifier: "ENG-1", priority: 0 }),
      issue({ identifier: "ENG-2", priority: 1, dueDate: "2026-03-01" }),
      issue({ identifier: "ENG-3", priority: 1 }),
      issue({ identifier: "ENG-4", priority: 2, manualRank: 5 }),
      issue({ identifier: "ENG-5", priority: 2, manualRank: 1 }),
      issue({ identifier: "ENG-6", priority: 4, createdAt: "2019-01-01T00:00:00Z" }),
    ];
    const expected = orderIssues(issues).map((i) => i.identifier);

    // Exhaustive over a deterministic set of rotations + reversal, so the test
    // itself stays deterministic (no Math.random in the suite).
    for (let shift = 0; shift < issues.length; shift += 1) {
      const rotated = [...issues.slice(shift), ...issues.slice(0, shift)];
      expect(orderIssues(rotated).map((i) => i.identifier)).toEqual(expected);
      expect(orderIssues([...rotated].reverse()).map((i) => i.identifier)).toEqual(expected);
    }
  });

  it("does not mutate its input", () => {
    const input = [
      issue({ identifier: "B", priority: 4 }),
      issue({ identifier: "A", priority: 1 }),
    ];
    const before = input.map((i) => i.identifier);
    orderIssues(input);
    expect(input.map((i) => i.identifier)).toEqual(before);
  });

  it("compareIssues is antisymmetric", () => {
    const a = issue({ identifier: "A", priority: 1 });
    const b = issue({ identifier: "B", priority: 3 });
    expect(Math.sign(compareIssues(a, b))).toBe(-Math.sign(compareIssues(b, a)));
  });
});
