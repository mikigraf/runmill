import { describe, expect, it } from "vitest";
import {
  deserializeAsfControlError,
  handleAsfControlRequest,
  RemoteAsfControlError,
  serializeAsfControlError,
  type AsfControlService,
} from "../../src/asf/control.js";
import { parseControlRequest, type AsfControlRequest } from "../../src/daemon/control.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import type { AsfRunRow } from "../../src/state/store.js";

function asfRequest(raw: unknown): AsfControlRequest {
  const request = parseControlRequest(raw);
  if (
    request.type === "snapshot" ||
    request.type === "inspect" ||
    request.type === "stop"
  ) {
    throw new Error("test expected an ASF control request");
  }
  return request;
}

describe("handleAsfControlRequest", () => {
  it("maps exactly the nine bounded ASF service operations", async () => {
    const calls: unknown[] = [];
    const service: AsfControlService = {
      submitWorkOrder: async (envelope) => {
        calls.push(["submit", envelope]);
        return {
          runId: "run_01J",
          disposition: "accepted",
          payloadDigest: `sha256:${"a".repeat(64)}`,
        };
      },
      getRun: (runId) => {
        calls.push(["get", runId]);
        return { run: { runId } } as ReturnType<AsfControlService["getRun"]>;
      },
      listRunEvents: (runId, after, limit) => {
        calls.push(["events", runId, after, limit]);
        return {
          events: [],
          nextCursor: after ?? 0,
          hasMore: false,
          gap: false,
          compactedThrough: null,
          snapshot: {
            run: { runId } as AsfRunRow,
            latestSequence: after ?? 0,
          },
        };
      },
      getEvidence: (runId) => {
        calls.push(["evidence", runId]);
        return { runId } as ReturnType<AsfControlService["getEvidence"]>;
      },
      requestCancellation: (request) => {
        calls.push(["cancel", request]);
        return { runId: "run_01J" } as ReturnType<
          AsfControlService["requestCancellation"]
        >;
      },
      recordApproval: (envelope) => {
        calls.push(["approval", envelope]);
        return { runId: "run_01J" } as ReturnType<AsfControlService["recordApproval"]>;
      },
      requestReconciliation: (request) => {
        calls.push(["reconcile", request]);
        return { runId: "run_01J" } as ReturnType<
          AsfControlService["requestReconciliation"]
        >;
      },
      acknowledgeOutcome: (acknowledgement) => {
        calls.push(["acknowledge", acknowledgement]);
        return { runId: "run_01J" } as ReturnType<
          AsfControlService["acknowledgeOutcome"]
        >;
      },
      health: async () => {
        calls.push(["health"]);
        return { status: "ready" } as Awaited<
          ReturnType<AsfControlService["health"]>
        >;
      },
    };

    const digest = `sha256:${"a".repeat(64)}`;
    const candidateSha = "b".repeat(40);
    const cancellation = {
      schema: "asf.cancellation-request/v1",
      request_id: "cancel_01",
      run_id: "run_01J",
      requester: { subject: "service:asf-controller", authority: "asf:cancel" },
      reason: "superseded",
      mode: "forced",
      grace_seconds: 0,
    } as const;
    const approval = {
      schema: "asf.approval-envelope/v1",
      key_id: "approval-key",
      algorithm: "EdDSA",
      payload: {
        schema: "asf.approval/v1",
        approval_id: "approval_01",
        work_order_id: "wo_01",
        work_order_digest: digest,
        run_id: "run_01J",
        attempt_id: "attempt_01",
        candidate_sha: candidateSha,
        decision: "approved",
        decision_type: "delivery",
        requested_effect: "pull-request-delivery",
        policy_digest: digest,
        approver: { subject: "operator:alice", authority: "repository:approve" },
        issued_at: "2026-08-21T10:00:00Z",
        expires_at: "2026-08-21T11:00:00Z",
      },
      signature: "base64url:AA",
    } as const;
    const reconciliation = {
      schema: "asf.reconciliation-request/v1",
      operation_id: "reconcile_01",
      run_id: "run_01J",
      requested_by: {
        subject: "service:asf-controller",
        authority: "asf:reconcile",
      },
      scope: "pending-effects",
    } as const;
    const acknowledgement = {
      schema: "asf.outcome-acknowledgement/v1",
      acknowledgement_id: "ack_01",
      run_id: "run_01J",
      bundle_digest: digest,
      acknowledged_by: {
        subject: "service:asf-controller",
        authority: "asf:acknowledge-outcome",
      },
    } as const;

    await expect(
      handleAsfControlRequest(
        service,
        asfRequest({
          type: "asf.submit_work_order",
          envelope: { schema: "asf.work-order-envelope/v1" },
        }),
      ),
    ).resolves.toMatchObject({ runId: "run_01J", disposition: "accepted" });
    await expect(
      handleAsfControlRequest(
        service,
        asfRequest({ type: "asf.get_run", runId: "run_01J" }),
      ),
    ).resolves.toMatchObject({ run: { runId: "run_01J" } });
    await expect(
      handleAsfControlRequest(
        service,
        asfRequest({ type: "asf.list_run_events", runId: "run_01J", after: 7 }),
      ),
    ).resolves.toMatchObject({ nextCursor: 7 });
    await handleAsfControlRequest(
      service,
      asfRequest({ type: "asf.get_evidence", runId: "run_01J" }),
    );
    await handleAsfControlRequest(
      service,
      asfRequest({ type: "asf.request_cancel", request: cancellation }),
    );
    await handleAsfControlRequest(
      service,
      asfRequest({ type: "asf.record_approval", envelope: approval }),
    );
    await handleAsfControlRequest(
      service,
      asfRequest({ type: "asf.reconcile_run", request: reconciliation }),
    );
    await handleAsfControlRequest(
      service,
      asfRequest({ type: "asf.acknowledge_outcome", acknowledgement }),
    );
    await expect(
      handleAsfControlRequest(service, asfRequest({ type: "asf.health" })),
    ).resolves.toEqual({ status: "ready" });

    expect(calls).toEqual([
      ["submit", { schema: "asf.work-order-envelope/v1" }],
      ["get", "run_01J"],
      ["events", "run_01J", 7, 100],
      ["evidence", "run_01J"],
      ["cancel", cancellation],
      ["approval", approval],
      ["reconcile", reconciliation],
      ["acknowledge", acknowledgement],
      ["health"],
    ]);
  });

  it.each(["merge_now", "shell", "github.request", "provider.credential"])(
    "has no arbitrary %s operation",
    (type) => {
      expect(() => parseControlRequest({ type })).toThrow(/control request/u);
    },
  );
});

