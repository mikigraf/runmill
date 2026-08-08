import { describe, expect, it } from "vitest";
import { formatRunDetail } from "../../src/tui/app.js";
import type { RunDetail } from "../../src/daemon/control.js";

describe("OpenTUI presentation", () => {
  it("formats run state, transitions, events, and pending effects", () => {
    const detail: RunDetail = {
      run: {
        runId: "run_123",
        issueId: "ENG-42",
        repo: "acme/platform",
        provider: "codex",
        state: "LOCAL_REVIEW",
        stateVersion: 7,
        attempt: 1,
        baseCommit: "abc",
        candidateSha: "def",
        branch: "runmill/eng-42-1",
      },
      transitions: [
        { from: "LOCAL_VERIFY", to: "LOCAL_REVIEW", at: "2026-08-09T10:01:00Z" },
      ],
      events: [{ seq: 1, type: "review.started", payload: {} }],
      pending: [
        {
          key: "effect_1",
          runId: "run_123",
          system: "github",
          operation: "create_pr",
          target: "acme/platform",
          status: "intended",
          remoteId: null,
          lastError: null,
        },
      ],
    };
    const rendered = formatRunDetail(detail);
    expect(rendered).toContain("ENG-42 · LOCAL_REVIEW");
    expect(rendered).toContain("LOCAL_VERIFY → LOCAL_REVIEW");
    expect(rendered).toContain("review.started");
    expect(rendered).toContain("create_pr → acme/platform");
  });
});
