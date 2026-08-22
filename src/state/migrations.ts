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
  {
    version: 2,
    name: "asf_work_order_admission",
    up: `
      ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'standalone'
        CHECK (mode IN ('standalone', 'asf-worker', 'development'));
      ALTER TABLE runs ADD COLUMN work_order_id TEXT;
      ALTER TABLE runs ADD COLUMN attempt_id TEXT;
      ALTER TABLE runs ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE runs ADD COLUMN owner_id TEXT;
      ALTER TABLE runs ADD COLUMN heartbeat_at TEXT;

      ALTER TABLE events ADD COLUMN event_id TEXT;
      ALTER TABLE events ADD COLUMN schema TEXT;
      ALTER TABLE events ADD COLUMN phase TEXT;
      ALTER TABLE events ADD COLUMN policy_digest TEXT;

      CREATE INDEX idx_runs_mode_state ON runs(mode, state);
      CREATE UNIQUE INDEX idx_runs_work_order_attempt
        ON runs(work_order_id, attempt_id)
        WHERE work_order_id IS NOT NULL AND attempt_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_events_event_id ON events(event_id) WHERE event_id IS NOT NULL;

      -- The immutable admission record is separate from the mutable run row.
      -- Idempotency compares the canonical PAYLOAD digest: envelope timestamps
      -- or signatures may change, but one key can never name different work.
      CREATE TABLE asf_work_order_admissions (
        idempotency_key      TEXT PRIMARY KEY,
        payload_digest       TEXT NOT NULL,
        envelope_digest      TEXT NOT NULL,
        canonical_envelope   TEXT NOT NULL,
        work_order_id        TEXT NOT NULL,
        attempt_id           TEXT NOT NULL,
        tenant_id            TEXT NOT NULL,
        run_id               TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE RESTRICT,
        effective_policy     TEXT NOT NULL,
        effective_policy_digest TEXT NOT NULL,
        signature_key_id     TEXT NOT NULL,
        signature_algorithm  TEXT NOT NULL,
        accepted_at          TEXT NOT NULL,
        compacted_through     INTEGER NOT NULL DEFAULT 0,
        UNIQUE(work_order_id, attempt_id)
      );
      CREATE INDEX idx_asf_admissions_tenant_work
        ON asf_work_order_admissions(tenant_id, work_order_id);

      -- Durable current gate results survive detailed event compaction and are
      -- keyed by the exact candidate so stale success can never authorize a
      -- replacement commit.
      CREATE TABLE asf_gate_results (
        run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
        candidate_sha   TEXT NOT NULL,
        gate_kind       TEXT NOT NULL CHECK (
          gate_kind IN ('local-check', 'remote-check', 'local-review', 'pr-review')
        ),
        gate_id         TEXT NOT NULL,
        outcome         TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        event_seq       INTEGER NOT NULL,
        PRIMARY KEY (run_id, candidate_sha, gate_kind, gate_id)
      );
      CREATE INDEX idx_asf_gate_candidate
        ON asf_gate_results(run_id, candidate_sha, gate_kind);
    `,
  },
  {
    version: 3,
    name: "asf_control_reconciliation_and_evidence",
    up: `
      -- Interruptions remember the exact checkpoint they may return to. A
      -- cancellation or ownership fence can then change the visible phase
      -- without losing the recovery target.
      ALTER TABLE runs ADD COLUMN resume_phase TEXT;
      ALTER TABLE runs ADD COLUMN requires_reconciliation INTEGER NOT NULL DEFAULT 0
        CHECK (requires_reconciliation IN (0, 1));

      CREATE TABLE asf_approvals (
        approval_id         TEXT PRIMARY KEY,
        run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
        work_order_id       TEXT NOT NULL,
        attempt_id          TEXT NOT NULL,
        work_order_digest   TEXT NOT NULL,
        candidate_sha       TEXT NOT NULL,
        decision            TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
        decision_type       TEXT NOT NULL,
        requested_effect    TEXT NOT NULL,
        policy_digest       TEXT NOT NULL,
        approver_subject    TEXT NOT NULL,
        approver_authority  TEXT NOT NULL,
        issued_at           TEXT NOT NULL,
        expires_at          TEXT NOT NULL,
        signature_key_id    TEXT NOT NULL,
        signature_algorithm TEXT NOT NULL,
        canonical_envelope  TEXT NOT NULL,
        envelope_digest     TEXT NOT NULL UNIQUE,
        binding_digest      TEXT NOT NULL,
        recorded_at         TEXT NOT NULL
      );
      CREATE INDEX idx_asf_approvals_binding
        ON asf_approvals(run_id, candidate_sha, policy_digest, decision_type, requested_effect);

      CREATE TABLE asf_cancellation_requests (
        request_id       TEXT PRIMARY KEY,
        run_id           TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
        request_digest   TEXT NOT NULL,
        requester        TEXT NOT NULL,
        requester_authority TEXT NOT NULL,
        reason           TEXT NOT NULL,
        mode             TEXT NOT NULL CHECK (mode IN ('graceful', 'forced')),
        grace_seconds    INTEGER NOT NULL CHECK (grace_seconds >= 0),
        requested_at     TEXT NOT NULL,
        recorded_at      TEXT NOT NULL
      );
      CREATE INDEX idx_asf_cancel_run ON asf_cancellation_requests(run_id, recorded_at);

      -- ASF effects do not use the legacy manual-only outbox. Every row binds
      -- one deterministic mutation to its candidate, policy and remote marker.
      CREATE TABLE asf_effects (
        effect_key          TEXT PRIMARY KEY,
        run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
        generation          INTEGER NOT NULL,
        system              TEXT NOT NULL CHECK (system = 'github'),
        operation           TEXT NOT NULL,
        target              TEXT NOT NULL,
        correlation_marker  TEXT NOT NULL,
        candidate_sha       TEXT NOT NULL,
        expected_remote_sha TEXT,
        policy_digest       TEXT NOT NULL,
        intent_digest       TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (
          status IN ('intended', 'in_flight', 'confirmed', 'not_applied', 'ambiguous')
        ),
        remote_id           TEXT,
        observation_digest  TEXT,
        retry_prohibited    INTEGER NOT NULL DEFAULT 0 CHECK (retry_prohibited IN (0, 1)),
        intended_at         TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE(run_id, operation, target, candidate_sha)
      );
      CREATE INDEX idx_asf_effects_pending
        ON asf_effects(status, updated_at)
        WHERE status IN ('intended', 'in_flight', 'ambiguous');

      CREATE TABLE asf_effect_observations (
        effect_key       TEXT NOT NULL REFERENCES asf_effects(effect_key) ON DELETE RESTRICT,
        seq              INTEGER NOT NULL,
        outcome          TEXT NOT NULL CHECK (outcome IN ('confirmed', 'not_applied', 'ambiguous')),
        candidate_sha    TEXT NOT NULL,
        details_digest   TEXT NOT NULL,
        observer         TEXT NOT NULL,
        observed_at      TEXT NOT NULL,
        PRIMARY KEY (effect_key, seq)
      );

      -- Controller-triggered reconciliation is itself durable and
      -- idempotent. It observes recorded effects asynchronously; it never
      -- authorizes a blind retry or an arbitrary remote operation.
      CREATE TABLE asf_reconciliation_requests (
        operation_id       TEXT PRIMARY KEY,
        run_id             TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
        request_digest     TEXT NOT NULL UNIQUE,
        requested_by       TEXT NOT NULL,
        requested_authority TEXT NOT NULL,
        scope              TEXT NOT NULL CHECK (scope = 'pending-effects'),
        status             TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'completed', 'blocked')
        ),
        generation         INTEGER,
        owner_id           TEXT,
        requested_at       TEXT NOT NULL,
        started_at         TEXT,
        completed_at       TEXT,
        result_digest      TEXT
      );
      CREATE UNIQUE INDEX idx_asf_reconcile_active_run
        ON asf_reconciliation_requests(run_id)
        WHERE status IN ('queued', 'running');
      CREATE INDEX idx_asf_reconcile_recovery
        ON asf_reconciliation_requests(status, requested_at)
        WHERE status IN ('queued', 'running');

      CREATE TABLE asf_checkpoints (
        checkpoint_id       TEXT PRIMARY KEY,
        run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
        checkpoint_kind     TEXT NOT NULL,
        phase               TEXT NOT NULL,
        event_seq           INTEGER NOT NULL,
        fencing_generation  INTEGER NOT NULL,
        candidate_sha       TEXT,
        policy_digest       TEXT NOT NULL,
        checkpoint_digest   TEXT NOT NULL UNIQUE,
        replay_policy       TEXT NOT NULL CHECK (
          replay_policy IN ('replayable', 'reconcile-first', 'fresh-context', 'not-replayable')
        ),
        canonical_checkpoint TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        recorded_at         TEXT NOT NULL,
        UNIQUE(run_id, checkpoint_kind, event_seq)
      );
      CREATE INDEX idx_asf_checkpoints_run_sequence
        ON asf_checkpoints(run_id, event_seq DESC, checkpoint_id);

      CREATE TABLE asf_evidence_bundles (
        run_id              TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE RESTRICT,
        candidate_sha       TEXT NOT NULL,
        policy_digest       TEXT NOT NULL,
        bundle_digest       TEXT NOT NULL UNIQUE,
        canonical_envelope  TEXT NOT NULL,
        finalized_at        TEXT NOT NULL
      );

      CREATE TABLE asf_outcome_acknowledgements (
        acknowledgement_id TEXT PRIMARY KEY,
        run_id               TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE RESTRICT,
        bundle_digest        TEXT NOT NULL,
        acknowledged_by      TEXT NOT NULL,
        acknowledged_at      TEXT NOT NULL,
        request_digest       TEXT NOT NULL UNIQUE
      );
    `,
  },
  {
    version: 4,
    name: "asf_delivery_stage_intents",
    up: `
      -- Generic lifecycle effects use the same write-ahead rule as the
      -- forge-specific outbox: the exact, fenced intent commits before an
      -- adapter may touch an external system. The first generation remains
      -- authoritative across takeovers so a replacement worker can only
      -- reconcile it; it cannot silently replace the intent and retry.
      CREATE TABLE asf_delivery_stage_intents (
        effect_key          TEXT PRIMARY KEY,
        intent_id           TEXT NOT NULL UNIQUE,
        intent_digest       TEXT NOT NULL UNIQUE,
        schema              TEXT NOT NULL CHECK (schema = 'asf.delivery-stage-intent/v1'),
        stage               TEXT NOT NULL CHECK (stage IN (
          'repository-lease', 'identity-leases', 'workspace', 'task-packet',
          'implementer-session', 'candidate', 'local-verification', 'local-review',
          'candidate-invalidation', 'branch-push', 'pull-request', 'ci',
          'pull-request-review', 'evidence', 'cleanup'
        )),
        run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
        work_order_id       TEXT NOT NULL,
        attempt_id          TEXT NOT NULL,
        policy_digest       TEXT NOT NULL,
        fencing_generation  INTEGER NOT NULL CHECK (fencing_generation > 0),
        candidate_sha       TEXT,
        event_seq           INTEGER NOT NULL CHECK (event_seq > 0),
        operation_digest    TEXT NOT NULL,
        canonical_intent    TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        observation_digest  TEXT,
        confirmed_generation INTEGER,
        confirmed_at        TEXT,
        CHECK (
          (observation_digest IS NULL AND confirmed_generation IS NULL AND confirmed_at IS NULL)
          OR
          (observation_digest IS NOT NULL AND confirmed_generation IS NOT NULL
            AND confirmed_generation > 0 AND confirmed_at IS NOT NULL)
        )
      );
      CREATE INDEX idx_asf_delivery_intents_pending
        ON asf_delivery_stage_intents(run_id, event_seq, effect_key)
        WHERE observation_digest IS NULL;
    `,
  },
  {
    version: 5,
    name: "asf_provider_budget_reservations",
    up: `
      -- Every possible provider invocation receives one durable reservation
      -- after its lifecycle effect intent and before provider authority is
      -- exercised. Reserved (unknown) usage remains charged at its full cap
      -- across crashes and ownership takeovers.
      CREATE TABLE asf_provider_budget_reservations (
        reservation_id       TEXT PRIMARY KEY,
        reservation_digest   TEXT NOT NULL UNIQUE,
        effect_key           TEXT NOT NULL UNIQUE
          REFERENCES asf_delivery_stage_intents(effect_key) ON DELETE RESTRICT,
        intent_id            TEXT NOT NULL UNIQUE,
        intent_digest        TEXT NOT NULL,
        run_id               TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
        work_order_id        TEXT NOT NULL,
        attempt_id           TEXT NOT NULL,
        policy_digest        TEXT NOT NULL,
        initial_generation   INTEGER NOT NULL CHECK (initial_generation > 0),
        completed_generation INTEGER CHECK (
          completed_generation IS NULL OR completed_generation > 0
        ),
        lifecycle_candidate_sha TEXT,
        provider_candidate_sha  TEXT NOT NULL,
        role                  TEXT NOT NULL CHECK (
          role IN ('implementer', 'fixer', 'local-reviewer', 'pr-reviewer')
        ),
        invocation_id        TEXT NOT NULL,
        reserved_cost_micros INTEGER NOT NULL CHECK (reserved_cost_micros >= 0),
        actual_cost_micros   INTEGER CHECK (
          actual_cost_micros IS NULL OR actual_cost_micros >= 0
        ),
        max_cost_micros      INTEGER NOT NULL CHECK (max_cost_micros >= 0),
        max_agent_invocations INTEGER NOT NULL CHECK (max_agent_invocations > 0),
        accepted_at          TEXT NOT NULL,
        deadline_at          TEXT NOT NULL,
        status               TEXT NOT NULL CHECK (
          status IN ('reserved', 'completed', 'denied')
        ),
        denial_reason        TEXT CHECK (
          denial_reason IS NULL OR
          denial_reason IN ('wall-deadline', 'cost-limit', 'invocation-limit')
        ),
        denial_observation_digest TEXT,
        provider_result_digest TEXT,
        provider              TEXT,
        model                 TEXT,
        principal             TEXT,
        profile               TEXT,
        created_at            TEXT NOT NULL,
        completed_at          TEXT,
        UNIQUE(run_id, invocation_id),
        CHECK (
          (status = 'reserved' AND actual_cost_micros IS NULL
            AND completed_generation IS NULL AND denial_reason IS NULL
            AND denial_observation_digest IS NULL AND provider_result_digest IS NULL
            AND provider IS NULL AND model IS NULL AND principal IS NULL AND profile IS NULL
            AND completed_at IS NULL)
          OR
          (status = 'completed' AND actual_cost_micros IS NOT NULL
            AND completed_generation IS NOT NULL AND denial_reason IS NULL
            AND denial_observation_digest IS NULL AND provider_result_digest IS NOT NULL
            AND provider IS NOT NULL AND model IS NOT NULL
            AND principal IS NOT NULL AND profile IS NOT NULL
            AND completed_at IS NOT NULL)
          OR
          (status = 'denied' AND reserved_cost_micros = 0
            AND actual_cost_micros IS NULL AND completed_generation IS NULL
            AND denial_reason IS NOT NULL AND denial_observation_digest IS NOT NULL
            AND provider_result_digest IS NULL AND provider IS NULL AND model IS NULL
            AND principal IS NULL AND profile IS NULL AND completed_at IS NOT NULL)
        )
      );
      CREATE INDEX idx_asf_provider_budget_run
        ON asf_provider_budget_reservations(run_id, status, created_at, reservation_id);
    `,
  },
  {
    version: 6,
    name: "asf_exact_reconciliation_continuations",
    up: `
      -- A generic delivery confirmation previously implied "confirmed" but
      -- did not persist that outcome explicitly. Reconciliation continuation
      -- must be able to distinguish confirmed from not-applied without
      -- trusting an observer's summary.
      ALTER TABLE asf_delivery_stage_intents
        ADD COLUMN observation_outcome TEXT CHECK (
          observation_outcome IS NULL OR
          observation_outcome IN ('confirmed', 'not_applied', 'ambiguous')
        );
      UPDATE asf_delivery_stage_intents
        SET observation_outcome = 'confirmed'
        WHERE observation_digest IS NOT NULL;

      -- Persist both sides of a reconciliation decision. Legacy rows remain
      -- digest-only and are intentionally ineligible for automatic resume.
      ALTER TABLE asf_reconciliation_requests ADD COLUMN pending_set_digest TEXT;
      ALTER TABLE asf_reconciliation_requests ADD COLUMN pending_github_effects INTEGER;
      ALTER TABLE asf_reconciliation_requests ADD COLUMN pending_delivery_intents INTEGER;
      ALTER TABLE asf_reconciliation_requests ADD COLUMN canonical_pending_set TEXT;
      ALTER TABLE asf_reconciliation_requests ADD COLUMN canonical_result TEXT;
      ALTER TABLE asf_reconciliation_requests ADD COLUMN resumed_event_seq INTEGER;
    `,
  },
  {
    version: 7,
    name: "asf_delivery_intent_replay_authority",
    up: `
      -- Keep every generic lifecycle observation after a deterministic
      -- not-applied decision is consumed as one replay authorization. The
      -- current intent row may return to pending, but audit history is never
      -- overwritten.
      CREATE TABLE asf_delivery_intent_observations (
        effect_key          TEXT NOT NULL REFERENCES asf_delivery_stage_intents(effect_key)
                            ON DELETE RESTRICT,
        seq                 INTEGER NOT NULL CHECK (seq > 0),
        outcome             TEXT NOT NULL CHECK (outcome IN (
                              'confirmed', 'not_applied', 'ambiguous'
                            )),
        observation_digest  TEXT NOT NULL,
        generation          INTEGER NOT NULL CHECK (generation > 0),
        source              TEXT NOT NULL CHECK (source IN (
                              'confirmation', 'reconciliation', 'legacy'
                            )),
        observed_at         TEXT NOT NULL,
        PRIMARY KEY(effect_key, seq)
      );
      INSERT INTO asf_delivery_intent_observations(
        effect_key, seq, outcome, observation_digest, generation, source, observed_at
      )
      SELECT effect_key, 1, observation_outcome, observation_digest,
             confirmed_generation, 'legacy', confirmed_at
      FROM asf_delivery_stage_intents
      WHERE observation_outcome IS NOT NULL
        AND observation_digest IS NOT NULL
        AND confirmed_generation IS NOT NULL
        AND confirmed_at IS NOT NULL;

      ALTER TABLE asf_delivery_stage_intents
        ADD COLUMN replay_authorized_operation_id TEXT
          REFERENCES asf_reconciliation_requests(operation_id) ON DELETE RESTRICT;
      ALTER TABLE asf_delivery_stage_intents
        ADD COLUMN replay_started_generation INTEGER CHECK (
          replay_started_generation IS NULL OR replay_started_generation > 0
        );
      CREATE INDEX idx_asf_delivery_intent_observations
        ON asf_delivery_intent_observations(effect_key, seq);
    `,
  },
  {
    version: 8,
    name: "persistent_circuit_breaker_state",
    up: `
      -- The table has existed since v1, but its rows were never defined or
      -- consumed. Seed the complete canonical non-daily snapshot so a v8
      -- process can distinguish a new database from deleted durable state.
      -- Existing rows are not overwritten: legacy, unknown, or contradictory
      -- state must be inspected and refused by StateStore rather than reset.
      INSERT OR IGNORE INTO circuit_breakers(name, state, opened_at, reason) VALUES
        ('consecutive-failures',
         '{"count":0,"schema":"runmill.circuit-breaker-counter/v1"}', NULL, NULL),
        ('quarantine',
         '{"count":0,"schema":"runmill.circuit-breaker-counter/v1"}', NULL, NULL),
        ('escalation-rate',
         '{"completed":0,"escalations":0,"schema":"runmill.circuit-breaker-rate/v1"}',
         NULL, NULL);
    `,
  },
  {
    version: 9,
    name: "asf_terminal_evidence",
    up: `
      -- v5 deliberately kept an unknown crash-window provider invocation in
      -- reserved forever. Reconciliation can now close that window without
      -- pretending a provider returned a result: the full reservation is
      -- charged as a distinct, tamper-evident unknown-cost settlement.
      ALTER TABLE asf_provider_budget_reservations
        RENAME TO asf_provider_budget_reservations_v8;
      CREATE TABLE asf_provider_budget_reservations (
        reservation_id       TEXT PRIMARY KEY,
        reservation_digest   TEXT NOT NULL UNIQUE,
        effect_key           TEXT NOT NULL UNIQUE
          REFERENCES asf_delivery_stage_intents(effect_key) ON DELETE RESTRICT,
        intent_id            TEXT NOT NULL UNIQUE,
        intent_digest        TEXT NOT NULL,
        run_id               TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
        work_order_id        TEXT NOT NULL,
        attempt_id           TEXT NOT NULL,
        policy_digest        TEXT NOT NULL,
        initial_generation   INTEGER NOT NULL CHECK (initial_generation > 0),
        completed_generation INTEGER CHECK (
          completed_generation IS NULL OR completed_generation > 0
        ),
        lifecycle_candidate_sha TEXT,
        provider_candidate_sha  TEXT NOT NULL,
        role                  TEXT NOT NULL CHECK (
          role IN ('implementer', 'fixer', 'local-reviewer', 'pr-reviewer')
        ),
        invocation_id        TEXT NOT NULL,
        reserved_cost_micros INTEGER NOT NULL CHECK (reserved_cost_micros >= 0),
        actual_cost_micros   INTEGER CHECK (
          actual_cost_micros IS NULL OR actual_cost_micros >= 0
        ),
        max_cost_micros      INTEGER NOT NULL CHECK (max_cost_micros >= 0),
        max_agent_invocations INTEGER NOT NULL CHECK (max_agent_invocations > 0),
        accepted_at          TEXT NOT NULL,
        deadline_at          TEXT NOT NULL,
        status               TEXT NOT NULL CHECK (
          status IN ('reserved', 'completed', 'denied', 'settled_unknown')
        ),
        denial_reason        TEXT CHECK (
          denial_reason IS NULL OR
          denial_reason IN ('wall-deadline', 'cost-limit', 'invocation-limit')
        ),
        denial_observation_digest TEXT,
        provider_result_digest TEXT,
        provider              TEXT,
        model                 TEXT,
        principal             TEXT,
        profile               TEXT,
        settlement_outcome    TEXT CHECK (
          settlement_outcome IS NULL OR settlement_outcome IN ('confirmed', 'not_applied')
        ),
        settlement_observation_digest TEXT,
        settlement_digest     TEXT UNIQUE,
        settlement_generation INTEGER CHECK (
          settlement_generation IS NULL OR settlement_generation > 0
        ),
        settlement_at         TEXT,
        created_at            TEXT NOT NULL,
        completed_at          TEXT,
        UNIQUE(run_id, invocation_id),
        CHECK (
          (status = 'reserved' AND actual_cost_micros IS NULL
            AND completed_generation IS NULL AND denial_reason IS NULL
            AND denial_observation_digest IS NULL AND provider_result_digest IS NULL
            AND provider IS NULL AND model IS NULL AND principal IS NULL AND profile IS NULL
            AND settlement_outcome IS NULL AND settlement_observation_digest IS NULL
            AND settlement_digest IS NULL AND settlement_generation IS NULL
            AND settlement_at IS NULL AND completed_at IS NULL)
          OR
          (status = 'completed' AND actual_cost_micros IS NOT NULL
            AND completed_generation IS NOT NULL AND denial_reason IS NULL
            AND denial_observation_digest IS NULL AND provider_result_digest IS NOT NULL
            AND provider IS NOT NULL AND model IS NOT NULL
            AND principal IS NOT NULL AND profile IS NOT NULL
            AND settlement_outcome IS NULL AND settlement_observation_digest IS NULL
            AND settlement_digest IS NULL AND settlement_generation IS NULL
            AND settlement_at IS NULL AND completed_at IS NOT NULL)
          OR
          (status = 'denied' AND reserved_cost_micros = 0
            AND actual_cost_micros IS NULL AND completed_generation IS NULL
            AND denial_reason IS NOT NULL AND denial_observation_digest IS NOT NULL
            AND provider_result_digest IS NULL AND provider IS NULL AND model IS NULL
            AND principal IS NULL AND profile IS NULL
            AND settlement_outcome IS NULL AND settlement_observation_digest IS NULL
            AND settlement_digest IS NULL AND settlement_generation IS NULL
            AND settlement_at IS NULL AND completed_at IS NOT NULL)
          OR
          (status = 'settled_unknown' AND reserved_cost_micros > 0
            AND actual_cost_micros = reserved_cost_micros
            AND completed_generation IS NOT NULL AND denial_reason IS NULL
            AND denial_observation_digest IS NULL AND provider_result_digest IS NULL
            AND provider IS NULL AND model IS NULL AND principal IS NULL AND profile IS NULL
            AND settlement_outcome IS NOT NULL
            AND settlement_observation_digest IS NOT NULL
            AND settlement_digest IS NOT NULL AND settlement_generation IS NOT NULL
            AND settlement_generation = completed_generation
            AND settlement_at IS NOT NULL AND completed_at = settlement_at)
        )
      );
      INSERT INTO asf_provider_budget_reservations(
        reservation_id, reservation_digest, effect_key, intent_id, intent_digest,
        run_id, work_order_id, attempt_id, policy_digest, initial_generation,
        completed_generation, lifecycle_candidate_sha, provider_candidate_sha,
        role, invocation_id, reserved_cost_micros, actual_cost_micros,
        max_cost_micros, max_agent_invocations, accepted_at, deadline_at,
        status, denial_reason, denial_observation_digest, provider_result_digest,
        provider, model, principal, profile, settlement_outcome,
        settlement_observation_digest, settlement_digest, settlement_generation,
        settlement_at, created_at, completed_at
      )
      SELECT reservation_id, reservation_digest, effect_key, intent_id, intent_digest,
             run_id, work_order_id, attempt_id, policy_digest, initial_generation,
             completed_generation, lifecycle_candidate_sha, provider_candidate_sha,
             role, invocation_id, reserved_cost_micros, actual_cost_micros,
             max_cost_micros, max_agent_invocations, accepted_at, deadline_at,
             status, denial_reason, denial_observation_digest, provider_result_digest,
             provider, model, principal, profile, NULL, NULL, NULL, NULL, NULL,
             created_at, completed_at
      FROM asf_provider_budget_reservations_v8;
      DROP TABLE asf_provider_budget_reservations_v8;
      CREATE INDEX idx_asf_provider_budget_run
        ON asf_provider_budget_reservations(run_id, status, created_at, reservation_id);

      -- Delivery evidence proves an exact PR candidate. Terminal evidence is
      -- deliberately separate: stopped attempts may never have a candidate,
      -- and successful attempts need a post-cleanup statement chained to the
      -- already-immutable delivery bundle.
      CREATE TABLE asf_terminal_evidence_intents (
        run_id              TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE RESTRICT,
        terminal_phase      TEXT NOT NULL CHECK (terminal_phase IN (
                              'COMPLETED', 'CANCELLED', 'FAILED', 'REFUSED',
                              'QUARANTINED', 'BUDGET_EXHAUSTED'
                            )),
        terminal_event_seq  INTEGER NOT NULL CHECK (terminal_event_seq > 0),
        candidate_sha       TEXT,
        policy_digest       TEXT NOT NULL,
        cleanup_intent_id   TEXT NOT NULL,
        cleanup_intent_digest TEXT NOT NULL,
        cleanup_digest      TEXT,
        delivery_bundle_digest TEXT,
        plan_digest         TEXT NOT NULL UNIQUE,
        canonical_plan      TEXT NOT NULL,
        intent_digest       TEXT UNIQUE,
        canonical_intent    TEXT,
        created_at          TEXT NOT NULL,
        sealed_at           TEXT,
        CHECK (
          (cleanup_digest IS NULL AND intent_digest IS NULL AND
           canonical_intent IS NULL AND sealed_at IS NULL) OR
          (cleanup_digest IS NOT NULL AND intent_digest IS NOT NULL AND
           canonical_intent IS NOT NULL AND sealed_at IS NOT NULL)
        )
      );
      CREATE TABLE asf_terminal_evidence_bundles (
        run_id              TEXT PRIMARY KEY REFERENCES asf_terminal_evidence_intents(run_id)
                            ON DELETE RESTRICT,
        terminal_phase      TEXT NOT NULL CHECK (terminal_phase IN (
                              'COMPLETED', 'CANCELLED', 'FAILED', 'REFUSED',
                              'QUARANTINED', 'BUDGET_EXHAUSTED'
                            )),
        terminal_event_seq  INTEGER NOT NULL CHECK (terminal_event_seq > 0),
        candidate_sha       TEXT,
        policy_digest       TEXT NOT NULL,
        cleanup_intent_id   TEXT NOT NULL,
        cleanup_intent_digest TEXT NOT NULL,
        cleanup_digest      TEXT NOT NULL,
        delivery_bundle_digest TEXT,
        bundle_digest       TEXT NOT NULL UNIQUE,
        canonical_envelope  TEXT NOT NULL,
        finalized_at        TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_asf_terminal_evidence_run_sequence
        ON asf_terminal_evidence_bundles(run_id, terminal_event_seq);
    `,
  },
  {
    version: 10,
    name: "asf_signed_envelope_integrity",
    up: `
      -- bundle_digest binds the unsigned statement and is part of the public
      -- protocol. Keep that contract stable while separately binding every
      -- byte of the canonical signed envelope at rest, including signature.
      -- Existing rows are backfilled by StateStore inside this migration's
      -- IMMEDIATE transaction after their canonical form and schema validate.
      ALTER TABLE asf_evidence_bundles
        ADD COLUMN canonical_envelope_digest TEXT;
      ALTER TABLE asf_terminal_evidence_bundles
        ADD COLUMN canonical_envelope_digest TEXT;
    `,
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, m) => (m.version > max ? m.version : max),
  0,
);
