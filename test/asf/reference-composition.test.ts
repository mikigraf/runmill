import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ASF_REFERENCE_COMPOSITION_CLASSIFICATION,
  ASF_REFERENCE_COMPOSITION_PRODUCTION_QUALIFIED,
  ASF_REFERENCE_COMPOSITION_REQUIRED_PORTS,
  ASF_REFERENCE_COMPOSITION_SCHEMA,
  AsfReferenceCompositionError,
  AsfReferenceCompositionShutdownError,
  createAsfReferenceWorkerHostOptions,
  inspectAsfReferenceComposition,
  type AsfReferenceCompositionInput,
  type AsfReferenceShutdownController,
} from "../../src/asf/reference-composition.js";
import { StateStore } from "../../src/state/store.js";
import { createNoopAsfTelemetryRecorder } from "../../src/asf/telemetry.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const NOW = "2026-08-21T10:00:00.000Z";

function method(): ReturnType<typeof vi.fn> {
  return vi.fn();
}

function fixture(): {
  readonly input: AsfReferenceCompositionInput;
  readonly bind: ReturnType<typeof vi.fn>;
  readonly shutdown: {
    readonly stopReconciliation: ReturnType<typeof vi.fn>;
    readonly retireIdentities: ReturnType<typeof vi.fn>;
    readonly cleanupResources: ReturnType<typeof vi.fn>;
  };
  readonly close: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "runmill-asf-reference-"));
  const clock = new FakeClock(NOW);
  const store = StateStore.open(join(root, "state.sqlite"), { clock });
  const bind = method();
  const shutdown = {
    stopReconciliation: vi.fn(async () => undefined),
    retireIdentities: vi.fn(async () => undefined),
    cleanupResources: vi.fn(async () => undefined),
  };
  const delivery = {
    intents: {
      record: method(),
      confirm: method(),
      prepareTerminal: method(),
      sealTerminal: method(),
    },
    recovery: { observe: method(), apply: method() },
    recoveryDispatch: { dispatch: method() },
    repositoryLease: { acquire: method() },
    identities: { acquireRequiredRoles: method() },
    workspace: { prepare: method(), observeCurrent: method() },
    taskPacket: { create: method() },
    implementation: {
      markSession: method(),
      createCandidate: method(),
      captureProtectedResume: method(),
    },
    localVerification: { verify: method() },
    reviewer: { review: method() },
    invalidation: { invalidate: method() },
    deliveryProposal: { propose: method() },
    github: {
      ensureBranch: method(),
      ensurePullRequest: method(),
      observeFinalDelivery: method(),
    },
    ci: { observeExactHead: method() },
    evidence: { finalize: method() },
    terminalEvidence: { finalizeTerminal: method() },
    cleanup: { cleanup: method() },
    budget: { checkRun: method(), reserve: method(), complete: method() },
  } as unknown as AsfReferenceCompositionInput["delivery"];
  const controls = {
    admission: { submit: method() },
    cancellation: { request: method() },
    approval: { record: method() },
    evidence: { getEvidence: method() },
    reconciliation: {
      request: method(),
      recover: method(),
      bindDurableContinuationHandler: bind,
    },
    outcome: { acknowledge: method() },
    health: { getHealth: method() },
  } as unknown as AsfReferenceCompositionInput["controls"];
  const input: AsfReferenceCompositionInput = {
    schema: ASF_REFERENCE_COMPOSITION_SCHEMA,
    classification: ASF_REFERENCE_COMPOSITION_CLASSIFICATION,
    productionQualified: ASF_REFERENCE_COMPOSITION_PRODUCTION_QUALIFIED,
    mode: "asf-worker",
    store,
    clock,
    telemetry: createNoopAsfTelemetryRecorder(clock),
    workerId: "worker-reference-01",
    delivery,
    worker: { staleOwnershipMs: 30_000 },
    controls,
    shutdown,
    host: {
      repoRoot: root,
      configPath: join(root, "asf.json"),
      startedAt: NOW,
      controlAuthentication: { verify: async () => undefined },
      readiness: () => {
        throw new Error("readiness is not invoked while composing");
      },
    },
  };
  return {
    input,
    bind,
    shutdown,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Class-backed shutdown controller whose methods require their receiver.
 * Every method touches private state, so an unbound invocation throws and
 * the recorded call order proves both receiver preservation and sequencing.
 */
class ClassBackedShutdown implements AsfReferenceShutdownController {
  readonly #calls: string[];
  #retirementFailuresRemaining: number;

  constructor(calls: string[], retirementFailures = 0) {
    this.#calls = calls;
    this.#retirementFailuresRemaining = retirementFailures;
  }

  async stopReconciliation(): Promise<void> {
    this.#record("stopReconciliation");
  }

  async retireIdentities(): Promise<void> {
    this.#record("retireIdentities");
    if (this.#retirementFailuresRemaining > 0) {
      this.#retirementFailuresRemaining -= 1;
      throw new Error("identity retirement refused");
    }
  }

  async cleanupResources(): Promise<void> {
    this.#record("cleanupResources");
  }

  #record(step: string): void {
    this.#calls.push(step);
  }
}

