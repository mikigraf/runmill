import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CircuitBreakers,
  Daemon,
  DEFAULT_BREAKERS,
} from "../../src/orchestrator/daemon.js";
import type { RunOutcome } from "../../src/orchestrator/orchestrator.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import { FakeClock } from "../../src/testing/fake-clock.js";
import { MIGRATIONS } from "../../src/state/migrations.js";
import { CURRENT_SCHEMA_VERSION, StateStore } from "../../src/state/store.js";

let directory: string;
let path: string;
let clock: FakeClock;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "runmill-breakers-"));
  path = join(directory, "runmill.db");
  clock = new FakeClock("2026-08-06T10:00:00.000Z");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function open(): StateStore {
  return StateStore.open(path, { clock });
}

function outcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: "run_breaker",
    issueId: "ENG-BREAKER",
    finalState: "PR_DELIVERED",
    costUsd: 0.1,
    ...overrides,
  };
}

function mutate(sql: string): void {
  const database = new Database(path);
  database.exec(sql);
  database.close();
}

function expectStateRefusal(action: () => unknown): void {
  try {
    action();
    expect.unreachable("malformed circuit breaker state should be refused");
  } catch (error) {
    expect(error).toBeInstanceOf(RunmillError);
    expect((error as RunmillError).code).toBe("RM-STATE-002");
  }
}

