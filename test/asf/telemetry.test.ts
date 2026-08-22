import { describe, expect, it } from "vitest";
import {
  ASF_TELEMETRY_COUNTER_NAMES,
  ASF_TELEMETRY_HISTOGRAM_NAMES,
  ASF_TELEMETRY_SCHEMA,
  ASF_TELEMETRY_SPAN_NAMES,
  SafeAsfTelemetryRecorder,
  createNoopAsfTelemetryRecorder,
  parseAsfTelemetrySignal,
  type AsfTelemetrySignal,
  type AsfTelemetrySink,
} from "../../src/asf/telemetry.js";
import type { Clock } from "../../src/platform/clock.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const NOW = "2026-08-21T10:00:00.000Z";

class RecordingSink implements AsfTelemetrySink {
  readonly signals: AsfTelemetrySignal[] = [];

  record(signal: AsfTelemetrySignal): void {
    this.signals.push(signal);
  }
}

function validCounter(): Record<string, unknown> {
  return {
    schema: ASF_TELEMETRY_SCHEMA,
    kind: "counter",
    name: "runmill.asf.work_orders.accepted",
    value: 1,
    timestamp: NOW,
    attributes: {
      mode: "asf-worker",
      component: "admission",
      operation: "work-order-admit",
      outcome: "succeeded",
    },
  };
}

