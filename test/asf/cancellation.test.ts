import { describe, expect, it } from "vitest";
import {
  AsfCancellationService,
  appliedCancellationPolicy,
  parseCancellationRequest,
  type CancellationStore,
} from "../../src/asf/cancellation.js";
import { RunmillError } from "../../src/errors/runmill-error.js";

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "asf.cancellation-request/v1",
    request_id: "cancel_01",
    run_id: "run_01",
    requester: {
      subject: "service:asf-controller",
      authority: "asf:cancel",
    },
    reason: "work item was superseded",
    mode: "graceful",
    grace_seconds: 15,
    ...overrides,
  };
}

function expectInvalid(raw: unknown): void {
  try {
    parseCancellationRequest(raw);
    expect.unreachable("expected invalid cancellation");
  } catch (error) {
    expect(error).toBeInstanceOf(RunmillError);
    expect((error as RunmillError).code).toBe("RM-CANCEL-001");
  }
}

describe("ASF cancellation contract", () => {
  it("parses one strict bounded graceful request", () => {
    expect(parseCancellationRequest(request())).toMatchObject({
      request_id: "cancel_01",
      mode: "graceful",
      grace_seconds: 15,
    });
  });

  it("requires an explicit v1 schema and refuses unknown fields", () => {
    expectInvalid(request({ schema: "asf.cancellation-request/v2" }));
    expectInvalid({ ...request(), shell: "kill -9 -1" });
    expectInvalid({
      ...request(),
      requester: {
        subject: "service:asf-controller",
        authority: "asf:submit",
      },
    });
  });

  it("requires graceful and forced modes to carry unambiguous grace policy", () => {
    expectInvalid(request({ grace_seconds: 0 }));
    expectInvalid(request({ mode: "forced", grace_seconds: 5 }));
    expect(parseCancellationRequest(request({ mode: "forced", grace_seconds: 0 }))).toMatchObject({
      mode: "forced",
      grace_seconds: 0,
    });
  });

  it("hashes the exact request before delegating to the durable store", () => {
    const calls: Parameters<CancellationStore["requestAsfCancellation"]>[0][] = [];
    const store: CancellationStore = {
      requestAsfCancellation(input) {
        calls.push(input);
        return {
          requestId: input.request.request_id,
          runId: input.request.run_id,
          disposition: "requested",
          state: "CANCEL_REQUESTED",
          generation: 2,
          requestDigest: input.requestDigest,
          reconciliationRequired: false,
        };
      },
    };
    const result = new AsfCancellationService(store).request(request());
    expect(result.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(appliedCancellationPolicy(result)).toEqual({
      mode: "graceful",
      graceSeconds: 15,
    });
    expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty("mode");
    expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty("graceSeconds");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.reason).toBe("work item was superseded");
  });
});
