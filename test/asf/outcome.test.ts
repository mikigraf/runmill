import { describe, expect, it } from "vitest";
import { sha256Digest } from "../../src/asf/canonical-json.js";
import {
  AsfOutcomeAcknowledgementService,
  parseOutcomeAcknowledgement,
  type OutcomeAcknowledgement,
  type OutcomeAcknowledgementStore,
} from "../../src/asf/outcome.js";
import { RunmillError } from "../../src/errors/runmill-error.js";

const BUNDLE_DIGEST = `sha256:${"a".repeat(64)}`;

function request(): OutcomeAcknowledgement {
  return {
    schema: "asf.outcome-acknowledgement/v1",
    acknowledgement_id: "ack_01",
    run_id: "run_01",
    bundle_digest: BUNDLE_DIGEST,
    acknowledged_by: {
      subject: "service:asf-controller",
      authority: "asf:acknowledge-outcome",
    },
  };
}

describe("ASF outcome acknowledgement", () => {
  it("passes a strict acknowledgement and its canonical digest to the durable store", () => {
    let observed:
      | Parameters<OutcomeAcknowledgementStore["acknowledgeAsfOutcome"]>[0]
      | undefined;
    const service = new AsfOutcomeAcknowledgementService({
      acknowledgeAsfOutcome(input) {
        observed = input;
        return {
          acknowledgementId: input.acknowledgement.acknowledgement_id,
          runId: input.acknowledgement.run_id,
          bundleDigest: input.acknowledgement.bundle_digest,
          disposition: "recorded",
          acknowledgedAt: "2026-08-21T10:30:00.000Z",
        };
      },
    });

    expect(service.acknowledge(request())).toMatchObject({
      acknowledgementId: "ack_01",
      runId: "run_01",
      bundleDigest: BUNDLE_DIGEST,
      disposition: "recorded",
    });
    expect(observed).toEqual({
      acknowledgement: request(),
      requestDigest: sha256Digest(request()),
    });
  });

  it.each([
    ["unknown schema", { ...request(), schema: "asf.outcome-acknowledgement/v2" }],
    ["extra authority", { ...request(), merge_now: true }],
    [
      "wrong authority",
      {
        ...request(),
        acknowledged_by: {
          subject: "service:asf-controller",
          authority: "asf:submit",
        },
      },
    ],
    ["malformed digest", { ...request(), bundle_digest: "sha256:not-a-digest" }],
  ])("refuses %s before invoking the store", (_label, raw) => {
    let calls = 0;
    const service = new AsfOutcomeAcknowledgementService({
      acknowledgeAsfOutcome() {
        calls += 1;
        throw new Error("must not be reached");
      },
    });

    expect(() => service.acknowledge(raw)).toThrow(RunmillError);
    expect(calls).toBe(0);
  });

  it("does not accept a merely similar acknowledgement object", () => {
    expect(() =>
      parseOutcomeAcknowledgement({
        ...request(),
        acknowledged_by: { subject: "service:asf-controller" },
      }),
    ).toThrow(RunmillError);
  });
});
