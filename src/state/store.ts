import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { Clock } from "../platform/clock.js";
import { SystemClock } from "../platform/clock.js";
import { RunmillError } from "../errors/runmill-error.js";
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from "./migrations.js";

export { CURRENT_SCHEMA_VERSION };

const BUSY_TIMEOUT_MS = 5_000;

export interface RunRow {
  runId: string;
  issueId: string;
  repo: string;
  provider: string;
  state: string;
  stateVersion: number;
  attempt: number;
  baseCommit: string | null;
  candidateSha: string | null;
  branch: string | null;
}

export interface LeaseRow {
  issueId: string;
  runId: string;
  repo: string;
  generation: number;
  expiresAt: string;
  heartbeatAt: string | null;
  releasedAt: string | null;
}

export type SideEffectStatus = "intended" | "in_flight" | "confirmed" | "failed";

export interface SideEffectRow {
  key: string;
  runId: string;
  system: string;
  operation: string;
  target: string;
  status: SideEffectStatus;
  remoteId: string | null;
  lastError: string | null;
}

export interface StateStoreOptions {
  readonly clock?: Clock;
}

/**
 * Durable run state.
 *
 * Single-writer by design: a flock on the data directory enforces one
 * orchestrator, and writers use short IMMEDIATE transactions so concurrent
 * readers (`status`, `logs --follow`) never see a partial state.
 */
export class StateStore {
  readonly #db: Database.Database;
  readonly #clock: Clock;

  private constructor(db: Database.Database, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  static open(path: string, options: StateStoreOptions = {}): StateStore {
    const clock = options.clock ?? new SystemClock();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    const existedBefore = existsSync(path);
    const db = new Database(path);

    db.pragma("journal_mode = WAL");
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = FULL");

    const store = new StateStore(db, clock);
    store.#migrate(path, existedBefore);
    return store;
  }

  #userVersion(): number {
    return Number(this.#db.pragma("user_version", { simple: true }));
  }

  /** Runs multi-statement DDL. `Database#exec` is better-sqlite3's API; it is
   *  not `child_process`, and no user input ever reaches it: every string
   *  comes from the compiled-in MIGRATIONS table. */
  #applyDdl(sql: string): void {
    this.#db.exec(sql);
  }

  #migrate(path: string, existedBefore: boolean): void {
    const current = this.#userVersion();

    if (current > CURRENT_SCHEMA_VERSION) {
      this.#db.close();
      throw RunmillError.fromCatalog("RM-STATE-001", {
        whatHappened:
          `Database at ${path} is at schema version ${current}; ` +
          `this binary understands up to ${CURRENT_SCHEMA_VERSION}.`,
      });
    }

    if (current === CURRENT_SCHEMA_VERSION) return;

    // Back up before mutating an existing audit record. A fresh database has
    // nothing to lose, so skip the copy on first-time open.
    if (existedBefore) {
      const stamp = this.#clock.now().toISOString().replace(/[:.]/g, "-");
      try {
        copyFileSync(path, `${path}.backup-${stamp}`);
      } catch {
        // A failed backup must not block an otherwise-safe migration; the
        // original file is intact until the transaction commits.
      }
    }

    const pending = MIGRATIONS.filter((m) => m.version > current).sort(
      (a, b) => a.version - b.version,
    );

