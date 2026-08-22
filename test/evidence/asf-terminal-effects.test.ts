import { describe, expect, it } from "vitest";
import { sha256Digest, type JsonValue } from "../../src/asf/canonical-json.js";
import {
  ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS,
  asfTerminalEffectLedgerDigest,
  buildAsfTerminalEffectLedger,
  validateAsfTerminalEffectLedger,
  type AsfTerminalEffectLedger,
  type AsfTerminalEffectLedgerBuildInput,
} from "../../src/evidence/asf-terminal-effects.js";

const DIGEST = {
  policy: `sha256:${"a".repeat(64)}`,
  deliveryIntent: `sha256:${"b".repeat(64)}`,
  deliveryOperation: `sha256:${"c".repeat(64)}`,
  deliveryFirst: `sha256:${"d".repeat(64)}`,
  deliveryFinal: `sha256:${"e".repeat(64)}`,
  githubIntent: `sha256:${"f".repeat(64)}`,
  githubFinal: `sha256:${"1".repeat(64)}`,
  request: `sha256:${"2".repeat(64)}`,
  pending: `sha256:${"3".repeat(64)}`,
  result: `sha256:${"4".repeat(64)}`,
} as const;

const CANDIDATE = "5".repeat(40);

function input(): AsfTerminalEffectLedgerBuildInput {
  return {
    run_id: "run-ledger",
    work_order_id: "work-order-ledger",
    attempt_id: "attempt-ledger",
    policy_digest: DIGEST.policy,
    effects: [
      {
        effect_class: "github-effect",
        effect_key: "effect_z",
        operation: "pull_request.update",
        candidate_sha: CANDIDATE,
        intent_digest: DIGEST.githubIntent,
        generation: 4,
        intended_at: "2026-08-22T10:01:00.000Z",
        final_outcome: "not_applied",
        final_observation_seq: 1,
        observations: [
          {
            seq: 1,
            outcome: "not_applied",
            observation_digest: DIGEST.githubFinal,
            observed_at: "2026-08-22T10:03:00.000Z",
          },
        ],
      },
      {
        effect_class: "delivery-intent",
        effect_key: "delivery_effect_a",
        stage: "pull-request",
        candidate_sha: CANDIDATE,
        event_seq: 19,
        intent_id: "delivery_a",
        intent_digest: DIGEST.deliveryIntent,
        operation_digest: DIGEST.deliveryOperation,
        fencing_generation: 2,
        created_at: "2026-08-22T10:00:00.000Z",
        final_outcome: "confirmed",
        final_observation_seq: 2,
        observations: [
          {
            seq: 2,
            outcome: "confirmed",
            observation_digest: DIGEST.deliveryFinal,
            generation: 3,
            source: "confirmation",
            observed_at: "2026-08-22T10:02:00.000Z",
          },
          {
            seq: 1,
            outcome: "ambiguous",
            observation_digest: DIGEST.deliveryFirst,
            generation: 2,
            source: "legacy",
            observed_at: "2026-08-22T10:01:00.000Z",
          },
        ],
        replay: null,
      },
    ],
    reconciliations: [
      {
        operation_id: "reconcile-a",
        request_digest: DIGEST.request,
        pending_set_digest: DIGEST.pending,
        result_digest: DIGEST.result,
        status: "completed",
        requested_at: "2026-08-22T10:00:30.000Z",
        started_at: "2026-08-22T10:00:40.000Z",
        completed_at: "2026-08-22T10:02:30.000Z",
        effects: [
          {
            effect_class: "github-effect",
            effect_key: "effect_z",
            outcome: "not_applied",
          },
          {
            effect_class: "delivery-intent",
            effect_key: "delivery_effect_a",
            outcome: "ambiguous",
          },
        ],
      },
    ],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rehash(ledger: AsfTerminalEffectLedger): AsfTerminalEffectLedger {
  const { ledger_digest: _digest, ...unsigned } = ledger;
  return {
    ...ledger,
    ledger_digest: asfTerminalEffectLedgerDigest(unsigned),
  };
}

describe("portable ASF terminal effect ledger", () => {
  it("sorts every set deterministically and binds exact counts and digest", () => {
    const source = input();
    const built = buildAsfTerminalEffectLedger(source);

    expect(built.schema).toBe("asf.terminal-effect-ledger/v1");
    expect(built.scope).toBe("before-terminal-cleanup");
    expect(built.effects.map((effect) => effect.effect_class)).toEqual([
      "delivery-intent",
      "github-effect",
    ]);
    expect(built.effects[0]?.observations.map((item) => item.seq)).toEqual([
      1, 2,
    ]);
    expect(
      built.reconciliations[0]?.effects.map(
        (effect) => `${effect.effect_class}:${effect.effect_key}`,
      ),
    ).toEqual([
      "delivery-intent:delivery_effect_a",
      "github-effect:effect_z",
    ]);
    expect(built).toMatchObject({
      effect_count: 2,
      observation_count: 3,
      reconciliation_count: 1,
      reconciliation_effect_ref_count: 2,
    });
    const { ledger_digest: _digest, ...unsigned } = built;
    expect(built.ledger_digest).toBe(
      sha256Digest(unsigned as unknown as JsonValue),
    );
    expect(validateAsfTerminalEffectLedger(built)).toEqual(built);
    expect(source.effects[1]?.observations.map((item) => item.seq)).toEqual([
      2, 1,
    ]);
  });

  it("produces identical evidence for insertion-order variants", () => {
    const first = input();
    const second = input();
    second.effects.reverse();
    second.reconciliations[0]?.effects.reverse();

    expect(buildAsfTerminalEffectLedger(second)).toEqual(
      buildAsfTerminalEffectLedger(first),
    );
  });

  it("refuses canonical-content tampering even when the shape remains valid", () => {
    const built = buildAsfTerminalEffectLedger(input());
    const tampered = clone(built);
    const effect = tampered.effects[1];
    if (effect?.effect_class !== "github-effect") throw new Error("bad fixture");
    effect.generation = 9;

    expect(() => validateAsfTerminalEffectLedger(tampered)).toThrow(
      /digest contradicts/u,
    );
  });

  it("refuses noncanonical order even when an attacker recomputes the digest", () => {
    const reordered = clone(buildAsfTerminalEffectLedger(input()));
    reordered.effects.reverse();

    expect(() => validateAsfTerminalEffectLedger(rehash(reordered))).toThrow(
      /canonical order/u,
    );
  });

  it("refuses duplicate effects and duplicate reconciliation references", () => {
    const duplicateEffect = input();
    duplicateEffect.effects.push(clone(duplicateEffect.effects[0]!));
    expect(() => buildAsfTerminalEffectLedger(duplicateEffect)).toThrow(
      /globally unique/u,
    );

    const duplicateReference = input();
    const reconciliation = duplicateReference.reconciliations[0];
    const reference = reconciliation?.effects[0];
    if (reconciliation === undefined || reference === undefined) {
      throw new Error("bad fixture");
    }
    reconciliation.effects.push(clone(reference));
    expect(() => buildAsfTerminalEffectLedger(duplicateReference)).toThrow(
      /unique and canonically sorted/u,
    );
  });

  it("refuses gaps, trailing ambiguity, and contradictory final markers", () => {
    const gap = input();
    const gapEffect = gap.effects[1];
    if (gapEffect?.effect_class !== "delivery-intent") throw new Error("bad fixture");
    gapEffect.observations[1]!.seq = 3;
    gapEffect.final_observation_seq = 3;
    expect(() => buildAsfTerminalEffectLedger(gap)).toThrow(/contiguous/u);

    const unresolved = input() as unknown as Record<string, unknown>;
    const unresolvedEffects = unresolved["effects"] as Record<string, unknown>[];
    unresolvedEffects[0]!["final_outcome"] = "ambiguous";
    expect(() =>
      buildAsfTerminalEffectLedger(
        unresolved as unknown as AsfTerminalEffectLedgerBuildInput,
      ),
    ).toThrow();

    const contradictory = input();
    const contradictoryEffect = contradictory.effects[0];
    if (contradictoryEffect?.effect_class !== "github-effect") {
      throw new Error("bad fixture");
    }
    contradictoryEffect.final_outcome = "confirmed";
    expect(() => buildAsfTerminalEffectLedger(contradictory)).toThrow(
      /last definitive observation/u,
    );
  });

  it("refuses cleanup authority and private side-effect fields", () => {
    const cleanup = input() as unknown as Record<string, unknown>;
    const cleanupEffects = cleanup["effects"] as Record<string, unknown>[];
    cleanupEffects[1]!["stage"] = "cleanup";
    expect(() =>
      buildAsfTerminalEffectLedger(
        cleanup as unknown as AsfTerminalEffectLedgerBuildInput,
      ),
    ).toThrow();

    const privateField = input() as unknown as Record<string, unknown>;
    const privateEffects = privateField["effects"] as Record<string, unknown>[];
    privateEffects[0]!["target"] = "secret/repository-target";
    privateEffects[0]!["correlation_marker"] = "secret-marker";
    privateEffects[0]!["remote_id"] = "secret-remote-id";
    expect(() =>
      buildAsfTerminalEffectLedger(
        privateField as unknown as AsfTerminalEffectLedgerBuildInput,
      ),
    ).toThrow();

    const encoded = JSON.stringify(buildAsfTerminalEffectLedger(input()));
    for (const forbidden of [
      "target",
      "correlation_marker",
      "remote_id",
      "observer",
      "requester",
      "owner_id",
      "payload",
    ]) {
      expect(encoded).not.toContain(`\"${forbidden}\"`);
    }
  });

  it("refuses absent reconciliation effects, bad counts, and evidence bounds", () => {
    const absent = input();
    absent.reconciliations[0]!.effects[0]!.effect_key = "effect_missing";
    expect(() => buildAsfTerminalEffectLedger(absent)).toThrow(
      /absent from the terminal effect history/u,
    );

    const count = clone(buildAsfTerminalEffectLedger(input()));
    count.observation_count += 1;
    expect(() => validateAsfTerminalEffectLedger(rehash(count))).toThrow(
      /counts must exactly cover/u,
    );

    const tooMany = input();
    const bounded = tooMany.effects[1];
    if (bounded?.effect_class !== "delivery-intent") throw new Error("bad fixture");
    bounded.observations = Array.from(
      { length: ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS / 10 + 1 },
      (_, index) => ({
        seq: index + 1,
        outcome: "confirmed" as const,
        observation_digest: DIGEST.deliveryFinal,
        generation: 3,
        source: "confirmation" as const,
        observed_at: "2026-08-22T10:02:00.000Z",
      }),
    );
    bounded.final_observation_seq = bounded.observations.length;
    expect(() => buildAsfTerminalEffectLedger(tooMany)).toThrow();
  });

  it("refuses malformed chronology and active replay authority", () => {
    const chronology = input();
    chronology.reconciliations[0]!.completed_at =
      "2026-08-22T09:59:00.000Z";
    expect(() => buildAsfTerminalEffectLedger(chronology)).toThrow(
      /request, start, completion/u,
    );

    const replay = input();
    const effect = replay.effects[1];
    if (effect?.effect_class !== "delivery-intent") throw new Error("bad fixture");
    effect.replay = {
      authorized_by_operation_id: "reconcile-a",
      started_generation: 99,
    } as never;
    expect(() => buildAsfTerminalEffectLedger(replay)).toThrow(
      /expected null/iu,
    );
  });
});