describe("ASF telemetry contract", () => {
  it("exports an immutable, versioned catalog for the initial worker-kernel subset", () => {
    expect(ASF_TELEMETRY_SPAN_NAMES).toEqual([
      "runmill.asf.service.lifecycle",
      "runmill.asf.work_order.admission",
      "runmill.asf.run.dispatch",
      "runmill.asf.run.outcome",
      "runmill.asf.reconciliation",
      "runmill.asf.cancellation",
      "runmill.asf.identity.lifecycle",
      "runmill.asf.github.delivery",
      "runmill.asf.evidence.finalization",
    ]);
    expect(ASF_TELEMETRY_COUNTER_NAMES).toContain(
      "runmill.asf.recovery.actions",
    );
    expect(ASF_TELEMETRY_HISTOGRAM_NAMES).toEqual([
      "runmill.asf.operation.duration",
      "runmill.asf.queue.latency",
    ]);
    expect(Object.isFrozen(ASF_TELEMETRY_SPAN_NAMES)).toBe(true);
    expect(Object.isFrozen(ASF_TELEMETRY_COUNTER_NAMES)).toBe(true);
    expect(Object.isFrozen(ASF_TELEMETRY_HISTOGRAM_NAMES)).toBe(true);
  });

  it("emits exact frozen span, counter, and histogram signals", () => {
    const sink = new RecordingSink();
    const recorder = new SafeAsfTelemetryRecorder({
      clock: new FakeClock(NOW),
      sink,
    });

    recorder.span("runmill.asf.service.lifecycle", 42, {
      component: "service",
      operation: "service-lifecycle",
      outcome: "succeeded",
    });
    recorder.counter("runmill.asf.work_orders.accepted", 1, {
      component: "admission",
      outcome: "succeeded",
    });
    recorder.histogram("runmill.asf.operation.duration", 12.5, "ms", {
      component: "runner",
      operation: "run-complete",
      outcome: "succeeded",
    });

    expect(sink.signals).toEqual([
      {
        schema: ASF_TELEMETRY_SCHEMA,
        kind: "span",
        name: "runmill.asf.service.lifecycle",
        timestamp: NOW,
        duration_ms: 42,
        attributes: {
          mode: "asf-worker",
          component: "service",
          operation: "service-lifecycle",
          outcome: "succeeded",
        },
      },
      expect.objectContaining({
        kind: "counter",
        name: "runmill.asf.work_orders.accepted",
        value: 1,
      }),
      expect.objectContaining({
        kind: "histogram",
        name: "runmill.asf.operation.duration",
        value: 12.5,
        unit: "ms",
      }),
    ]);
    for (const signal of sink.signals) {
      expect(Object.isFrozen(signal)).toBe(true);
      expect(Object.isFrozen(signal.attributes)).toBe(true);
    }
  });

  it.each([
    ["unknown signal field", { extra: true }],
    ["unknown metric name", { name: "runmill.asf.user_supplied" }],
    ["zero counter", { value: 0 }],
    ["negative counter", { value: -1 }],
    ["non-finite counter", { value: Number.POSITIVE_INFINITY }],
    ["invalid timestamp", { timestamp: "2026-08-21T10:00:00Z" }],
  ])("rejects %s", (_label, mutation) => {
    expect(
      parseAsfTelemetrySignal({ ...validCounter(), ...mutation }),
    ).toBeNull();
  });

  it.each([
    ["unknown", "value"],
    ["run_id", "run-secret"],
    ["work_order_id", "wo-secret"],
    ["candidate_sha", "a".repeat(40)],
    ["lease_id", "lease-secret"],
    ["execution_handle", "exec-secret"],
    ["path", "/protected/path"],
    ["prompt", "repository content"],
    ["error", "provider response"],
    ["url", "https://example.invalid/private"],
  ])("rejects forbidden or unknown attribute %s", (key, value) => {
    const signal = validCounter();
    signal.attributes = {
      ...(signal.attributes as object),
      [key]: value,
    };
    expect(parseAsfTelemetrySignal(signal)).toBeNull();
  });

  it("rejects invalid histogram values and units", () => {
    const base = {
      schema: ASF_TELEMETRY_SCHEMA,
      kind: "histogram",
      name: "runmill.asf.queue.latency",
      value: 0,
      unit: "ms",
      timestamp: NOW,
      attributes: { mode: "asf-worker" },
    };
    expect(parseAsfTelemetrySignal(base)).not.toBeNull();
    expect(parseAsfTelemetrySignal({ ...base, value: -0.1 })).toBeNull();
    expect(parseAsfTelemetrySignal({ ...base, value: Number.NaN })).toBeNull();
    expect(parseAsfTelemetrySignal({ ...base, unit: "bytes" })).toBeNull();
    expect(parseAsfTelemetrySignal({ ...base, unit: "s" })).toBeNull();
  });

  it("rejects invalid completed-span durations and legacy phase records", () => {
    const base = {
      schema: ASF_TELEMETRY_SCHEMA,
      kind: "span",
      name: "runmill.asf.run.dispatch",
      duration_ms: 0,
      timestamp: NOW,
      attributes: {
        mode: "asf-worker",
        component: "runner",
        operation: "run-dispatch",
        outcome: "succeeded",
        disposition: "terminal",
      },
    };
    expect(parseAsfTelemetrySignal(base)).not.toBeNull();
    expect(parseAsfTelemetrySignal({ ...base, duration_ms: -1 })).toBeNull();
    expect(
      parseAsfTelemetrySignal({ ...base, duration_ms: Number.NaN }),
    ).toBeNull();
    expect(parseAsfTelemetrySignal({ ...base, phase: "start" })).toBeNull();
    expect(
      parseAsfTelemetrySignal({
        ...base,
        attributes: { ...base.attributes, outcome: "started" },
      }),
    ).toBeNull();
    expect(
      parseAsfTelemetrySignal({
        ...base,
        attributes: { ...base.attributes, component: "github" },
      }),
    ).toBeNull();
  });

  it("snapshots signal data without invoking property getters", () => {
    let reads = 0;
    const signal = new Proxy(validCounter(), {
      get: () => {
        reads += 1;
        throw new Error("property reads are forbidden");
      },
    });

    expect(parseAsfTelemetrySignal(signal)).not.toBeNull();
    expect(reads).toBe(0);
  });

  it("drops getter-bearing attributes without invoking the sink", () => {
    const sink = new RecordingSink();
    const recorder = new SafeAsfTelemetryRecorder({
      clock: new FakeClock(NOW),
      sink,
    });
    const attributes = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(attributes, "component", {
      enumerable: true,
      get: () => {
        throw new Error("hostile getter");
      },
    });

    expect(() =>
      recorder.counter(
        "runmill.asf.work_orders.accepted",
        1,
        attributes as never,
      ),
    ).not.toThrow();
    expect(sink.signals).toEqual([]);
  });

  it("rejects accessors and non-enumerable signal fields without reading them", () => {
    let reads = 0;
    const getterSignal = validCounter();
    Object.defineProperty(getterSignal, "value", {
      enumerable: true,
      get: () => {
        reads += 1;
        return 1;
      },
    });
    const hiddenSignal = validCounter();
    Object.defineProperty(hiddenSignal, "hidden", {
      enumerable: false,
      value: "not allowed",
    });

    expect(parseAsfTelemetrySignal(getterSignal)).toBeNull();
    expect(reads).toBe(0);
    expect(parseAsfTelemetrySignal(hiddenSignal)).toBeNull();
  });

  it("drops benign attribute getters without reading them", () => {
    let reads = 0;
    const sink = new RecordingSink();
    const recorder = new SafeAsfTelemetryRecorder({
      clock: new FakeClock(NOW),
      sink,
    });
    const attributes = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(attributes, "component", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "admission";
      },
    });

    recorder.counter("runmill.asf.work_orders.accepted", 1, attributes);
    expect(reads).toBe(0);
    expect(sink.signals).toEqual([]);
  });

  it("swallows synchronous and asynchronous sink failures", async () => {
    const clock = new FakeClock(NOW);
    let synchronousCalls = 0;
    const synchronous = new SafeAsfTelemetryRecorder({
      clock,
      sink: {
        record: () => {
          synchronousCalls += 1;
          throw new Error("exporter unavailable");
        },
      },
    });
    let asynchronousCalls = 0;
    const asynchronous = new SafeAsfTelemetryRecorder({
      clock,
      sink: {
        record: () => {
          asynchronousCalls += 1;
          return Promise.reject(new Error("exporter unavailable"));
        },
      },
    });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      expect(() =>
        synchronous.span("runmill.asf.run.outcome", 10, {
          component: "runner",
          operation: "run-complete",
          outcome: "failed",
        }),
      ).not.toThrow();
      expect(synchronousCalls).toBe(1);
      expect(() =>
        asynchronous.counter("runmill.asf.run.invocations", 1, {
          component: "runner",
          outcome: "failed",
        }),
      ).not.toThrow();
      expect(asynchronousCalls).toBe(1);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
    expect(unhandledRejections).toEqual([]);
  });

  it("silently drops signals from invalid clocks", () => {
    const sink = new RecordingSink();
    const invalidClock: Clock = {
      now: () => new Date(Number.NaN),
      monotonicMs: () => Number.NaN,
    };
    const recorder = new SafeAsfTelemetryRecorder({
      clock: invalidClock,
      sink,
    });

    expect(() =>
      recorder.span("runmill.asf.service.lifecycle", 1),
    ).not.toThrow();
    expect(() =>
      recorder.counter("runmill.asf.run.invocations", 1),
    ).not.toThrow();
    expect(sink.signals).toEqual([]);
  });

  it("returns a frozen no-op recorder", () => {
    const recorder = createNoopAsfTelemetryRecorder(new FakeClock(NOW));
    expect(Object.isFrozen(recorder)).toBe(true);
    expect(() =>
      recorder.histogram("runmill.asf.queue.latency", 0, "ms"),
    ).not.toThrow();
  });
});