    const tx = this.#db.transaction(() => {
      for (const migration of pending) {
        this.#applyDdl(migration.up);
        this.#db
          .prepare(
            "INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)",
          )
          .run(migration.version, migration.name, this.#clock.now().toISOString());
        this.#db.pragma(`user_version = ${migration.version}`);
      }
    });
    tx();
  }

  schemaVersion(): number {
    return this.#userVersion();
  }

  appliedMigrations(): { version: number; name: string }[] {
    return this.#db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as { version: number; name: string }[];
  }

  pragma(name: string): string | number {
    return this.#db.pragma(name, { simple: true }) as string | number;
  }

  /** Test-only escape hatch for exercising migration and refusal paths. */
  forceSchemaVersionForTest(version: number): void {
    this.#db.pragma(`user_version = ${version}`);
  }

  close(): void {
    this.#db.close();
  }

  // -- runs --------------------------------------------------------------

  createRun(input: {
    runId: string;
    issueId: string;
    repo: string;
    provider: string;
    attempt?: number;
    baseCommit?: string;
    branch?: string;
  }): void {
    const at = this.#clock.now().toISOString();
    this.#db
      .prepare(
        `INSERT INTO runs(run_id, issue_id, repo, provider, state, state_version, attempt,
                          base_commit, branch, created_at, updated_at)
         VALUES (?,?,?,?,'DISCOVERED',1,?,?,?,?,?)`,
      )
      .run(
        input.runId,
        input.issueId,
        input.repo,
        input.provider,
        input.attempt ?? 1,
        input.baseCommit ?? null,
        input.branch ?? null,
        at,
        at,
      );
  }

  getRun(runId: string): RunRow | undefined {
    return this.#db
      .prepare(
        `SELECT run_id AS runId, issue_id AS issueId, repo, provider, state,
                state_version AS stateVersion, attempt, base_commit AS baseCommit,
                candidate_sha AS candidateSha, branch
         FROM runs WHERE run_id = ?`,
      )
      .get(runId) as RunRow | undefined;
  }

  /**
   * Compare-and-swap state transition.
   *
   * Guards on both the source state and the version, so two processes cannot
   * both advance a run and a resumed stale process cannot replay a transition
   * that already happened.
   */
  transitionRun(
    runId: string,
    opts: { from: string; to: string; expectedVersion: number; reason?: string; actor?: string },
  ): void {
    const at = this.#clock.now().toISOString();
    const tx = this.#db.transaction(() => {
      const result = this.#db
        .prepare(
          `UPDATE runs SET state = ?, state_version = state_version + 1, updated_at = ?
           WHERE run_id = ? AND state = ? AND state_version = ?`,
        )
        .run(opts.to, at, runId, opts.from, opts.expectedVersion);

      if (result.changes === 0) {
        const actual = this.getRun(runId);
        throw new Error(
          `transition rejected for ${runId}: expected state ${opts.from} at version ` +
            `${opts.expectedVersion}, found ${actual?.state ?? "<missing run>"} at version ` +
            `${actual?.stateVersion ?? "-"}`,
        );
      }

      const seq =
        (
          this.#db
            .prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM state_transitions WHERE run_id = ?")
            .get(runId) as { s: number }
        ).s + 1;

      this.#db
        .prepare(
          `INSERT INTO state_transitions(run_id, seq, from_state, to_state, reason, actor, at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(runId, seq, opts.from, opts.to, opts.reason ?? null, opts.actor ?? "orchestrator", at);
    });
    tx();
  }

  /** Newest first. Backs `runmill list` and `list --needs-attention`. */
  listRuns(limit = 50): RunRow[] {
    return this.#db
      .prepare(
        `SELECT run_id AS runId, issue_id AS issueId, repo, provider, state,
                state_version AS stateVersion, attempt, base_commit AS baseCommit,
                candidate_sha AS candidateSha, branch
         FROM runs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as RunRow[];
  }

  transitionHistory(runId: string): { from: string; to: string; at: string }[] {
    return this.#db
      .prepare(
        `SELECT from_state AS "from", to_state AS "to", at
         FROM state_transitions WHERE run_id = ? ORDER BY seq`,
      )
      .all(runId) as { from: string; to: string; at: string }[];
  }

  // -- events ------------------------------------------------------------

  appendEvent(input: {
    runId: string;
    seq: number;
    type: string;
    payload: unknown;
    artifactRef?: string;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO events(run_id, seq, type, payload, artifact_ref, at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        input.runId,
        input.seq,
        input.type,
        JSON.stringify(input.payload),
        input.artifactRef ?? null,
        this.#clock.now().toISOString(),
      );
  }

  eventsFor(runId: string): { seq: number; type: string; payload: unknown }[] {
    const rows = this.#db
      .prepare("SELECT seq, type, payload FROM events WHERE run_id = ? ORDER BY seq")
      .all(runId) as { seq: number; type: string; payload: string }[];
    return rows.map((r) => ({ seq: r.seq, type: r.type, payload: JSON.parse(r.payload) }));
  }

  // -- side-effect outbox -------------------------------------------------

  static sideEffectKey(runId: string, operation: string, target: string): string {
    return createHash("sha256").update(`${runId} ${operation} ${target}`).digest("hex").slice(0, 32);
  }

  /**
   * Record the intent to perform an external mutation.
   *
   * Called BEFORE the remote call. A crash between this row and the remote
   * response leaves a durable record naming the run and the operation, so
   * startup reconciliation can query the remote and decide whether the effect
   * landed rather than assuming it did not.
   */
  intendSideEffect(input: {
    runId: string;
    system: string;
    operation: string;
    target: string;
  }): string {
    const key = StateStore.sideEffectKey(input.runId, input.operation, input.target);
    const at = this.#clock.now().toISOString();
    this.#db
      .prepare(
        `INSERT INTO side_effects(key, run_id, system, operation, target, status, intended_at, updated_at)
         VALUES (?,?,?,?,?,'intended',?,?)
         ON CONFLICT(key) DO NOTHING`,
      )
      .run(key, input.runId, input.system, input.operation, input.target, at, at);
    return key;
  }

  #setSideEffectStatus(
    key: string,
    status: SideEffectStatus,
    patch: { remoteId?: string; lastError?: string } = {},
  ): void {
    this.#db
      .prepare(
        `UPDATE side_effects
         SET status = ?, remote_id = COALESCE(?, remote_id),
             last_error = COALESCE(?, last_error), updated_at = ?
         WHERE key = ?`,
      )
      .run(
        status,
        patch.remoteId ?? null,
        patch.lastError ?? null,
        this.#clock.now().toISOString(),
        key,
      );
  }

  markSideEffectInFlight(key: string): void {
    this.#setSideEffectStatus(key, "in_flight");
  }

  confirmSideEffect(key: string, remoteId?: string): void {
    this.#setSideEffectStatus(key, "confirmed", remoteId === undefined ? {} : { remoteId });
  }

  /** A failed effect stays pending: failure does not prove the effect did not land. */
  failSideEffect(key: string, lastError: string): void {
    this.#setSideEffectStatus(key, "failed", { lastError });
  }

  getSideEffect(key: string): SideEffectRow | undefined {
    return this.#db
      .prepare(
        `SELECT key, run_id AS runId, system, operation, target, status,
                remote_id AS remoteId, last_error AS lastError
         FROM side_effects WHERE key = ?`,
      )
      .get(key) as SideEffectRow | undefined;
  }

  /** Everything the startup recovery sweep must reconcile. */
  pendingSideEffects(): SideEffectRow[] {
    return this.#db
      .prepare(
        `SELECT key, run_id AS runId, system, operation, target, status,
                remote_id AS remoteId, last_error AS lastError
         FROM side_effects WHERE status <> 'confirmed' ORDER BY intended_at`,
      )
      .all() as SideEffectRow[];
  }

  // -- leases ------------------------------------------------------------

  recordLease(input: {
    issueId: string;
    runId: string;
    repo: string;
    generation: number;
    expiresAt: string;
    refName?: string;
    hostId?: string;
    pid?: number;
    bootId?: string;
    priorStateId?: string;
    priorAssigneeId?: string;
  }): void {
    const at = this.#clock.now().toISOString();
    this.#db
      .prepare(
        `INSERT INTO leases(issue_id, run_id, repo, generation, ref_name, acquired_at,
                            expires_at, heartbeat_at, host_id, pid, boot_id,
                            prior_state_id, prior_assignee_id, released_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      )
      .run(
        input.issueId,
        input.runId,
        input.repo,
        input.generation,
        input.refName ?? null,
        at,
        input.expiresAt,
        at,
        input.hostId ?? null,
        input.pid ?? null,
        input.bootId ?? null,
        input.priorStateId ?? null,
        input.priorAssigneeId ?? null,
      );
  }

  getLease(issueId: string): LeaseRow | undefined {
    return this.#db
      .prepare(
        `SELECT issue_id AS issueId, run_id AS runId, repo, generation,
                expires_at AS expiresAt, heartbeat_at AS heartbeatAt, released_at AS releasedAt
         FROM leases WHERE issue_id = ? AND released_at IS NULL`,
      )
      .get(issueId) as LeaseRow | undefined;
  }

  heartbeatLease(issueId: string, runId: string, newExpiresAt: string): void {
    this.#db
      .prepare(
        `UPDATE leases SET heartbeat_at = ?, expires_at = ?
         WHERE issue_id = ? AND run_id = ? AND released_at IS NULL`,
      )
      .run(this.#clock.now().toISOString(), newExpiresAt, issueId, runId);
  }

  releaseLease(issueId: string, runId: string): void {
    this.#db
      .prepare(
        "UPDATE leases SET released_at = ? WHERE issue_id = ? AND run_id = ? AND released_at IS NULL",
      )
      .run(this.#clock.now().toISOString(), issueId, runId);
  }

  // -- onboarding funnel (local only, never transmitted) -----------------

  /** First write wins: a milestone records when something first happened. */
  recordFunnelOnce(key: string, value: string): void {
    this.#db
      .prepare("INSERT INTO onboarding_funnel(key, value) VALUES (?,?) ON CONFLICT(key) DO NOTHING")
      .run(key, value);
  }

  incrementFunnelCounter(key: string): void {
    this.#db
      .prepare(
        `INSERT INTO onboarding_funnel(key, value) VALUES (?, '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
      )
      .run(key);
  }

  readFunnel(): Record<string, string> {
    const rows = this.#db
      .prepare("SELECT key, value FROM onboarding_funnel")
      .all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /**
   * How many runs this issue has already had.
   *
   * The branch template is validated to contain {attempt} so that a retry does
   * not reuse a branch, which only works if something actually counts. Derived
   * from the runs table rather than tracked separately, so it stays true across
   * restarts and cannot drift from the runs it describes.
   */
  attemptsFor(issueId: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE issue_id = ?")
      .get(issueId) as { n: number };
    return row.n;
  }

  activeLeaseIssueIds(): Set<string> {
    const rows = this.#db
      .prepare("SELECT issue_id AS issueId FROM leases WHERE released_at IS NULL")
      .all() as { issueId: string }[];
    return new Set(rows.map((r) => r.issueId));
  }
}
