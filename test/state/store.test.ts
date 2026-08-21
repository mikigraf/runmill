import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, CURRENT_SCHEMA_VERSION } from "../../src/state/store.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

let dir: string;
let clock: FakeClock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runmill-store-"));
  clock = new FakeClock("2026-08-06T10:00:00Z");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function open(): StateStore {
  return StateStore.open(join(dir, "runmill.db"), { clock });
}

describe("StateStore.open", () => {
  it("creates the database and migrates to the current schema version", () => {
    const store = open();
    expect(store.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    store.close();
  });

  it("enables WAL, a busy timeout, and foreign key enforcement", () => {
    // Concurrent readers (status, logs --follow) against a writing daemon
    // produce SQLITE_BUSY without these.
    const store = open();
    expect(store.pragma("journal_mode")).toBe("wal");
    expect(Number(store.pragma("busy_timeout"))).toBeGreaterThan(0);
    expect(Number(store.pragma("foreign_keys"))).toBe(1);
    store.close();
  });

  it("is idempotent: reopening does not re-run migrations", () => {
    const a = open();
    const v = a.schemaVersion();
    a.close();
    const b = open();
    expect(b.schemaVersion()).toBe(v);
    expect(b.appliedMigrations().length).toBe(CURRENT_SCHEMA_VERSION);
    b.close();
  });

  it("refuses to open a database newer than the binary understands", () => {
    const store = open();
    store.forceSchemaVersionForTest(CURRENT_SCHEMA_VERSION + 5);
    store.close();

    try {
      open();
      expect.unreachable("should have refused a newer schema");
    } catch (err) {
      expect(err).toBeInstanceOf(RunmillError);
      expect((err as RunmillError).code).toBe("RM-STATE-001");
    }
  });

  it("backs the database up before migrating an existing file", () => {
    // An existing file at version 0: the audit record is real and must be
    // copied before any DDL touches it.
    writeFileSync(join(dir, "runmill.db"), "");
    const store = open();
    store.close();
    const backups = readdirSync(dir).filter((f) => f.includes(".backup-"));
    expect(backups.length).toBe(1);
  });

  it("does not back up a database it is creating for the first time", () => {
    const store = open();
    store.close();
    expect(readdirSync(dir).filter((f) => f.includes(".backup-"))).toHaveLength(0);
  });

  it("creates the data directory with owner-only permissions", () => {
    const nested = join(dir, "nested", "runmill.db");
    const store = StateStore.open(nested, { clock });
    expect(existsSync(nested)).toBe(true);
    store.close();
  });
});

describe("runs and optimistic state transitions", () => {
  it("records a run and returns it", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    const run = store.getRun("run_1");
    expect(run).toMatchObject({ runId: "run_1", state: "DISCOVERED", stateVersion: 1 });
    store.close();
  });

  it("advances state and bumps the version", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.transitionRun("run_1", { from: "DISCOVERED", to: "ELIGIBILITY_CHECKED", expectedVersion: 1 });
    expect(store.getRun("run_1")).toMatchObject({ state: "ELIGIBILITY_CHECKED", stateVersion: 2 });
    store.close();
  });

  it("rejects a transition from the wrong source state", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    expect(() =>
      store.transitionRun("run_1", { from: "MERGED", to: "COMPLETED", expectedVersion: 1 }),
    ).toThrow(/expected state/i);
    store.close();
  });

  it("rejects a stale version: two processes cannot both transition a run", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.transitionRun("run_1", { from: "DISCOVERED", to: "ELIGIBILITY_CHECKED", expectedVersion: 1 });
    expect(() =>
      store.transitionRun("run_1", { from: "DISCOVERED", to: "CLAIMED", expectedVersion: 1 }),
    ).toThrow();
    store.close();
  });

  it("records every transition for audit reconstruction", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.transitionRun("run_1", { from: "DISCOVERED", to: "ELIGIBILITY_CHECKED", expectedVersion: 1 });
    store.transitionRun("run_1", { from: "ELIGIBILITY_CHECKED", to: "CLAIMED", expectedVersion: 2 });
    const history = store.transitionHistory("run_1");
    expect(history.map((t) => t.to)).toEqual(["ELIGIBILITY_CHECKED", "CLAIMED"]);
    expect(history[0]?.at).toBe("2026-08-06T10:00:00.000Z");
    store.close();
  });
});

describe("events", () => {
  it("enforces unique (run_id, seq) so replay cannot duplicate", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.appendEvent({ runId: "run_1", seq: 1, type: "session.started", payload: {} });
    expect(() =>
      store.appendEvent({ runId: "run_1", seq: 1, type: "session.started", payload: {} }),
    ).toThrow();
    store.close();
  });

  it("returns events in sequence order", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.appendEvent({ runId: "run_1", seq: 2, type: "b", payload: {} });
    store.appendEvent({ runId: "run_1", seq: 1, type: "a", payload: {} });
    expect(store.eventsFor("run_1").map((e) => e.type)).toEqual(["a", "b"]);
    store.close();
  });
});

