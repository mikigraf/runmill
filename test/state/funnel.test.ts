/**
 * The local onboarding funnel.
 *
 * Two properties matter and neither is obvious from the call sites. First,
 * milestones are write-once, because a second `runmill doctor` must not reset
 * the clock that Time To Hello World is measured against. Second, the whole
 * module is instrumentation: it is called from command paths that have real
 * work to do, so a failure to record must never become a failure to run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordMilestone, recordDoctorFailure, readFunnel } from "../../src/state/funnel.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "runmill-funnel-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("recordMilestone", () => {
  it("records a milestone as an ISO timestamp", () => {
    recordMilestone(dataDir, "installed_at", new Date("2026-01-01T10:00:00.000Z"));

    expect(readFunnel(dataDir).milestones["installed_at"]).toBe("2026-01-01T10:00:00.000Z");
  });

  it("never overwrites a milestone it already has", () => {
    // `runmill doctor` runs many times. If the second run moved installed_at
    // forward, TTHW would shrink toward zero and stop meaning anything.
    recordMilestone(dataDir, "first_doctor_run_at", new Date("2026-01-01T10:00:00.000Z"));
    recordMilestone(dataDir, "first_doctor_run_at", new Date("2026-01-02T10:00:00.000Z"));

    expect(readFunnel(dataDir).milestones["first_doctor_run_at"]).toBe(
      "2026-01-01T10:00:00.000Z",
    );
  });

  it("keeps milestones independent of one another", () => {
    recordMilestone(dataDir, "installed_at", new Date("2026-01-01T10:00:00.000Z"));
    recordMilestone(dataDir, "init_completed_at", new Date("2026-01-01T10:05:00.000Z"));

    const { milestones } = readFunnel(dataDir);
    expect(milestones["installed_at"]).toBe("2026-01-01T10:00:00.000Z");
    expect(milestones["init_completed_at"]).toBe("2026-01-01T10:05:00.000Z");
  });

  it("does not throw when the database cannot be opened", () => {
    // A file where the directory should be. The command that called this still
    // has work to do; instrumentation is not allowed to abort it.
    const blocked = join(dataDir, "blocked");
    writeFileSync(blocked, "not a directory");

    expect(() => recordMilestone(blocked, "installed_at", new Date())).not.toThrow();
  });
});

describe("recordDoctorFailure", () => {
  it("counts failures per error code", () => {
    recordDoctorFailure(dataDir, "RM-DOCTOR-001");
    recordDoctorFailure(dataDir, "RM-DOCTOR-001");
    recordDoctorFailure(dataDir, "RM-DOCTOR-002");

    expect(readFunnel(dataDir).doctorFailures).toEqual({
      "RM-DOCTOR-001": 2,
      "RM-DOCTOR-002": 1,
    });
  });

  it("keeps failure counters out of the milestone set", () => {
    recordMilestone(dataDir, "installed_at", new Date("2026-01-01T10:00:00.000Z"));
    recordDoctorFailure(dataDir, "RM-DOCTOR-001");

    const snapshot = readFunnel(dataDir);
    expect(Object.keys(snapshot.milestones)).toEqual(["installed_at"]);
    expect(Object.keys(snapshot.doctorFailures)).toEqual(["RM-DOCTOR-001"]);
  });

  it("does not throw when the database cannot be opened", () => {
    const blocked = join(dataDir, "blocked");
    writeFileSync(blocked, "not a directory");

    expect(() => recordDoctorFailure(blocked, "RM-DOCTOR-001")).not.toThrow();
  });
});

describe("readFunnel", () => {
  it("reports TTHW in seconds once install and first PR both exist", () => {
    recordMilestone(dataDir, "installed_at", new Date("2026-01-01T10:00:00.000Z"));
    recordMilestone(dataDir, "first_pr_opened_at", new Date("2026-01-01T10:04:30.000Z"));

    expect(readFunnel(dataDir).tthwSeconds).toBe(270);
  });

  it("leaves TTHW undefined until the first pull request exists", () => {
    recordMilestone(dataDir, "installed_at", new Date("2026-01-01T10:00:00.000Z"));
    recordMilestone(dataDir, "first_run_started_at", new Date("2026-01-01T10:02:00.000Z"));

    expect(readFunnel(dataDir).tthwSeconds).toBeUndefined();
  });

  it("leaves TTHW undefined when the install milestone is missing", () => {
    recordMilestone(dataDir, "first_pr_opened_at", new Date("2026-01-01T10:04:30.000Z"));

    expect(readFunnel(dataDir).tthwSeconds).toBeUndefined();
  });

  it("returns an empty snapshot rather than throwing when there is no database", () => {
    const blocked = join(dataDir, "blocked");
    writeFileSync(blocked, "not a directory");

    expect(readFunnel(blocked)).toEqual({ milestones: {}, doctorFailures: {} });
  });

  it("returns an empty snapshot for a fresh install", () => {
    const snapshot = readFunnel(dataDir);

    expect(snapshot.milestones).toEqual({});
    expect(snapshot.doctorFailures).toEqual({});
    expect(snapshot.tthwSeconds).toBeUndefined();
  });
});