describe("ASF control error contract", () => {
  function cataloguedFailure(): RunmillError {
    return RunmillError.fromCatalog("RM-CI-002", {
      whatHappened: "required context ci/test did not report for the candidate",
      runId: "run_01J",
      resumeFrom: "CI_WAIT",
      cause: {
        retry_disposition: "reconcile-first",
        required_actor: "repository-owner",
        required_action: "Restore the required check and reconcile the candidate SHA.",
        evidence_refs: [`sha256:${"b".repeat(64)}`],
      },
    });
  }

  it("round-trips stable RunmillError and escalation details", () => {
    const original = cataloguedFailure();
    const serialized = serializeAsfControlError(original);

    expect(serialized).toMatchObject({
      schema: "asf.control-error/v1",
      code: "RM-CI-002",
      what_happened: "required context ci/test did not report for the candidate",
      recoverable: true,
      run_id: "run_01J",
      checkpoint: "CI_WAIT",
      retry_disposition: "reconcile-first",
      required_actor: "repository-owner",
      required_action: "Restore the required check and reconcile the candidate SHA.",
      evidence_refs: [`sha256:${"b".repeat(64)}`],
      docs_url: original.docsUrl,
    });
    if (serialized === undefined) throw new Error("catalogued failure was not serialized");

    const remote = deserializeAsfControlError(serialized);
    expect(remote).toBeInstanceOf(RemoteAsfControlError);
    expect(remote).toBeInstanceOf(RunmillError);
    expect(remote).toMatchObject({
      code: "RM-CI-002",
      whatHappened: original.whatHappened,
      why: original.why,
      fixes: original.fixes,
      recoverable: true,
      runId: "run_01J",
      resumeFrom: "CI_WAIT",
      retryDisposition: "reconcile-first",
      requiredActor: "repository-owner",
      requiredAction: "Restore the required check and reconcile the candidate SHA.",
      evidenceRefs: [`sha256:${"b".repeat(64)}`],
    });
    expect(remote.docsUrl).toBe(original.docsUrl);
  });

  it("does not fabricate a stable code for an unclassified error", () => {
    expect(serializeAsfControlError(new Error("unexpected adapter failure"))).toBeUndefined();
  });

  it("fails closed on malformed or extended remote error details", () => {
    const serialized = serializeAsfControlError(cataloguedFailure());
    if (serialized === undefined) throw new Error("catalogued failure was not serialized");

    expect(() =>
      deserializeAsfControlError({ ...serialized, retry_disposition: "blind-retry" }),
    ).toThrow(/invalid ASF control error response.*retry_disposition/u);
    expect(() =>
      deserializeAsfControlError({ ...serialized, credential: "must-not-cross" }),
    ).toThrow(/invalid ASF control error response.*credential/u);
  });
});
