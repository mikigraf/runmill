import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, CURRENT_SCHEMA_VERSION } from "../../src/state/store.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import { FakeClock } from "../../src/testing/fake-clock.js";
import { MIGRATIONS } from "../../src/state/migrations.js";

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

  it("does not create a database or parent directory for a missing read-only store", () => {
    const path = join(dir, "missing", "runmill.db");

    expect(StateStore.openExistingReadOnly(path, { clock })).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(dir, "missing"))).toBe(false);
  });

  it("opens an existing current database read-only without changing its files", () => {
    const path = join(dir, "runmill.db");
    const writer = open();
    writer.createRun({
      runId: "run_read_only",
      issueId: "ENG-RO",
      repo: "acme/widget",
      provider: "codex",
    });
    writer.close();
    const beforeFiles = readdirSync(dir).sort();
    const beforeDatabase = readFileSync(path);

    const reader = StateStore.openExistingReadOnly(path, { clock });
    expect(reader?.getRun("run_read_only")?.state).toBe("DISCOVERED");
    expect(() =>
      reader?.createRun({
        runId: "run_forbidden_write",
        issueId: "ENG-W",
        repo: "acme/widget",
        provider: "codex",
      }),
    ).toThrow(/readonly/iu);
    reader?.close();

    expect(readFileSync(path)).toEqual(beforeDatabase);
    expect(readdirSync(dir).sort()).toEqual(beforeFiles);
  });

  it("refuses an incompatible read-only schema without migrating or backing it up", () => {
    const path = join(dir, "runmill.db");
    const writer = open();
    writer.forceSchemaVersionForTest(CURRENT_SCHEMA_VERSION - 1);
    writer.close();
    const beforeFiles = readdirSync(dir).sort();
    const beforeDatabase = readFileSync(path);

    expect(() => StateStore.openExistingReadOnly(path, { clock })).toThrow(/schema version/iu);

    expect(readFileSync(path)).toEqual(beforeDatabase);
    expect(readdirSync(dir).sort()).toEqual(beforeFiles);
  });

  it("migrates legacy active leases to unresolved acquiring state", () => {
    const path = join(dir, "runmill.db");
    const legacy = new Database(path);
    const priorMigrations = MIGRATIONS.filter((migration) => migration.version <= 10);
    for (const migration of priorMigrations) {
      legacy.exec(migration.up);
      legacy
        .prepare(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)",
        )
        .run(migration.version, migration.name, "2026-08-06T09:00:00.000Z");
      legacy.pragma(`user_version = ${migration.version}`);
    }
    legacy
      .prepare(
        `INSERT INTO runs(
           run_id, issue_id, repo, provider, state, state_version, attempt,
           created_at, updated_at
         ) VALUES (?,?,?,?,?,1,1,?,?)`,
      )
      .run(
        "run_legacy_lease",
        "ENG-LEGACY",
        "acme/platform",
        "codex",
        "CLAIMED",
        "2026-08-06T09:00:00.000Z",
        "2026-08-06T09:00:00.000Z",
      );
    legacy
      .prepare(
        `INSERT INTO leases(
           issue_id, run_id, repo, generation, ref_name, acquired_at,
           expires_at, heartbeat_at, host_id, pid, released_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
      )
      .run(
        "ENG-LEGACY",
        "run_legacy_lease",
        "acme/platform",
        1,
        "refs/runmill/leases/ENG-LEGACY",
        "2026-08-06T09:00:00.000Z",
        "2026-08-06T09:20:00.000Z",
        "2026-08-06T09:00:00.000Z",
        "legacy-host",
        42,
      );
    legacy.close();

    const migrated = StateStore.open(path, { clock });

    expect(migrated.getLease("ENG-LEGACY")).toMatchObject({
      phase: "acquiring",
      pendingIntent: "acquire",
      objectId: null,
      expectedObjectId: null,
      intendedObjectId: null,
      observedObjectId: null,
      intentAt: "2026-08-06T09:00:00.000Z",
      observedAt: null,
      confirmedAt: null,
    });
    migrated.close();
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

  it("includes committed WAL state in the pre-migration backup", () => {
    const initial = MIGRATIONS.find((migration) => migration.version === 1);
    if (initial === undefined) throw new Error("initial migration is missing");
    const path = join(dir, "runmill.db");
    const legacy = new Database(path);
    legacy.pragma("journal_mode = WAL");
    legacy.pragma("wal_autocheckpoint = 0");
    legacy.exec(initial.up);
    legacy
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)")
      .run(1, initial.name, "2026-08-06T09:59:00.000Z");
    legacy.pragma("user_version = 1");
    legacy
      .prepare(
        `INSERT INTO runs(run_id, issue_id, repo, provider, state, state_version, attempt,
                          created_at, updated_at)
         VALUES ('run_in_wal','ENG-WAL','acme/wal','codex','DISCOVERED',1,1,?,?)`,
      )
      .run("2026-08-06T09:59:00.000Z", "2026-08-06T09:59:00.000Z");
    expect(existsSync(`${path}-wal`)).toBe(true);

    const migrated = StateStore.open(path, { clock });
    migrated.close();
    legacy.close();
    const backupName = readdirSync(dir).find((file) => file.includes(".backup-"));
    if (backupName === undefined) throw new Error("migration backup is missing");
    const backup = new Database(join(dir, backupName), { readonly: true });
    expect(backup.prepare("SELECT run_id AS runId FROM runs").all()).toContainEqual({
      runId: "run_in_wal",
    });
    backup.close();
  });

  it("serializes concurrent migration openers and re-reads the locked version", async () => {
    const initial = MIGRATIONS.find((migration) => migration.version === 1);
    if (initial === undefined) throw new Error("initial migration is missing");
    const path = join(dir, "runmill.db");
    const legacy = new Database(path);
    legacy.exec(initial.up);
    legacy
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)")
      .run(1, initial.name, "2026-08-06T09:59:00.000Z");
    legacy.pragma("user_version = 1");
    legacy.close();

    const barrier = join(dir, "migration.start");
    const script = [
      'import { existsSync } from "node:fs";',
      'import { StateStore } from "./src/state/store.ts";',
      "const wait = new Int32Array(new SharedArrayBuffer(4));",
      'while (!existsSync(process.env["RUNMILL_TEST_BARRIER"])) Atomics.wait(wait, 0, 0, 5);',
      'const store = StateStore.open(process.env["RUNMILL_TEST_DATABASE"]);',
      "process.stdout.write(String(store.schemaVersion()));",
      "store.close();",
    ].join("\n");
    const launch = () => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            RUNMILL_TEST_BARRIER: barrier,
            RUNMILL_TEST_DATABASE: path,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    };
    const openers = [launch(), launch(), launch(), launch()];
    writeFileSync(barrier, "start\n");
    const outcomes = await Promise.all(openers);

    expect(outcomes).toEqual(
      outcomes.map(() => ({
        code: 0,
        stdout: String(CURRENT_SCHEMA_VERSION),
        stderr: "",
      })),
    );
    const migrated = open();
    expect(migrated.appliedMigrations()).toHaveLength(CURRENT_SCHEMA_VERSION);
    migrated.close();
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
  it("allocates monotonically increasing event sequences transactionally", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    expect(store.appendEvent({ runId: "run_1", type: "session.started", payload: {} })).toBe(1);
    expect(store.appendEvent({ runId: "run_1", type: "session.finished", payload: {} })).toBe(2);
    store.close();
  });

  it("returns events in sequence order", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.appendEvent({ runId: "run_1", type: "a", payload: {} });
    store.appendEvent({ runId: "run_1", type: "b", payload: {} });
    expect(store.eventsFor("run_1").map((e) => e.type)).toEqual(["a", "b"]);
    store.close();
  });
});

describe("standalone workflow evidence", () => {
  const BASE = "a".repeat(40);
  const CANDIDATE_A = "b".repeat(40);
  const CANDIDATE_B = "c".repeat(40);

  function createBoundRun(store: StateStore): void {
    store.createRun({
      runId: "run_evidence",
      issueId: "ENG-1",
      repo: "acme/platform",
      provider: "codex",
    });
    store.bindStandaloneWorkspace({
      runId: "run_evidence",
      path: join(dir, "runs", "run_evidence"),
      branch: "runmill/ENG-1-evidence-1",
      baseCommit: BASE,
    });
  }

  it("binds workspace, base, branch, and candidate lineage exactly across reopen", () => {
    const store = open();
    createBoundRun(store);
    expect(store.getRun("run_evidence")).toMatchObject({
      baseCommit: BASE,
      candidateSha: BASE,
      branch: "runmill/ENG-1-evidence-1",
    });
    expect(store.standaloneWorkspace("run_evidence")).toMatchObject({
      path: join(dir, "runs", "run_evidence"),
      branch: "runmill/ENG-1-evidence-1",
      status: "active",
    });

    store.setStandaloneCandidate({
      runId: "run_evidence",
      expectedCandidateSha: BASE,
      candidateSha: CANDIDATE_A,
    });
    expect(() =>
      store.setStandaloneCandidate({
        runId: "run_evidence",
        expectedCandidateSha: BASE,
        candidateSha: CANDIDATE_B,
      }),
    ).toThrow(/candidate/iu);
    store.close();

    const reopened = open();
    expect(reopened.getRun("run_evidence")?.candidateSha).toBe(CANDIDATE_A);
    expect(reopened.standaloneWorkspace("run_evidence")?.status).toBe("active");
    reopened.markStandaloneWorkspace("run_evidence", "preserved");
    expect(reopened.standaloneWorkspace("run_evidence")?.status).toBe("preserved");
    expect(reopened.eventsFor("run_evidence").map((event) => event.type)).toEqual([
      "workspace.bound",
      "candidate.bound",
      "workspace.status",
    ]);
    reopened.close();
  });

  it("persists one canonical full issue snapshot and refuses contradictory replay", () => {
    const store = open();
    createBoundRun(store);
    const body = JSON.stringify({ identifier: "ENG-1", schema: "runmill.issue-snapshot/v1" });
    const fingerprint = `sha256:${createHash("sha256").update(body).digest("hex")}`;

    store.recordStandaloneIssueSnapshot({
      runId: "run_evidence",
      issueId: "ENG-1",
      fingerprint,
      body,
    });
    expect(store.standaloneIssueSnapshot("run_evidence")).toMatchObject({
      issueId: "ENG-1",
      fingerprint,
      body,
    });
    const contradictoryBody = JSON.stringify({
      identifier: "ENG-1",
      schema: "runmill.issue-snapshot/v2",
    });
    expect(() =>
      store.recordStandaloneIssueSnapshot({
        runId: "run_evidence",
        issueId: "ENG-1",
        fingerprint: `sha256:${createHash("sha256").update(contradictoryBody).digest("hex")}`,
        body: contradictoryBody,
      }),
    ).toThrow(/contradictory/iu);
    store.close();
  });

  it("allocates every failed and retried check attempt against the exact current candidate", () => {
    let store = open();
    createBoundRun(store);
    store.setStandaloneCandidate({
      runId: "run_evidence",
      expectedCandidateSha: BASE,
      candidateSha: CANDIDATE_A,
    });
    const result = {
      checkId: "unit",
      required: true,
      source: "repository-policy",
      command: "npm test",
      attempt: 1,
      commitSha: CANDIDATE_A,
      treeHashBefore: "d".repeat(40),
      treeHashAfter: "d".repeat(40),
      executor: "orchestrator" as const,
      outcome: "exited" as const,
      exitCode: 1,
      status: "failed" as const,
      coverage: "proven" as const,
      durationMs: 12,
      stdoutHash: "e".repeat(16),
      notes: ["first failure"],
    };

    const first = store.recordStandaloneVerification({
      runId: "run_evidence",
      candidateSha: CANDIDATE_A,
      mergeReady: false,
      failures: ["unit failed"],
      results: [result],
    });
    store.close();
    store = open();
    const second = store.recordStandaloneVerification({
      runId: "run_evidence",
      candidateSha: CANDIDATE_A,
      mergeReady: true,
      failures: [],
      results: [{ ...result, exitCode: 0, status: "passed", notes: ["retry passed"] }],
    });

    expect(first.eventSeq).toBe(3);
    expect(second.eventSeq).toBe(4);
    expect(store.standaloneChecks("run_evidence")).toMatchObject([
      { checkId: "unit", candidateSha: CANDIDATE_A, attempt: 1, status: "failed" },
      { checkId: "unit", candidateSha: CANDIDATE_A, attempt: 2, status: "passed" },
    ]);
    expect(() =>
      store.recordStandaloneVerification({
        runId: "run_evidence",
        candidateSha: CANDIDATE_B,
        mergeReady: true,
        failures: [],
        results: [{ ...result, commitSha: CANDIDATE_B }],
      }),
    ).toThrow(/current candidate/iu);
    expect(store.eventsFor("run_evidence")).toHaveLength(4);
    store.close();
  });

  it("atomically refuses contradictory passing-check evidence", () => {
    const store = open();
    createBoundRun(store);

    expect(() =>
      store.recordStandaloneVerification({
        runId: "run_evidence",
        candidateSha: BASE,
        mergeReady: true,
        failures: [],
        results: [
          {
            checkId: "unit",
            required: true,
            source: "repository-policy",
            command: "npm test",
            attempt: 1,
            commitSha: BASE,
            treeHashBefore: "d".repeat(40),
            treeHashAfter: "e".repeat(40),
            executor: "orchestrator",
            outcome: "exited",
            exitCode: 0,
            status: "passed",
            coverage: "proven",
            durationMs: 1,
            stdoutHash: "f".repeat(16),
            notes: [],
          },
        ],
      }),
    ).toThrow(/contradictory/iu);
    expect(store.standaloneChecks("run_evidence")).toEqual([]);
    expect(store.eventsFor("run_evidence").map((event) => event.type)).toEqual([
      "workspace.bound",
    ]);
    store.close();
  });

  it("persists a no-findings approval even when there are no finding rows", () => {
    let store = open();
    createBoundRun(store);
    store.setStandaloneCandidate({
      runId: "run_evidence",
      expectedCandidateSha: BASE,
      candidateSha: CANDIDATE_A,
    });
    const outputText = JSON.stringify({
      verdict: "no_findings",
      scope_assessment: "within_scope",
      acceptance_criteria_met: [],
      findings: [],
    });

    const recorded = store.recordStandaloneReview({
      runId: "run_evidence",
      candidateSha: CANDIDATE_A,
      role: "local-reviewer",
      iteration: 1,
      status: "completed",
      outputText,
      verdict: "no_findings",
      scopeAssessment: "within_scope",
      accepted: true,
      explanation: "deterministic cross-check accepted",
      findings: [],
    });

    expect(recorded.review.outputDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    store.close();
    store = open();
    expect(store.standaloneReviews("run_evidence")).toMatchObject([
      {
        candidateSha: CANDIDATE_A,
        role: "local-reviewer",
        iteration: 1,
        verdict: "no_findings",
        accepted: 1,
      },
    ]);
    expect(store.standaloneFindings("run_evidence")).toEqual([]);
    store.close();
  });

  it("refuses review fields that contradict the exact schema-validated output", () => {
    const store = open();
    createBoundRun(store);
    const outputText = JSON.stringify({
      verdict: "approved",
      scope_assessment: "within_scope",
      acceptance_criteria_met: [],
      findings: [],
    });

    expect(() =>
      store.recordStandaloneReview({
        runId: "run_evidence",
        candidateSha: BASE,
        role: "local-reviewer",
        iteration: 1,
        status: "completed",
        outputText,
        verdict: "no_findings",
        scopeAssessment: "within_scope",
        accepted: true,
        explanation: "contradictory",
        findings: [],
      }),
    ).toThrow(/contradict/iu);
    expect(store.standaloneReviews("run_evidence")).toEqual([]);
    expect(store.eventsFor("run_evidence").map((event) => event.type)).toEqual([
      "workspace.bound",
    ]);
    store.close();
  });

  it("persists findings, pull-request observations, policy decisions, and transition actors", () => {
    let store = open();
    createBoundRun(store);
    store.setStandaloneCandidate({
      runId: "run_evidence",
      expectedCandidateSha: BASE,
      candidateSha: CANDIDATE_A,
    });
    const finding = {
      id: "finding-1",
      severity: "high" as const,
      category: "correctness" as const,
      title: "Incorrect result",
      evidence: { path: "src/a.ts", start_line: 1, end_line: 2 },
      claim: "the result is wrong",
      required_resolution: "return the expected result",
      confidence: 0.9,
    };
    store.recordStandaloneReview({
      runId: "run_evidence",
      candidateSha: CANDIDATE_A,
      role: "pr-reviewer",
      iteration: 1,
      status: "completed",
      outputText: JSON.stringify({
        verdict: "changes_required",
        scope_assessment: "within_scope",
        acceptance_criteria_met: [],
        findings: [finding],
      }),
      verdict: "changes_required",
      scopeAssessment: "within_scope",
      accepted: true,
      explanation: "one blocking finding",
      findings: [finding],
    });
    store.recordStandalonePullRequest({
      runId: "run_evidence",
      repo: "acme/platform",
      number: 17,
      headSha: CANDIDATE_A,
      baseSha: BASE,
      draft: true,
      url: "https://example.test/acme/platform/pull/17",
    });
    store.recordStandalonePullRequest({
      runId: "run_evidence",
      repo: "acme/platform",
      number: 17,
      headSha: CANDIDATE_A,
      baseSha: BASE,
      draft: false,
      url: "https://example.test/acme/platform/pull/17",
      mergeSha: CANDIDATE_B,
    });
    expect(
      store.recordStandalonePolicyDecision({
        runId: "run_evidence",
        candidateSha: CANDIDATE_A,
        inputs: { stage: "before-merge" },
        matched: { rules: ["workflow-state"] },
        outcome: "accepted",
        explanation: "issue authority was unchanged",
      }),
    ).toBe(1);
    store.transitionRun("run_evidence", {
      from: "DISCOVERED",
      to: "NEEDS_HUMAN",
      expectedVersion: 1,
      reason: "review finding remains",
      actor: "policy",
    });
    store.close();
    store = open();

    expect(store.standaloneFindings("run_evidence")[0]).toMatchObject({
      findingId: "finding-1",
      severity: "high",
      category: "correctness",
      status: "reported",
    });
    expect(store.standalonePullRequest("run_evidence")).toMatchObject({
      number: 17,
      headSha: CANDIDATE_A,
      mergeSha: CANDIDATE_B,
      draft: 0,
    });
    expect(() =>
      store.recordStandalonePullRequest({
        runId: "run_evidence",
        repo: "acme/platform",
        number: 17,
        headSha: CANDIDATE_A,
        baseSha: BASE,
        draft: false,
        url: "https://example.test/acme/platform/pull/17",
        mergeSha: "d".repeat(40),
      }),
    ).toThrow(/contradictory/iu);
    expect(store.standalonePolicyDecisions("run_evidence")).toMatchObject([
      {
        seq: 1,
        candidateSha: CANDIDATE_A,
        outcome: "accepted",
        explanation: "issue authority was unchanged",
      },
    ]);
    expect(store.standaloneTransitionHistory("run_evidence")).toMatchObject([
      {
        seq: 1,
        from: "DISCOVERED",
        to: "NEEDS_HUMAN",
        reason: "review finding remains",
        actor: "policy",
      },
    ]);
    store.close();
  });

  it("rejects reviews, pull requests, and policy evidence for a stale candidate", () => {
    const store = open();
    createBoundRun(store);
    const stale = CANDIDATE_A;
    const reviewInput = {
      runId: "run_evidence",
      candidateSha: stale,
      role: "local-reviewer" as const,
      iteration: 1,
      status: "completed" as const,
      outputText: JSON.stringify({
        verdict: "approved",
        scope_assessment: "within_scope",
        acceptance_criteria_met: [],
        findings: [],
      }),
      verdict: "approved" as const,
      scopeAssessment: "within_scope" as const,
      accepted: true,
      explanation: "accepted",
      findings: [],
    };

    expect(() => store.recordStandaloneReview(reviewInput)).toThrow(/current candidate/iu);
    expect(() =>
      store.recordStandalonePullRequest({
        runId: "run_evidence",
        repo: "acme/platform",
        number: 1,
        headSha: stale,
        baseSha: BASE,
        draft: true,
        url: "https://example.test/1",
      }),
    ).toThrow(/current candidate/iu);
    expect(() =>
      store.recordStandalonePolicyDecision({
        runId: "run_evidence",
        candidateSha: stale,
        inputs: {},
        matched: {},
        outcome: "accepted",
        explanation: "stale",
      }),
    ).toThrow(/current candidate/iu);
    store.close();
  });

  it("refuses synthetic pull-request commit identities", () => {
    const store = open();
    createBoundRun(store);

    expect(() =>
      store.recordStandalonePullRequest({
        runId: "run_evidence",
        repo: "acme/platform",
        number: 1,
        headSha: BASE,
        baseSha: "base-1",
        draft: true,
        url: "https://example.test/1",
      }),
    ).toThrow(/Git object id/iu);
    expect(store.standalonePullRequest("run_evidence")).toBeUndefined();
    store.close();
  });
});

describe("side-effect outbox", () => {
  it("records intent BEFORE the remote call", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    const begun = store.beginSideEffect({
      runId: "run_1",
      system: "backlog",
      operation: "claim-issue",
      target: "ENG-1",
    });
    expect(begun.disposition).toBe("new");
    expect(store.pendingSideEffects()).toHaveLength(1);
    expect(store.pendingSideEffects()[0]).toMatchObject({
      key: begun.key,
      status: "intended",
    });
    store.close();
  });

  it("returns pending without reopening or changing a duplicate intent", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    const input = {
      runId: "run_1",
      system: "backlog",
      operation: "claim-issue",
      target: "ENG-1",
    };
    const first = store.beginSideEffect(input);
    clock.advanceMinutes(5);
    const duplicate = store.beginSideEffect(input);

    expect(first.disposition).toBe("new");
    expect(duplicate).toMatchObject({
      key: first.key,
      disposition: "pending",
      effect: {
        status: "intended",
        intendedAt: "2026-08-06T10:00:00.000Z",
        updatedAt: "2026-08-06T10:00:00.000Z",
      },
    });
    expect(store.pendingSideEffects()).toHaveLength(1);
    store.close();
  });

  it("returns confirmed without reopening a completed duplicate", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    const input = {
      runId: "run_1",
      system: "github",
      operation: "open-pr",
      target: "acme/platform#runmill/ENG-1",
    };
    const first = store.beginSideEffect(input);
    store.markSideEffectInFlight(first.key);
    store.confirmSideEffect(first.key, "42");
    const before = store.getSideEffect(first.key);
    clock.advanceMinutes(5);

    const duplicate = store.beginSideEffect(input);

    expect(duplicate).toMatchObject({
      key: first.key,
      disposition: "confirmed",
      effect: { status: "confirmed", remoteId: "42" },
    });
    expect(store.getSideEffect(first.key)).toEqual(before);
    store.close();
  });

  it("refuses a deterministic-key binding contradiction", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.beginSideEffect({
      runId: "run_1",
      system: "backlog",
      operation: "claim-issue",
      target: "ENG-1",
    });

    expect(() =>
      store.beginSideEffect({
        runId: "run_1",
        system: "forge",
        operation: "claim-issue",
        target: "ENG-1",
      }),
    ).toThrow(/binding/iu);
    store.close();
  });

  it("serializes duplicate begin calls across store connections", () => {
    const path = join(dir, "runmill.db");
    const firstStore = open();
    firstStore.createRun({
      runId: "run_1",
      issueId: "ENG-1",
      repo: "acme/platform",
      provider: "codex",
    });
    const secondStore = StateStore.open(path, { clock });
    const input = {
      runId: "run_1",
      system: "backlog",
      operation: "claim-issue",
      target: "ENG-1",
    };

    expect(firstStore.beginSideEffect(input).disposition).toBe("new");
    expect(secondStore.beginSideEffect(input).disposition).toBe("pending");
    expect(firstStore.pendingSideEffects()).toHaveLength(1);
    expect(secondStore.pendingSideEffects()).toHaveLength(1);
    secondStore.close();
    firstStore.close();
  });

  it("moves intended -> in_flight -> confirmed and drops out of pending", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    const key = store.beginSideEffect({ runId: "run_1", system: "github", operation: "open-pr", target: "acme/platform#-" }).key;
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
    const key = store.beginSideEffect({ runId: "run_1", system: "github", operation: "merge", target: "acme/platform#7" }).key;
    store.markSideEffectInFlight(key);
    store.failSideEffect(key, "timeout, outcome unknown");
    const pending = store.pendingSideEffects();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "failed", lastError: "timeout, outcome unknown" });
    store.close();
  });

  it("records an operator-verified outcome and removes it from pending", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    const key = store.beginSideEffect({
      runId: "run_1",
      system: "github",
      operation: "merge",
      target: "acme/platform#7",
    }).key;
    store.markSideEffectInFlight(key);
    store.failSideEffect(key, "timeout, outcome unknown");

    store.resolveSideEffect(key, "applied");

    expect(store.pendingSideEffects()).toHaveLength(0);
    expect(store.getSideEffect(key)).toMatchObject({
      status: "confirmed",
      remoteId: "operator:applied",
      lastError: "operator resolved outcome as applied",
    });
    expect(() => store.resolveSideEffect(key, "not-applied")).toThrow(/already resolved/);
    store.close();
  });

  it("survives a crash: intent written before the call is visible on reopen", () => {
    const a = open();
    a.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    a.beginSideEffect({ runId: "run_1", system: "backlog", operation: "claim-issue", target: "ENG-1" });
    a.close(); // simulates process death after intent, before the remote call

    const b = open();
    const pending = b.pendingSideEffects();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ operation: "claim-issue", status: "intended" });
    b.close();
  });

  it("requires every status transition to affect exactly one legal row", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    const key = store.beginSideEffect({
      runId: "run_1",
      system: "github",
      operation: "merge",
      target: "acme/platform#7",
    }).key;

    expect(() => store.confirmSideEffect(key)).toThrow(/transition/iu);
    store.markSideEffectInFlight(key);
    expect(() => store.markSideEffectInFlight(key)).toThrow(/transition/iu);
    store.failSideEffect(key, "response lost");
    expect(() => store.failSideEffect(key, "again")).toThrow(/transition/iu);
    store.resolveSideEffect(key, "not-applied");
    expect(() => store.confirmSideEffect(key)).toThrow(/transition/iu);
    expect(() => store.markSideEffectInFlight("missing")).toThrow(/transition/iu);
    store.close();
  });
});

describe("durable budget ledger", () => {
  it("accumulates spend and invocations across store reopen", () => {
    const first = open();
    first.recordBudgetUsage({
      dayBucket: "2026-08-06",
      repo: "acme/platform",
      costUsd: 0.4,
      invocations: 2,
    });
    first.close();

    const second = open();
    second.recordBudgetUsage({
      dayBucket: "2026-08-06",
      repo: "acme/platform",
      costUsd: 0.6,
      invocations: 3,
    });
    expect(second.budgetUsage("2026-08-06", "acme/platform")).toEqual({
      dayBucket: "2026-08-06",
      repo: "acme/platform",
      costUsd: 1,
      invocations: 5,
    });
    expect(second.budgetUsage("2026-08-07", "acme/platform").costUsd).toBe(0);
    second.close();
  });
});

describe("leases", () => {
  const OBJECT_A = "a".repeat(40);
  const OBJECT_B = "b".repeat(40);

  function beginAcquisition(
    store: StateStore,
    runId: string,
    issueId = "ENG-1",
    objectId = OBJECT_A,
  ): void {
    store.beginLeaseAcquisition({
      issueId,
      runId,
      repo: "acme/platform",
      generation: 1,
      refName: `refs/runmill/leases/${issueId}`,
      objectId,
      acquiredAt: "2026-08-06T10:00:00.000Z",
      expiresAt: "2026-08-06T10:20:00.000Z",
      heartbeatAt: "2026-08-06T10:00:00.000Z",
      hostId: "host-1",
      pid: 123,
    });
  }

  function confirmHeld(
    store: StateStore,
    runId: string,
    issueId = "ENG-1",
    objectId = OBJECT_A,
  ): void {
    expect(
      store.reconcileLeaseObservation({
        issueId,
        runId,
        generation: 1,
        refName: `refs/runmill/leases/${issueId}`,
        objectId,
        observedObjectId: objectId,
      }),
    ).toMatchObject({ outcome: "intended", phase: "held" });
  }

  it("allows only one active lease per issue", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.createRun({ runId: "run_2", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    beginAcquisition(store, "run_1");
    expect(() =>
      beginAcquisition(store, "run_2"),
    ).toThrow();
    store.close();
  });

  it("persists acquisition intent before it can be confirmed held", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });

    beginAcquisition(store, "run_1");

    expect(store.getLease("ENG-1")).toMatchObject({
      issueId: "ENG-1",
      runId: "run_1",
      repo: "acme/platform",
      generation: 1,
      refName: "refs/runmill/leases/ENG-1",
      objectId: OBJECT_A,
      phase: "acquiring",
      pendingIntent: "acquire",
      expectedObjectId: null,
      intendedObjectId: OBJECT_A,
      observedObjectId: null,
      observedAt: null,
    });
    store.close();
  });

  it.each([
    { label: "exact intended object", observed: OBJECT_A, outcome: "intended", phase: "held" },
    { label: "exact absence", observed: null, outcome: "absent", phase: "released" },
    {
      label: "contradictory object",
      observed: OBJECT_B,
      outcome: "contradictory",
      phase: "acquiring",
    },
  ] as const)("reconciles acquisition after observing $label", ({ observed, outcome, phase }) => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    beginAcquisition(store, "run_1");

    expect(
      store.reconcileLeaseObservation({
        issueId: "ENG-1",
        runId: "run_1",
        generation: 1,
        refName: "refs/runmill/leases/ENG-1",
        objectId: OBJECT_A,
        observedObjectId: observed,
      }),
    ).toMatchObject({ outcome, phase });
    const record = store.getLeaseRecord("ENG-1", "run_1", 1);
    expect(record).toMatchObject({
      phase,
      observedObjectId: observed,
      observedAt: "2026-08-06T10:00:00.000Z",
      pendingIntent: phase === "acquiring" ? "acquire" : null,
    });
    expect(store.activeLeaseIssueIds().has("ENG-1")).toBe(phase !== "released");
    store.close();
  });

  it.each([
    { label: "exact absence", observed: null, outcome: "absent", phase: "released" },
    { label: "unchanged expected object", observed: OBJECT_A, outcome: "expected", phase: "held" },
    {
      label: "a fenced object",
      observed: OBJECT_B,
      outcome: "contradictory",
      phase: "releasing",
    },
  ] as const)("reconciles release after observing $label", ({ observed, outcome, phase }) => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    beginAcquisition(store, "run_1");
    confirmHeld(store, "run_1");
    store.beginLeaseRelease({
      issueId: "ENG-1",
      runId: "run_1",
      generation: 1,
      refName: "refs/runmill/leases/ENG-1",
      objectId: OBJECT_A,
    });
    expect(store.getLease("ENG-1")).toMatchObject({
      phase: "releasing",
      pendingIntent: "release",
      expectedObjectId: OBJECT_A,
      intendedObjectId: null,
      observedAt: null,
      confirmedAt: null,
    });

    expect(
      store.reconcileLeaseObservation({
        issueId: "ENG-1",
        runId: "run_1",
        generation: 1,
        refName: "refs/runmill/leases/ENG-1",
        objectId: OBJECT_A,
        observedObjectId: observed,
      }),
    ).toMatchObject({ outcome, phase });
    expect(store.getLeaseRecord("ENG-1", "run_1", 1)).toMatchObject({
      phase,
      pendingIntent: phase === "releasing" ? "release" : null,
      observedObjectId: observed,
    });
    store.close();
  });

  it("retains acquisition and release intent across process crashes", () => {
    const first = open();
    first.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    beginAcquisition(first, "run_1");
    first.close();

    const acquisitionRecovery = open();
    expect(acquisitionRecovery.getLease("ENG-1")).toMatchObject({
      phase: "acquiring",
      pendingIntent: "acquire",
    });
    confirmHeld(acquisitionRecovery, "run_1");
    acquisitionRecovery.beginLeaseRelease({
      issueId: "ENG-1",
      runId: "run_1",
      generation: 1,
      refName: "refs/runmill/leases/ENG-1",
      objectId: OBJECT_A,
    });
    acquisitionRecovery.close();

    const releaseRecovery = open();
    expect(releaseRecovery.getLease("ENG-1")).toMatchObject({
      phase: "releasing",
      pendingIntent: "release",
      expectedObjectId: OBJECT_A,
      intendedObjectId: null,
    });
    releaseRecovery.close();
  });

  it("refuses stale or contradictory lease identity transitions", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    beginAcquisition(store, "run_1");
    confirmHeld(store, "run_1");

    expect(() =>
      store.beginLeaseRelease({
        issueId: "ENG-1",
        runId: "run_1",
        generation: 1,
        refName: "refs/runmill/leases/ENG-1",
        objectId: OBJECT_B,
      }),
    ).toThrow(/transition/iu);
    expect(() =>
      store.reconcileLeaseObservation({
        issueId: "ENG-1",
        runId: "run_1",
        generation: 2,
        refName: "refs/runmill/leases/ENG-1",
        objectId: OBJECT_A,
        observedObjectId: OBJECT_A,
      }),
    ).toThrow(/identity/iu);
    expect(store.getLease("ENG-1")).toMatchObject({ phase: "held" });
    store.close();
  });

  it("releases a lease so the issue can be claimed again", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    store.createRun({ runId: "run_2", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    beginAcquisition(store, "run_1");
    confirmHeld(store, "run_1");
    store.beginLeaseRelease({
      issueId: "ENG-1",
      runId: "run_1",
      generation: 1,
      refName: "refs/runmill/leases/ENG-1",
      objectId: OBJECT_A,
    });
    store.reconcileLeaseObservation({
      issueId: "ENG-1",
      runId: "run_1",
      generation: 1,
      refName: "refs/runmill/leases/ENG-1",
      objectId: OBJECT_A,
      observedObjectId: null,
    });
    expect(() =>
      beginAcquisition(store, "run_2", "ENG-1", OBJECT_B),
    ).not.toThrow();
    store.close();
  });

  it("reports the set of actively leased issues for eligibility", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    beginAcquisition(store, "run_1");
    expect([...store.activeLeaseIssueIds()]).toEqual(["ENG-1"]);
    store.close();
  });

  it("heartbeat extends expiry and records the moment", () => {
    const store = open();
    store.createRun({ runId: "run_1", issueId: "ENG-1", repo: "acme/platform", provider: "codex" });
    beginAcquisition(store, "run_1");
    confirmHeld(store, "run_1");
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