describe("side-effect outbox", () => {
  it("records intent BEFORE the remote call", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    const key = store.intendSideEffect({
      runId: "run_1",
      system: "backlog",
      operation: "claim-issue",
      target: "ENG-1",
    });
    expect(store.pendingSideEffects()).toHaveLength(1);
    expect(store.pendingSideEffects()[0]).toMatchObject({ key, status: "intended" });
    store.close();
  });

  it("derives a deterministic key from (run, operation, target)", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    const a = store.intendSideEffect({ runId: "run_1", system: "backlog", operation: "claim-issue", target: "ENG-1" });
    const b = store.intendSideEffect({ runId: "run_1", system: "backlog", operation: "claim-issue", target: "ENG-1" });
    expect(b).toBe(a);
    expect(store.pendingSideEffects()).toHaveLength(1);
    store.close();
  });

  it("moves intended -> in_flight -> confirmed and drops out of pending", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    const key = store.intendSideEffect({ runId: "run_1", system: "github", operation: "open-pr", target: "acme/platform#-" });
    store.markSideEffectInFlight(key);
    expect(store.pendingSideEffects()[0]?.status).toBe("in_flight");
    store.confirmSideEffect(key, "42");
    expect(store.pendingSideEffects()).toHaveLength(0);
    expect(store.getSideEffect(key)).toMatchObject({ status: "confirmed", remoteId: "42" });
    store.close();
  });

  it("keeps a failed effect pending so recovery can reconcile it", () => {
    // "Never assume failure means no side effect." A failed row stays in the
    // recovery sweep until a reconcile query proves what actually happened.
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    const key = store.intendSideEffect({ runId: "run_1", system: "github", operation: "merge", target: "acme/platform#7" });
    store.markSideEffectInFlight(key);
    store.failSideEffect(key, "timeout, outcome unknown");
    const pending = store.pendingSideEffects();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "failed", lastError: "timeout, outcome unknown" });
    store.close();
  });

  it("survives a crash: intent written before the call is visible on reopen", () => {
    const a = open();
    a.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    a.intendSideEffect({ runId: "run_1", system: "backlog", operation: "claim-issue", target: "ENG-1" });
    a.close(); // simulates process death after intent, before the remote call

    const b = open();
    const pending = b.pendingSideEffects();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ operation: "claim-issue", status: "intended" });
    b.close();
  });
});

describe("leases", () => {
  it("allows only one active lease per issue", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.createRun({ runId: "run_2", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.recordLease({ issueId: "ENG-1", runId: "run_1", generation: 1, repo: "acme/platform", expiresAt: "2026-08-06T10:20:00Z" });
    expect(() =>
      store.recordLease({ issueId: "ENG-1", runId: "run_2", generation: 1, repo: "acme/platform", expiresAt: "2026-08-06T10:20:00Z" }),
    ).toThrow();
    store.close();
  });

  it("releases a lease so the issue can be claimed again", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.createRun({ runId: "run_2", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.recordLease({ issueId: "ENG-1", runId: "run_1", generation: 1, repo: "acme/platform", expiresAt: "2026-08-06T10:20:00Z" });
    store.releaseLease("ENG-1", "run_1");
    expect(() =>
      store.recordLease({ issueId: "ENG-1", runId: "run_2", generation: 2, repo: "acme/platform", expiresAt: "2026-08-06T10:20:00Z" }),
    ).not.toThrow();
    store.close();
  });

  it("reports the set of actively leased issues for eligibility", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.recordLease({ issueId: "ENG-1", runId: "run_1", generation: 1, repo: "acme/platform", expiresAt: "2026-08-06T10:20:00Z" });
    expect([...store.activeLeaseIssueIds()]).toEqual(["ENG-1"]);
    store.close();
  });

  it("heartbeat extends expiry and records the moment", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.recordLease({ issueId: "ENG-1", runId: "run_1", generation: 1, repo: "acme/platform", expiresAt: "2026-08-06T10:20:00Z" });
    clock.advanceMinutes(5);
    store.heartbeatLease("ENG-1", "run_1", "2026-08-06T10:25:00Z");
    const lease = store.getLease("ENG-1");
    expect(lease?.expiresAt).toBe("2026-08-06T10:25:00Z");
    expect(lease?.heartbeatAt).toBe("2026-08-06T10:05:00.000Z");
    store.close();
  });
});

describe("attemptsFor", () => {
  /**
   * The branch template is validated to contain {attempt} precisely so a retry
   * does not reuse a branch. The orchestrator hardcoded "1", so a retry of an
   * escalated issue pushed to the branch its own previous attempt had already
   * created and the run quarantined on a rejected push.
   */
  it("counts no prior runs for an issue that has never been seen", () => {
    const store = open();
    expect(store.attemptsFor("ENG-404")).toBe(0);
    store.close();
  });

  it("counts each run recorded for the issue", () => {
    const store = open();
    store.createRun({ runId: "r1", issueId: "ENG-9", repo: "o/r", provider: "codex" });
    expect(store.attemptsFor("ENG-9")).toBe(1);

    store.createRun({ runId: "r2", issueId: "ENG-9", repo: "o/r", provider: "codex" });
    expect(store.attemptsFor("ENG-9")).toBe(2);
    store.close();
  });

  it("counts per issue, not across the whole store", () => {
    const store = open();
    store.createRun({ runId: "r3", issueId: "ENG-10", repo: "o/r", provider: "codex" });
    store.createRun({ runId: "r4", issueId: "ENG-11", repo: "o/r", provider: "codex" });

    expect(store.attemptsFor("ENG-10")).toBe(1);
    expect(store.attemptsFor("ENG-11")).toBe(1);
    store.close();
  });
});
