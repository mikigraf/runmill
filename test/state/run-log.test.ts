import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunLog, formatRunTimestamp } from "../../src/state/run-log.js";
import type { BacklogIssue } from "../../src/domain/types.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const ISSUE: BacklogIssue = {
  identifier: "ENG-42",
  title: "Ship the new flow",
  description: "Acceptance criteria:\n- it ships",
  priority: 2,
  labels: [],
  state: "Todo",
  teamKey: "ENG",
  createdAt: "2026-08-08T00:00:00Z",
  canceled: false,
  completed: false,
  blockedBy: [],
};

describe("run markdown log", () => {
  it("formats dates as DD/MM/YYYY and uses 24-hour time", () => {
    expect(formatRunTimestamp(new Date(2026, 7, 8, 17, 5))).toBe("08/08/2026 17:05");
  });

  it("appends a concise completed-issue entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "runmill-log-"));
    dirs.push(dir);
    const path = join(dir, ".runmill", "log.md");
    new RunLog(path).append({
      at: new Date(2026, 7, 8, 17, 5),
      issue: ISSUE,
      outcome: "PR_DELIVERED",
      runId: "run_42",
      prNumber: 12,
      prUrl: "https://github.com/acme/platform/pull/12",
      costUsd: 1.25,
    });
    const body = readFileSync(path, "utf8");
    expect(body).toContain("08/08/2026 17:05");
    expect(body).toContain("**ENG-42** Ship the new flow");
    expect(body).toContain("[PR #12]");
    expect(body).toContain("$1.25");
  });
});
