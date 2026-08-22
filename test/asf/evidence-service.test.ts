import { describe, expect, it } from "vitest";
import {
  AsfEvidenceReadService,
  type AsfEvidenceReadStore,
} from "../../src/asf/evidence-service.js";
import type { AsfDurableRunSnapshot } from "../../src/state/store.js";
import { RunmillError } from "../../src/errors/runmill-error.js";

const BASE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "b".repeat(40);
const POLICY_DIGEST = `sha256:${"c".repeat(64)}`;

function snapshot(state = "IMPLEMENTING"): AsfDurableRunSnapshot {
  return {
    run: {
      runId: "run_01",
      issueId: "ENG-123",
      repo: "acme/payments",
      provider: "codex:asf-production",
      state,
      stateVersion: 6,
      attempt: 1,
      baseCommit: BASE_SHA,
      candidateSha: state === "IMPLEMENTING" ? null : CANDIDATE_SHA,
      branch: null,
      mode: "asf-worker",
      workOrderId: "wo_01",
      attemptId: "attempt_01",
      generation: 1,
      ownerId: "worker-a",
      heartbeatAt: "2026-08-21T10:05:00.000Z",
    },
    admission: {
      runId: "run_01",
      idempotencyKey: "tenant/ENG-123/attempt_01",
      payloadDigest: `sha256:${"d".repeat(64)}`,
      envelopeDigest: `sha256:${"e".repeat(64)}`,
      canonicalEnvelope: JSON.stringify({ protected: "must-not-escape" }),
      workOrderId: "wo_01",
      attemptId: "attempt_01",
      tenantId: "tenant",
      effectivePolicy: JSON.stringify({ protected: "must-not-escape" }),
      effectivePolicyDigest: POLICY_DIGEST,
      signatureKeyId: "asf-key",
      signatureAlgorithm: "EdDSA",
      acceptedAt: "2026-08-21T10:00:00.000Z",
    },
    latestSequence: 6,
  };
}

function storeFor(current: AsfDurableRunSnapshot): AsfEvidenceReadStore {
  return {
    getAsfRunSnapshot: () => current,
    getAsfEvidenceBundleRecord: () => undefined,
    getAsfEvidenceBundle: () => undefined,
    getAsfTerminalEvidenceBundleRecord: () => undefined,
    getAsfTerminalEvidenceBundle: () => undefined,
    getLatestAsfCheckpoint: () => undefined,
    listAsfRunEvents: () => ({
      events: [],
      nextCursor: current.latestSequence,
      hasMore: false,
      gap: true,
      compactedThrough: current.latestSequence,
      snapshot: { run: current.run, latestSequence: current.latestSequence },
    }),
  };
}

describe("ASF evidence read service", () => {
  it("returns a bounded public current manifest without protected admission material", () => {
    const result = new AsfEvidenceReadService(storeFor(snapshot())).getEvidence("run_01");

    expect(result).toEqual({
      schema: "asf.evidence-view/v1",
      runId: "run_01",
      workOrderId: "wo_01",
      attemptId: "attempt_01",
      phase: "IMPLEMENTING",
      candidateSha: null,
      policyDigest: POLICY_DIGEST,
      latestSequence: 6,
      status: "current",
      complete: false,
      bundleDigest: null,
      terminalBundleDigest: null,
      artifacts: [],
      latestEvent: null,
      signedBundle: null,
      signedTerminalBundle: null,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });

  it("fails closed when a stopped terminal run has no signed cleanup evidence", () => {
    expect(() =>
      new AsfEvidenceReadService(storeFor(snapshot("REFUSED"))).getEvidence("run_01"),
    ).toThrow(RunmillError);
  });

  it("fails closed if durable state claims finalization without the signed bundle", () => {
    const service = new AsfEvidenceReadService(storeFor(snapshot("COMPLETED")));
    expect(() => service.getEvidence("run_01")).toThrow(RunmillError);
  });

  it("does not publish evidence when the strict signed-envelope reader refuses it", () => {
    const current = snapshot("PR_DELIVERED");
    const base = storeFor(current);
    const service = new AsfEvidenceReadService({
      ...base,
      getAsfEvidenceBundleRecord: () => ({
        runId: "run_01",
        candidateSha: CANDIDATE_SHA,
        policyDigest: POLICY_DIGEST,
        bundleDigest: `sha256:${"f".repeat(64)}`,
        canonicalEnvelopeDigest: `sha256:${"0".repeat(64)}`,
        canonicalEnvelope: "{}",
        finalizedAt: "2026-08-21T10:05:00.000Z",
      }),
      getAsfEvidenceBundle: () => {
        throw new Error("stored signed evidence envelope is contradictory");
      },
    });

    expect(() => service.getEvidence("run_01")).toThrow(
      /signed evidence envelope is contradictory/u,
    );
  });

  it("fails closed for an unknown run", () => {
    const store = storeFor(snapshot());
    const service = new AsfEvidenceReadService({
      ...store,
      getAsfRunSnapshot: () => undefined,
    });
    expect(() => service.getEvidence("missing")).toThrow(RunmillError);
  });
});