describe("persistent circuit breakers", () => {
  it("migrates a v7 database to a complete canonical zero snapshot", () => {
    const legacy = new Database(path);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 7)) {
      legacy.exec(migration.up);
      legacy
        .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)")
        .run(migration.version, migration.name, "2026-08-06T09:00:00.000Z");
      legacy.pragma(`user_version = ${migration.version}`);
    }
    legacy.close();

    const migrated = open();
    expect(migrated.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.getCircuitBreakerState()).toEqual({
      consecutiveFailures: 0,
      quarantines: 0,
      escalations: 0,
      completed: 0,
      tripped: null,
    });
    migrated.close();
  });

  it("hydrates counters and an opened trip across daemon process restarts", () => {
    const config = { ...DEFAULT_BREAKERS, maxQuarantines: 99 };
    const firstStore = open();
    const first = new CircuitBreakers(config, firstStore);
    first.record(outcome({ finalState: "NEEDS_HUMAN" }));
    first.record(outcome({ finalState: "NEEDS_HUMAN" }));
    expect(first.evaluate(clock)).toBeUndefined();
    firstStore.close();

    const secondStore = open();
    const second = new CircuitBreakers(config, secondStore);
    second.record(outcome({ finalState: "NEEDS_HUMAN" }));
    const opened = second.evaluate(clock);
    expect(opened).toMatchObject({
      name: "consecutive-failures",
      open: true,
      openedAt: "2026-08-06T10:00:00.000Z",
    });
    secondStore.close();

    clock.advanceMinutes(30);
    const thirdStore = open();
    const third = new CircuitBreakers(config, thirdStore);
    expect(third.evaluate(clock)).toEqual(opened);
    expect(thirdStore.getCircuitBreakerState()).toMatchObject({
      completed: 3,
      consecutiveFailures: 3,
      escalations: 3,
      quarantines: 0,
      tripped: {
        name: "consecutive-failures",
        openedAt: "2026-08-06T10:00:00.000Z",
      },
    });
    thirdStore.close();
  });

  it("stops a restarted daemon before it can dispatch past a durable trip", async () => {
    const firstStore = open();
    const firstDaemon = new Daemon({
      clock,
      store: firstStore,
      breakers: new CircuitBreakers(DEFAULT_BREAKERS, firstStore),
    });
    const firstResult = await firstDaemon.loop(async () =>
      outcome({ finalState: "QUARANTINED" }),
    );
    expect(firstResult.breaker?.name).toBe("quarantine");
    firstStore.close();

    const secondStore = open();
    const secondDaemon = new Daemon({
      clock,
      store: secondStore,
      breakers: new CircuitBreakers(DEFAULT_BREAKERS, secondStore),
    });
    let dispatched = false;
    const secondResult = await secondDaemon.loop(async () => {
      dispatched = true;
      return outcome();
    });
    expect(dispatched).toBe(false);
    expect(secondResult).toMatchObject({
      stoppedBecause: "breaker",
      breaker: { name: "quarantine", open: true },
    });
    secondStore.close();
  });

  it("keeps daily cost out of breaker rows because the budget ledger owns it", () => {
    const firstStore = open();
    const first = new CircuitBreakers(
      { ...DEFAULT_BREAKERS, dailyCostUsd: 1 },
      firstStore,
    );
    first.record(outcome({ costUsd: 1 }));
    expect(first.evaluate(clock)?.name).toBe("daily-cost");
    firstStore.recordBudgetUsage({
      dayBucket: "2026-08-06",
      repo: "acme/platform",
      costUsd: 1,
      invocations: 1,
    });
    firstStore.close();

    const secondStore = open();
    const second = new CircuitBreakers(
      { ...DEFAULT_BREAKERS, dailyCostUsd: 1 },
      secondStore,
    );
    expect(second.evaluate(clock)).toBeUndefined();
    const usage = secondStore.budgetUsage("2026-08-06", "acme/platform");
    second.setDailySpend(usage.dayBucket, usage.costUsd);
    expect(second.evaluate(clock)?.name).toBe("daily-cost");
    secondStore.close();

    const raw = new Database(path, { readonly: true });
    expect(
      raw.prepare("SELECT name FROM circuit_breakers ORDER BY name").all(),
    ).toEqual([
      { name: "consecutive-failures" },
      { name: "escalation-rate" },
      { name: "quarantine" },
    ]);
    raw.close();
  });

  it("refuses a missing snapshot instead of silently resetting counters", () => {
    const store = open();
    store.close();
    mutate("DELETE FROM circuit_breakers");

    const reopened = open();
    expectStateRefusal(() => reopened.getCircuitBreakerState());
    reopened.close();
  });

  it("refuses a partial snapshot", () => {
    const store = open();
    store.close();
    mutate("DELETE FROM circuit_breakers WHERE name = 'quarantine'");

    const reopened = open();
    expectStateRefusal(() => new CircuitBreakers(DEFAULT_BREAKERS, reopened));
    reopened.close();
  });

  it("refuses an unknown row even when the row count still looks complete", () => {
    const store = open();
    store.close();
    mutate(`
      DELETE FROM circuit_breakers WHERE name = 'quarantine';
      INSERT INTO circuit_breakers(name, state, opened_at, reason)
      VALUES ('daily-cost', '{"count":0}', NULL, NULL);
    `);

    const reopened = open();
    expectStateRefusal(() => reopened.getCircuitBreakerState());
    reopened.close();
  });

  it("refuses corrupt and non-canonical row state", () => {
    const store = open();
    store.close();
    mutate(`
      UPDATE circuit_breakers
      SET state = '{ "schema": "runmill.circuit-breaker-counter/v1", "count": 1 }'
      WHERE name = 'quarantine';
    `);

    const reopened = open();
    expectStateRefusal(() => reopened.getCircuitBreakerState());
    reopened.close();
  });

  it("refuses contradictory trip metadata and multiple open breakers", () => {
    const store = open();
    store.close();
    mutate(`
      UPDATE circuit_breakers
      SET opened_at = '2026-08-06T10:00:00.000Z', reason = 'opened'
      WHERE name IN ('quarantine', 'escalation-rate');
    `);

    const reopened = open();
    expectStateRefusal(() => reopened.getCircuitBreakerState());
    reopened.close();
  });

  it("does not allow a caller to clear a durable trip", () => {
    const store = open();
    const breakers = new CircuitBreakers(DEFAULT_BREAKERS, store);
    breakers.record(outcome({ finalState: "QUARANTINED" }));
    expect(breakers.evaluate(clock)?.name).toBe("quarantine");

    const opened = store.getCircuitBreakerState();
    expectStateRefusal(() =>
      store.saveCircuitBreakerState({ ...opened, tripped: null }),
    );
    expect(store.getCircuitBreakerState()).toEqual(opened);
    store.close();
  });

  it("rolls back every breaker row when one row cannot be persisted", () => {
    const store = open();
    mutate(`
      CREATE TRIGGER reject_quarantine_breaker
      BEFORE UPDATE ON circuit_breakers
      WHEN NEW.name = 'quarantine'
      BEGIN
        SELECT RAISE(ABORT, 'planted persistence failure');
      END;
    `);
    const breakers = new CircuitBreakers(DEFAULT_BREAKERS, store);

    expect(() => breakers.record(outcome())).toThrow(/planted persistence failure/);
    expect(store.getCircuitBreakerState()).toEqual({
      consecutiveFailures: 0,
      quarantines: 0,
      escalations: 0,
      completed: 0,
      tripped: null,
    });
    store.close();
  });
});
