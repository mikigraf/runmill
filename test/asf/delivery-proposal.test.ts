import { describe, expect, it } from "vitest";
import { sha256Digest } from "../../src/asf/canonical-json.js";
import {
  ASF_PULL_REQUEST_DELIVERY_PROPOSAL_SCHEMA,
  DeterministicAsfDeliveryProposalController,
} from "../../src/asf/delivery-proposal.js";
import type { AsfDeliveryBinding } from "../../src/asf/delivery-runner.js";

const POLICY_DIGEST = `sha256:${"a".repeat(64)}`;

function binding(overrides: Partial<AsfDeliveryBinding> = {}): AsfDeliveryBinding {
  return {
    runId: "run_01JTEST",
    workOrderId: "wo_01JTEST",
    attemptId: "attempt_01",
    policyDigest: POLICY_DIGEST,
    fencingGeneration: 1,
    candidateSha: "b".repeat(40),
    ...overrides,
  };
}

async function proposal(overrides: Partial<AsfDeliveryBinding> = {}) {
  return new DeterministicAsfDeliveryProposalController().propose({
    binding: binding(overrides),
    repository: "Acme/Payments",
    baseRef: "refs/heads/main",
    draft: false,
    signal: new AbortController().signal,
  });
}

describe("DeterministicAsfDeliveryProposalController", () => {
  it("creates a stable run-scoped branch and marker with an exact proposal digest", async () => {
    const first = await proposal();
    const second = await proposal();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema: ASF_PULL_REQUEST_DELIVERY_PROPOSAL_SCHEMA,
      repository: "acme/payments",
      base_ref: "refs/heads/main",
      draft: false,
      binding: {
        run_id: "run_01JTEST",
        work_order_id: "wo_01JTEST",
        attempt_id: "attempt_01",
        policy_digest: POLICY_DIGEST,
        fencing_generation: 1,
        candidate_sha: "b".repeat(40),
      },
    });
    expect(first.head_ref).toMatch(/^refs\/heads\/runmill\/asf\/[a-f0-9]{32}$/u);
    expect(first.marker).toMatch(/^runmill-asf-[a-f0-9]{32}$/u);
    expect(first.body).toContain('"candidate_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"');
    const { proposal_digest: digest, ...unsigned } = first;
    expect(digest).toBe(sha256Digest(unsigned));
  });

  it("keeps PR identity stable across a takeover and fixer candidate", async () => {
    const original = await proposal();
    const takeover = await proposal({
      fencingGeneration: 7,
      candidateSha: "c".repeat(40),
    });

    expect(takeover.head_ref).toBe(original.head_ref);
    expect(takeover.marker).toBe(original.marker);
    expect(takeover.proposal_digest).not.toBe(original.proposal_digest);
    expect(takeover.binding).toMatchObject({
      fencing_generation: 7,
      candidate_sha: "c".repeat(40),
    });
  });

  it("uses different PR identity for another attempt and refuses missing candidate authority", async () => {
    const first = await proposal();
    const retry = await proposal({ attemptId: "attempt_02" });
    expect(retry.head_ref).not.toBe(first.head_ref);
    expect(retry.marker).not.toBe(first.marker);

    await expect(proposal({ candidateSha: null })).rejects.toThrow(
      /candidate, or fence binding is malformed/u,
    );
  });

  it("honors cancellation without creating a proposal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    await expect(
      new DeterministicAsfDeliveryProposalController().propose({
        binding: binding(),
        repository: "acme/payments",
        baseRef: "refs/heads/main",
        draft: false,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled by test");
  });
});
