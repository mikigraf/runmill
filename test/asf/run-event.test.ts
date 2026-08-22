import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_PHASES,
  TERMINAL_RUN_EVENT_PHASES,
  isTerminalRunEventPhase,
  parseRunEvent,
  runEventSchema,
  type RunEvent,
} from "../../src/asf/run-event.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function event(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    schema: "asf.run-event/v1",
    event_id: "evt_01J",
    run_id: "run_01J",
    work_order_id: "wo_01J",
    attempt_id: "attempt_01",
    seq: 42,
    occurred_at: "2026-08-21T10:20:00Z",
    type: "verification.completed",
    phase: "LOCAL_VERIFY",
    payload: {
      candidate_sha: "b".repeat(40),
      check_id: "unit",
      outcome: "passed",
      evidence_digest: DIGEST,
    },
    policy_digest: DIGEST,
    ...overrides,
  };
}

describe("ASF run-event lifecycle phases", () => {
  it("contains exactly the normal, interrupting, and cancellation phases from the PRD", () => {
    expect(RUN_EVENT_PHASES).toEqual([
      "RECEIVED",
      "ADMITTED",
      "REPOSITORY_LEASED",
      "IDENTITY_READY",
      "WORKSPACE_READY",
      "TASK_PACKET_READY",
      "IMPLEMENTING",
      "CANDIDATE_READY",
      "LOCAL_VERIFY",
      "LOCAL_REVIEW",
      "FIXING",
      "DELIVERY_READY",
      "PUSHED",
      "PR_OPEN",
      "CI_WAIT",
      "PR_REVIEW",
      "PR_DELIVERED",
      "MERGE_QUEUE_WAIT",
      "MERGE_READY",
      "MERGED",
      "EVIDENCE_FINALIZED",
      "COMPLETED",
      "CANCEL_REQUESTED",
      "CANCELLING",
      "WAITING_APPROVAL",
      "NEEDS_SPEC",
      "BLOCKED_EXTERNAL",
      "BUDGET_EXHAUSTED",
      "REFUSED",
      "QUARANTINED",
      "CANCELLED",
      "FAILED",
    ]);
  });

  it("publishes one terminal-state table for recovery and fencing", () => {
    expect(TERMINAL_RUN_EVENT_PHASES).toEqual([
      "COMPLETED",
      "CANCELLED",
      "FAILED",
      "REFUSED",
      "QUARANTINED",
      "BUDGET_EXHAUSTED",
    ]);
    expect(isTerminalRunEventPhase("COMPLETED")).toBe(true);
    expect(isTerminalRunEventPhase("WAITING_APPROVAL")).toBe(false);
    expect(isTerminalRunEventPhase("unknown")).toBe(false);
  });
});

