/**
 * Forward-only schema migrations.
 *
 * `PRAGMA user_version` is authoritative. Migrations run inside a transaction
 * behind a cross-process lock, the database is backed up first, and a binary
 * refuses to open a database whose version exceeds what it understands.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    up: `
      CREATE TABLE schema_migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT    NOT NULL,
        applied_at  TEXT    NOT NULL
      );

      CREATE TABLE runs (
        run_id        TEXT PRIMARY KEY,
        issue_id      TEXT NOT NULL,
        repo          TEXT NOT NULL,
        provider      TEXT NOT NULL,
        state         TEXT NOT NULL,
        state_version INTEGER NOT NULL DEFAULT 1,
        attempt       INTEGER NOT NULL DEFAULT 1,
        base_commit   TEXT,
        candidate_sha TEXT,
        branch        TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_runs_issue ON runs(issue_id);
      CREATE INDEX idx_runs_state ON runs(state);

      CREATE TABLE state_transitions (
        run_id   TEXT    NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        seq      INTEGER NOT NULL,
        from_state TEXT  NOT NULL,
        to_state   TEXT  NOT NULL,
        reason   TEXT,
        actor    TEXT    NOT NULL,
        at       TEXT    NOT NULL,
        PRIMARY KEY (run_id, seq)
      );

      -- Only one ACTIVE lease per issue. Released leases keep their row for
      -- audit, so uniqueness is enforced on a partial index rather than the
      -- column, letting history accumulate without blocking a re-claim.
      CREATE TABLE leases (
        issue_id          TEXT NOT NULL,
        run_id            TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        repo              TEXT NOT NULL,
        generation        INTEGER NOT NULL,
        ref_name          TEXT,
        acquired_at       TEXT NOT NULL,
        expires_at        TEXT NOT NULL,
        heartbeat_at      TEXT,
        host_id           TEXT,
        pid               INTEGER,
        boot_id           TEXT,
        prior_state_id    TEXT,
        prior_assignee_id TEXT,
        released_at       TEXT
      );
      CREATE UNIQUE INDEX idx_leases_active ON leases(issue_id) WHERE released_at IS NULL;
      CREATE INDEX idx_leases_run ON leases(run_id);

      CREATE TABLE events (
        run_id     TEXT    NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        type       TEXT    NOT NULL,
        payload    TEXT    NOT NULL,
        artifact_ref TEXT,
        redaction_ruleset_version TEXT,
        at         TEXT    NOT NULL,
        PRIMARY KEY (run_id, seq)
      );

      -- Outbox, not a log: intent is recorded BEFORE the remote call so a
      -- crash in the window leaves a durable record to reconcile against.
      CREATE TABLE side_effects (
        key          TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        system       TEXT NOT NULL,
        operation    TEXT NOT NULL,
        target       TEXT NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('intended','in_flight','confirmed','failed')),
        remote_id    TEXT,
        last_error   TEXT,
        intended_at  TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX idx_side_effects_pending ON side_effects(status) WHERE status <> 'confirmed';

      CREATE TABLE checks (
        run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        check_id      TEXT NOT NULL,
        candidate_sha TEXT NOT NULL,
        env           TEXT NOT NULL DEFAULT '',
        attempt       INTEGER NOT NULL DEFAULT 1,
        origin        TEXT NOT NULL DEFAULT 'local',
        executor      TEXT NOT NULL DEFAULT 'orchestrator',
        command       TEXT,
        tree_hash_before TEXT,
        tree_hash_after  TEXT,
        outcome       TEXT,
        exit_code     INTEGER,
        exit_signal   TEXT,
        status        TEXT,
        coverage      TEXT,
        report_path   TEXT,
        started_at    TEXT,
        completed_at  TEXT,
        PRIMARY KEY (run_id, candidate_sha, check_id, env, attempt)
      );

      CREATE TABLE findings (
        run_id     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        review_id  TEXT NOT NULL,
        iteration  INTEGER NOT NULL,
        finding_id TEXT NOT NULL,
        severity   TEXT NOT NULL,
        category   TEXT,
        evidence   TEXT,
        status     TEXT NOT NULL,
        resolution TEXT,
        PRIMARY KEY (run_id, review_id, finding_id)
      );

      CREATE TABLE pull_requests (
        run_id     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        repo       TEXT NOT NULL,
        number     INTEGER,
        head_sha   TEXT,
        base_sha   TEXT,
        merge_sha  TEXT,
        draft      INTEGER NOT NULL DEFAULT 1,
        url        TEXT,
        PRIMARY KEY (run_id)
      );

      CREATE TABLE worktrees (
        path    TEXT PRIMARY KEY,
        run_id  TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        branch  TEXT NOT NULL,
        status  TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE budget_ledger (
        day_bucket  TEXT NOT NULL,
        repo        TEXT NOT NULL,
        cost_usd    REAL NOT NULL DEFAULT 0,
        invocations INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day_bucket, repo)
      );

      CREATE TABLE circuit_breakers (
        name      TEXT PRIMARY KEY,
        state     TEXT NOT NULL,
        opened_at TEXT,
        reason    TEXT
      );

      CREATE TABLE issue_snapshots (
        issue_id      TEXT NOT NULL,
        run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        snapshot_hash TEXT NOT NULL,
        body          TEXT NOT NULL,
        captured_at   TEXT NOT NULL,
        PRIMARY KEY (issue_id, run_id)
      );

      CREATE TABLE policy_decisions (
        run_id      TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        inputs      TEXT NOT NULL,
        matched     TEXT NOT NULL,
        outcome     TEXT NOT NULL,
        explanation TEXT NOT NULL,
        identity    TEXT,
        at          TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );

      CREATE TABLE harness_versions (
        id              TEXT PRIMARY KEY,
        config_hash     TEXT NOT NULL,
        skill_hashes    TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        policy_version  TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );

      CREATE TABLE onboarding_funnel (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, m) => (m.version > max ? m.version : max),
  0,
);