function replaceNestedMethod(
  input: AsfReferenceCompositionInput,
  container: "delivery" | "controls" | "shutdown",
  port: string,
  methodName: string,
): AsfReferenceCompositionInput {
  const originalContainer = input[container] as unknown as Record<
    string,
    unknown
  >;
  const originalPort = originalContainer[port] as Record<string, unknown>;
  return {
    ...input,
    [container]: {
      ...originalContainer,
      [port]: { ...originalPort, [methodName]: undefined },
    },
  };
}

describe("ASF reference composition", () => {
  it("reports a complete structural boundary without claiming production qualification", () => {
    const test = fixture();
    try {
      const report = inspectAsfReferenceComposition(test.input);
      expect(report).toMatchObject({
        schema: "runmill.asf-reference-composition-report/v1",
        classification: "reference-integration-boundary",
        productionQualified: false,
        configurationValid: true,
        complete: true,
        missingPorts: [],
        reasons: [],
      });
      expect(new Set(ASF_REFERENCE_COMPOSITION_REQUIRED_PORTS).size).toBe(
        ASF_REFERENCE_COMPOSITION_REQUIRED_PORTS.length,
      );
    } finally {
      test.close();
    }
  });

  it("assembles the real runner/service and retires every resource exactly once", async () => {
    const test = fixture();
    try {
      const options = createAsfReferenceWorkerHostOptions(test.input);
      expect(options.mode).toBe("asf-worker");
      expect(typeof options.service.submitWorkOrder).toBe("function");
      expect(test.bind).toHaveBeenCalledTimes(1);

      const first = options.service.requestStop();
      const second = options.service.requestStop();
      expect(second).toBe(first);
      await first;

      expect(test.shutdown.stopReconciliation).toHaveBeenCalledTimes(1);
      expect(test.shutdown.retireIdentities).toHaveBeenCalledTimes(1);
      expect(test.shutdown.cleanupResources).toHaveBeenCalledTimes(1);
    } finally {
      test.close();
    }
  });

  it("continues shutdown after a failure and reports unresolved retirement", async () => {
    const test = fixture();
    try {
      const stopReconciliation = vi.fn(async () => {
        throw new Error("protected failure");
      });
      const retireIdentities = vi.fn(async () => undefined);
      const cleanupResources = vi.fn(async () => undefined);
      const options = createAsfReferenceWorkerHostOptions({
        ...test.input,
        shutdown: { stopReconciliation, retireIdentities, cleanupResources },
      });

      await expect(options.service.requestStop()).rejects.toBeInstanceOf(
        AsfReferenceCompositionShutdownError,
      );
      expect(retireIdentities).toHaveBeenCalledTimes(1);
      expect(cleanupResources).toHaveBeenCalledTimes(1);
    } finally {
      test.close();
    }
  });

  it("preserves class-backed shutdown receivers and cleans resources in order", async () => {
    const test = fixture();
    try {
      const calls: string[] = [];
      const options = createAsfReferenceWorkerHostOptions({
        ...test.input,
        shutdown: new ClassBackedShutdown(calls),
      });

      await expect(options.service.requestStop()).resolves.toBeUndefined();
      expect(calls).toEqual([
        "stopReconciliation",
        "retireIdentities",
        "cleanupResources",
      ]);
    } finally {
      test.close();
    }
  });

  it("refuses resource cleanup when identity retirement fails", async () => {
    const test = fixture();
    try {
      const calls: string[] = [];
      const options = createAsfReferenceWorkerHostOptions({
        ...test.input,
        shutdown: new ClassBackedShutdown(calls, 1),
      });

      await expect(options.service.requestStop()).rejects.toBeInstanceOf(
        AsfReferenceCompositionShutdownError,
      );
      expect(calls).toEqual(["stopReconciliation", "retireIdentities"]);
    } finally {
      test.close();
    }
  });

  it("shares one promise per attempt and retries the sequence after failure", async () => {
    const test = fixture();
    try {
      const calls: string[] = [];
      const options = createAsfReferenceWorkerHostOptions({
        ...test.input,
        shutdown: new ClassBackedShutdown(calls, 1),
      });

      const first = options.service.requestStop();
      expect(options.service.requestStop()).toBe(first);
      await expect(first).rejects.toBeInstanceOf(
        AsfReferenceCompositionShutdownError,
      );
      expect(calls).toEqual(["stopReconciliation", "retireIdentities"]);

      await expect(options.service.requestStop()).resolves.toBeUndefined();
      expect(calls).toEqual([
        "stopReconciliation",
        "retireIdentities",
        "stopReconciliation",
        "retireIdentities",
        "cleanupResources",
      ]);
    } finally {
      test.close();
    }
  });

  it("refuses a missing port before constructing or binding the service", () => {
    const test = fixture();
    try {
      const incomplete = replaceNestedMethod(
        test.input,
        "delivery",
        "workspace",
        "prepare",
      );
      const report = inspectAsfReferenceComposition(incomplete);
      expect(report.complete).toBe(false);
      expect(report.missingPorts).toContain("workspace");
      expect(() => createAsfReferenceWorkerHostOptions(incomplete)).toThrow(
        AsfReferenceCompositionError,
      );
      expect(test.bind).not.toHaveBeenCalled();
    } finally {
      test.close();
    }
  });

  it("requires the non-authoritative telemetry port", () => {
    const test = fixture();
    try {
      const incomplete = {
        ...test.input,
        telemetry: {},
      } as unknown as AsfReferenceCompositionInput;
      const report = inspectAsfReferenceComposition(incomplete);
      expect(report.complete).toBe(false);
      expect(report.missingPorts).toContain("telemetry");
      expect(() => createAsfReferenceWorkerHostOptions(incomplete)).toThrow(
        AsfReferenceCompositionError,
      );
      expect(test.bind).not.toHaveBeenCalled();
    } finally {
      test.close();
    }
  });

  it("keeps shutdown authoritative when a nonconforming telemetry port throws", async () => {
    const test = fixture();
    try {
      const fail = vi.fn(() => {
        throw new Error("telemetry unavailable");
      });
      const options = createAsfReferenceWorkerHostOptions({
        ...test.input,
        telemetry: {
          span: fail,
          counter: fail,
          histogram: fail,
        },
      });

      await expect(options.service.requestStop()).resolves.toBeUndefined();
      expect(fail).toHaveBeenCalled();
      expect(test.shutdown.stopReconciliation).toHaveBeenCalledTimes(1);
      expect(test.shutdown.retireIdentities).toHaveBeenCalledTimes(1);
      expect(test.shutdown.cleanupResources).toHaveBeenCalledTimes(1);
    } finally {
      test.close();
    }
  });

  it.each([
    ["delivery", "intents", "sealTerminal", "delivery-intents"],
    ["delivery", "recovery", "apply", "recovery"],
    ["delivery", "recoveryDispatch", "dispatch", "recovery-dispatch"],
    ["delivery", "repositoryLease", "acquire", "repository-lease"],
    ["delivery", "identities", "acquireRequiredRoles", "identity-lifecycle"],
    ["delivery", "implementation", "captureProtectedResume", "implementation"],
    ["delivery", "github", "ensurePullRequest", "github-effects"],
    [
      "delivery",
      "terminalEvidence",
      "finalizeTerminal",
      "terminal-evidence-finalization",
    ],
    ["delivery", "budget", "reserve", "provider-budget"],
    ["controls", "reconciliation", "recover", "reconciliation"],
    ["controls", "health", "getHealth", "health"],
    ["shutdown", "shutdown", "retireIdentities", "shutdown-identities"],
  ] as const)(
    "reports stable port %s.%s when %s is missing",
    (container, port, methodName, expected) => {
      const test = fixture();
      try {
        const incomplete =
          container === "shutdown"
            ? ({
                ...test.input,
                shutdown: {
                  ...test.input.shutdown,
                  [methodName]: undefined,
                },
              } as unknown as AsfReferenceCompositionInput)
            : replaceNestedMethod(test.input, container, port, methodName);
        expect(
          inspectAsfReferenceComposition(incomplete).missingPorts,
        ).toContain(expected);
      } finally {
        test.close();
      }
    },
  );

  it("requires the first-party durable StateStore even from a method-shaped object", () => {
    const test = fixture();
    try {
      const forged = {
        ...test.input,
        store: { getAsfRunSnapshot: method() },
      } as unknown as AsfReferenceCompositionInput;
      const report = inspectAsfReferenceComposition(forged);
      expect(report.complete).toBe(false);
      expect(report.missingPorts).toContain("state-store");
      expect(report.reasons).toContain("first-party-state-store-required");
    } finally {
      test.close();
    }
  });

  it.each([
    [
      "production qualification",
      (input: AsfReferenceCompositionInput) => ({
        ...input,
        productionQualified: true,
      }),
    ],
    [
      "classification",
      (input: AsfReferenceCompositionInput) => ({
        ...input,
        classification: "production-composition",
      }),
    ],
    [
      "delivery extra key",
      (input: AsfReferenceCompositionInput) => ({
        ...input,
        delivery: { ...input.delivery, unexpected: method() },
      }),
    ],
    [
      "top-level extra key",
      (input: AsfReferenceCompositionInput) => ({
        ...input,
        unexpected: method(),
      }),
    ],
    [
      "worker dependency override",
      (input: AsfReferenceCompositionInput) => ({
        ...input,
        worker: { ...input.worker, runner: method() },
      }),
    ],
    [
      "host service override",
      (input: AsfReferenceCompositionInput) => ({
        ...input,
        host: { ...input.host, service: {} },
      }),
    ],
    [
      "host unknown option",
      (input: AsfReferenceCompositionInput) => ({
        ...input,
        host: { ...input.host, unexpected: method() },
      }),
    ],
  ] as const)("marks invalid %s metadata/configuration", (_label, mutate) => {
    const test = fixture();
    try {
      const invalid = mutate(
        test.input,
      ) as unknown as AsfReferenceCompositionInput;
      const report = inspectAsfReferenceComposition(invalid);
      expect(report.configurationValid).toBe(false);
      expect(report.complete).toBe(false);
      expect(() => createAsfReferenceWorkerHostOptions(invalid)).toThrow(
        AsfReferenceCompositionError,
      );
    } finally {
      test.close();
    }
  });
});