describe("parseRunEvent", () => {
  it("parses a strict v1 event and preserves an object payload", () => {
    const raw = event();
    expect(parseRunEvent(raw)).toEqual(raw);
    expect(runEventSchema.parse(raw)).toEqual(raw);
  });

  it("accepts RFC3339 timestamps with a numeric offset", () => {
    expect(
      parseRunEvent(event({ occurred_at: "2026-08-21T12:20:00+02:00" })).occurred_at,
    ).toBe("2026-08-21T12:20:00+02:00");
  });

  it("fails closed on an unknown schema before general validation", () => {
    expect(() =>
      parseRunEvent({ ...event(), schema: "asf.run-event/v2" }),
    ).toThrow(/unsupported ASF run-event schema.*v2/u);
  });

  it("fails closed on an unknown phase", () => {
    expect(() => parseRunEvent({ ...event(), phase: "RUNNING" })).toThrow(
      /unsupported ASF run-event phase.*RUNNING/u,
    );
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["string", "1"],
  ])("rejects a %s sequence cursor", (_name, seq) => {
    expect(() => parseRunEvent({ ...event(), seq })).toThrow(/seq/u);
  });

  it.each([null, [], "payload", 1])("rejects a non-object payload: %j", (payload) => {
    expect(() => parseRunEvent({ ...event(), payload })).toThrow(/payload/u);
  });

  it("rejects payload values that cannot be represented in durable JSON", () => {
    expect(() => parseRunEvent({ ...event(), payload: { invalid: 1n } })).toThrow(
      /invalid ASF run event/u,
    );
  });

  it("rejects empty cursor identities", () => {
    expect(() => parseRunEvent(event({ event_id: "" }))).toThrow(/event_id/u);
    expect(() => parseRunEvent(event({ run_id: "" }))).toThrow(/run_id/u);
  });

  it.each([
    "verification",
    "Verification.completed",
    "verification..completed",
    ".verification.completed",
    "verification.completed.",
  ])("rejects a non-dotted-lower-case event type: %s", (type) => {
    expect(() => parseRunEvent(event({ type }))).toThrow(/type.*dotted lower-case/u);
  });

  it.each([
    "2026-08-21",
    "2026-08-21T10:20:00",
    "2026-13-21T10:20:00Z",
  ])("rejects a non-RFC3339 timestamp: %s", (occurred_at) => {
    expect(() => parseRunEvent(event({ occurred_at }))).toThrow(/occurred_at/u);
  });

  it("requires a tagged lower-case SHA-256 policy digest", () => {
    expect(() => parseRunEvent(event({ policy_digest: "a".repeat(64) }))).toThrow(
      /policy_digest/u,
    );
    expect(() =>
      parseRunEvent(event({ policy_digest: `sha256:${"A".repeat(64)}` })),
    ).toThrow(/policy_digest/u);
  });

  it("rejects unknown top-level fields", () => {
    expect(() => parseRunEvent({ ...event(), secret_extension: true })).toThrow(
      /Unrecognized key.*secret_extension/u,
    );
  });

  it("rejects unknown event types, phase mismatches, and incomplete candidate evidence", () => {
    expect(() => parseRunEvent(event({ type: "custom.unreviewed" }))).toThrow(
      /unsupported ASF run-event type/u,
    );
    expect(() => parseRunEvent(event({ phase: "LOCAL_REVIEW" }))).toThrow(
      /must use phase LOCAL_VERIFY/u,
    );
    expect(() =>
      parseRunEvent(event({ payload: { check_id: "unit", outcome: "passed" } })),
    ).toThrow(/candidate_sha/u);
  });

  it("requires identity evidence to name every independent role exactly once", () => {
    expect(() =>
      parseRunEvent(
        event({
          type: "identity.leases_acquired",
          phase: "IDENTITY_READY",
          payload: {
            attributions_digest: DIGEST,
            roles: ["implementer", "implementer", "pr-reviewer"],
            attributions: [
              {
                schema: "asf.identity-lease-attribution/v1",
                role: "implementer",
                provider: "codex",
                principal_id: "principal-implementer",
                profile: "profile-implementer",
                fencing_generation: 1,
                issued_at: "2026-08-21T10:00:00.000Z",
                expires_at: "2026-08-21T11:00:00.000Z",
                lease_attribution_digest: DIGEST,
              },
              {
                schema: "asf.identity-lease-attribution/v1",
                role: "local-reviewer",
                provider: "claude",
                principal_id: "principal-local-reviewer",
                profile: "profile-local-reviewer",
                fencing_generation: 1,
                issued_at: "2026-08-21T10:00:00.000Z",
                expires_at: "2026-08-21T11:00:00.000Z",
                lease_attribution_digest: DIGEST,
              },
              {
                schema: "asf.identity-lease-attribution/v1",
                role: "pr-reviewer",
                provider: "claude",
                principal_id: "principal-pr-reviewer",
                profile: "profile-pr-reviewer",
                fencing_generation: 1,
                issued_at: "2026-08-21T10:00:00.000Z",
                expires_at: "2026-08-21T11:00:00.000Z",
                lease_attribution_digest: DIGEST,
              },
            ],
          },
        }),
      ),
    ).toThrow(/each required role once/u);
  });

  it.each([null, [], "event", 1])("rejects a non-object event: %j", (raw) => {
    expect(() => parseRunEvent(raw)).toThrow(/run event must be an object/u);
  });
});
