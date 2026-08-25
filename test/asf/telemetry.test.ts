import { describe, expect, it } from "vitest";
import {
  ASF_TELEMETRY_COUNTER_NAMES,
  ASF_TELEMETRY_GAUGE_NAMES,
  ASF_TELEMETRY_HISTOGRAM_NAMES,
  ASF_TELEMETRY_LOG_NAMES,
  ASF_TELEMETRY_SCHEMA,
  ASF_TELEMETRY_SPAN_NAMES,
  OtlpHttpAsfTelemetrySink,
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
    expect(ASF_TELEMETRY_COUNTER_NAMES).toEqual([
      "runmill.asf.work_orders.accepted",
      "runmill.asf.work_orders.refused",
      "runmill.asf.run.invocations",
      "runmill.asf.recovery.actions",
      "runmill.asf.identity.leases",
      "runmill.asf.stale_fence.rejections",
      "runmill.asf.effects.ambiguous",
      "runmill.asf.evidence.acknowledgements",
      "runmill.asf.cleanup.failures",
      "runmill.asf.quarantines",
    ]);
    expect(ASF_TELEMETRY_HISTOGRAM_NAMES).toEqual([
      "runmill.asf.operation.duration",
      "runmill.asf.queue.latency",
      "runmill.asf.recovery.duration",
      "runmill.asf.reconciliation.continuation_lag",
      "runmill.asf.evidence.acknowledgement_lag",
    ]);
    expect(ASF_TELEMETRY_LOG_NAMES).toEqual([
      "runmill.asf.service.event",
      "runmill.asf.run.event",
      "runmill.asf.recovery.event",
      "runmill.asf.security.event",
    ]);
    expect(ASF_TELEMETRY_GAUGE_NAMES).toEqual([
      "runmill.asf.queue.depth",
      "runmill.asf.run.active",
    ]);
    expect(Object.isFrozen(ASF_TELEMETRY_SPAN_NAMES)).toBe(true);
    expect(Object.isFrozen(ASF_TELEMETRY_COUNTER_NAMES)).toBe(true);
    expect(Object.isFrozen(ASF_TELEMETRY_GAUGE_NAMES)).toBe(true);
    expect(Object.isFrozen(ASF_TELEMETRY_HISTOGRAM_NAMES)).toBe(true);
    expect(Object.isFrozen(ASF_TELEMETRY_LOG_NAMES)).toBe(true);
  });

  it("emits exact frozen span, counter, gauge, and histogram signals", () => {
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
    recorder.gauge("runmill.asf.queue.depth", 2, { component: "runner" });
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
        kind: "gauge",
        name: "runmill.asf.queue.depth",
        value: 2,
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

  it("rejects invalid point-in-time gauge values", () => {
    const base = {
      schema: ASF_TELEMETRY_SCHEMA,
      kind: "gauge",
      name: "runmill.asf.queue.depth",
      value: 0,
      timestamp: NOW,
      attributes: { mode: "asf-worker", component: "runner" },
    };
    expect(parseAsfTelemetrySignal(base)).not.toBeNull();
    expect(parseAsfTelemetrySignal({ ...base, value: -1 })).toBeNull();
    expect(parseAsfTelemetrySignal({ ...base, value: Number.NaN })).toBeNull();
    expect(parseAsfTelemetrySignal({ ...base, name: "runmill.asf.unknown" })).toBeNull();
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

  it("accepts only bounded non-secret correlation identifiers", () => {
    const base = {
      schema: ASF_TELEMETRY_SCHEMA,
      kind: "counter",
      name: "runmill.asf.run.invocations",
      value: 1,
      timestamp: NOW,
      attributes: {
        mode: "asf-worker",
        tenant_id: "tenant-acme",
        work_order_id: "wo_01",
        attempt_id: "attempt_01",
        run_id: "run_01",
        invocation_id: "invocation_01",
        candidate_sha: `sha256:${"a".repeat(64)}`,
      },
    };
    expect(parseAsfTelemetrySignal(base)).not.toBeNull();
    expect(
      parseAsfTelemetrySignal({
        ...base,
        attributes: { ...base.attributes, candidate_sha: "candidate-bytes" },
      }),
    ).toBeNull();
    expect(
      parseAsfTelemetrySignal({
        ...base,
        attributes: { ...base.attributes, run_id: "../secret" },
      }),
    ).toBeNull();
    expect(
      parseAsfTelemetrySignal({
        ...base,
        attributes: { ...base.attributes, prompt: "never-accepted" },
      }),
    ).toBeNull();
  });

  it("accepts only closed structured log events", () => {
    const base = {
      schema: ASF_TELEMETRY_SCHEMA,
      kind: "log",
      name: "runmill.asf.run.event",
      severity: "error",
      timestamp: NOW,
      attributes: {
        mode: "asf-worker",
        run_id: "run_01",
      },
    };
    expect(parseAsfTelemetrySignal(base)).toMatchObject({
      kind: "log",
      name: "runmill.asf.run.event",
      severity: "error",
    });
    expect(parseAsfTelemetrySignal({ ...base, name: "runmill.asf.free-form" })).toBeNull();
    expect(parseAsfTelemetrySignal({ ...base, message: "secret" })).toBeNull();
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
    expect(() => recorder.gauge("runmill.asf.queue.depth", 0)).not.toThrow();
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

describe("OTLP/HTTP telemetry adapter", () => {
  it("maps completed spans and metrics to standard OTLP JSON envelopes", async () => {
    const requests: { url: string; request: { body: string; headers: Readonly<Record<string, string>> } }[] = [];
    const sink = new OtlpHttpAsfTelemetrySink({
      endpoint: "https://otel.example.invalid/otlp/v1/traces",
      headers: { Authorization: "Bearer operator-configured-token" },
      httpClient: async (url, request) => {
        requests.push({ url, request });
        return { ok: true, status: 200 };
      },
    });

    await sink.record({
      schema: ASF_TELEMETRY_SCHEMA,
      kind: "span",
      name: "runmill.asf.run.dispatch",
      timestamp: NOW,
      duration_ms: 12.5,
      attributes: {
        mode: "asf-worker",
        component: "runner",
        operation: "run-dispatch",
        outcome: "succeeded",
      },
    });
    await sink.record({
      schema: ASF_TELEMETRY_SCHEMA,
      kind: "counter",
      name: "runmill.asf.run.invocations",
      timestamp: NOW,
      value: 1,
      attributes: { mode: "asf-worker", component: "runner", outcome: "succeeded" },
    });
    await sink.record({
      schema: ASF_TELEMETRY_SCHEMA,
      kind: "gauge",
      name: "runmill.asf.queue.depth",
      timestamp: NOW,
      value: 2,
      attributes: { mode: "asf-worker", component: "runner" },
    });
    await sink.record({
      schema: ASF_TELEMETRY_SCHEMA,
      kind: "log",
      name: "runmill.asf.run.event",
      severity: "error",
      timestamp: NOW,
      attributes: { mode: "asf-worker", run_id: "run_01" },
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://otel.example.invalid/otlp/v1/traces",
      "https://otel.example.invalid/otlp/v1/metrics",
      "https://otel.example.invalid/otlp/v1/metrics",
      "https://otel.example.invalid/otlp/v1/logs",
    ]);
    expect(requests[0]?.request.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer operator-configured-token",
    });
    const spanEnvelope = JSON.parse(requests[0]?.request.body ?? "null") as {
      resourceSpans?: readonly {
        scopeSpans?: readonly { spans?: readonly Record<string, unknown>[] }[];
      }[];
    };
    const span = spanEnvelope.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
    expect(span).toMatchObject({ name: "runmill.asf.run.dispatch", kind: 1 });
    if (span === undefined) throw new Error("OTLP span envelope is missing its span");
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/u);
    expect(span.attributes).toEqual(
      expect.arrayContaining([
        { key: "mode", value: { stringValue: "asf-worker" } },
        { key: "outcome", value: { stringValue: "succeeded" } },
      ]),
    );
    const metricEnvelope = JSON.parse(requests[1]?.request.body ?? "null") as {
      resourceMetrics?: readonly {
        scopeMetrics?: readonly { metrics?: readonly Record<string, unknown>[] }[];
      }[];
    };
    expect(metricEnvelope.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics?.[0]).toMatchObject({
      name: "runmill.asf.run.invocations",
      sum: { dataPoints: [{ asDouble: 1 }], aggregationTemporality: 2, isMonotonic: true },
    });
    const gaugeEnvelope = JSON.parse(requests[2]?.request.body ?? "null") as {
      resourceMetrics?: readonly {
        scopeMetrics?: readonly { metrics?: readonly Record<string, unknown>[] }[];
      }[];
    };
    expect(gaugeEnvelope.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics?.[0]).toMatchObject({
      name: "runmill.asf.queue.depth",
      gauge: { dataPoints: [{ asDouble: 2 }] },
    });
    const logEnvelope = JSON.parse(requests[3]?.request.body ?? "null") as {
      resourceLogs?: readonly {
        scopeLogs?: readonly { logRecords?: readonly Record<string, unknown>[] }[];
      }[];
    };
    expect(logEnvelope.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0]).toMatchObject({
      severityText: "ERROR",
      body: { stringValue: "runmill.asf.run.event" },
      attributes: expect.arrayContaining([
        { key: "run_id", value: { stringValue: "run_01" } },
      ]),
    });
    expect(sink.health()).toEqual({
      schema: "runmill.asf-otlp-http-telemetry-health/v1",
      status: "healthy",
      consecutiveFailures: 0,
      lastSuccessAt: NOW,
    });
  });

  it("tracks exporter failures without exposing response bodies or changing recorder authority", async () => {
    const sink = new OtlpHttpAsfTelemetrySink({
      endpoint: "http://127.0.0.1:4318",
      httpClient: async () => ({ ok: false, status: 503 }),
    });
    expect(sink.health().status).toBe("unknown");
    await expect(
      sink.record({
        schema: ASF_TELEMETRY_SCHEMA,
        kind: "histogram",
        name: "runmill.asf.queue.latency",
        timestamp: NOW,
        value: 4,
        unit: "ms",
        attributes: { mode: "asf-worker" },
      }),
    ).rejects.toThrow("HTTP 503");
    expect(sink.health()).toMatchObject({
      status: "degraded",
      consecutiveFailures: 1,
      lastSuccessAt: null,
    });
  });

  it.each([
    "file:///tmp/otel",
    "https://user:password@otel.example.invalid",
    "https://otel.example.invalid?token=secret",
    "not a url",
  ])("rejects unsafe OTLP endpoint %s", (endpoint) => {
    expect(() => new OtlpHttpAsfTelemetrySink({ endpoint })).toThrow(
      "OTLP endpoint",
    );
  });
});
