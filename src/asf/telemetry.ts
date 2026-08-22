import type { Clock } from "../platform/clock.js";

export const ASF_TELEMETRY_SCHEMA = "runmill.asf-telemetry-signal/v1" as const;

export const ASF_TELEMETRY_SPAN_NAMES = Object.freeze([
  "runmill.asf.service.lifecycle",
  "runmill.asf.work_order.admission",
  "runmill.asf.run.dispatch",
  "runmill.asf.run.outcome",
  "runmill.asf.reconciliation",
  "runmill.asf.cancellation",
  "runmill.asf.identity.lifecycle",
  "runmill.asf.github.delivery",
  "runmill.asf.evidence.finalization",
] as const);

export const ASF_TELEMETRY_COUNTER_NAMES = Object.freeze([
  "runmill.asf.work_orders.accepted",
  "runmill.asf.work_orders.refused",
  "runmill.asf.run.invocations",
  "runmill.asf.recovery.actions",
] as const);

export const ASF_TELEMETRY_HISTOGRAM_NAMES = Object.freeze([
  "runmill.asf.operation.duration",
  "runmill.asf.queue.latency",
] as const);

const COMPONENTS = [
  "service",
  "admission",
  "runner",
  "reconciliation",
  "cancellation",
  "identity",
  "github",
  "evidence",
  "control",
  "health",
  "qualification",
] as const;
const OPERATIONS = [
  "service-lifecycle",
  "work-order-admit",
  "run-dispatch",
  "run-complete",
  "reconcile",
  "cancel",
  "lease-acquire",
  "lease-renew",
  "lease-retire",
  "github-deliver",
  "evidence-finalize",
] as const;
const OUTCOMES = [
  "succeeded",
  "refused",
  "failed",
  "cancelled",
  "recovered",
  "degraded",
] as const;
const REASON_CODES = [
  "invalid-input",
  "policy-denied",
  "dependency-unavailable",
  "timeout",
  "contradictory-state",
  "stale-fence",
  "terminal-state",
  "unknown",
] as const;
const ROLES = ["implementer", "local-reviewer", "pr-reviewer"] as const;
const PROVIDERS = ["claude", "codex"] as const;
const STAGES = [
  "startup",
  "admission",
  "identity",
  "implementation",
  "verification",
  "review",
  "delivery",
  "evidence",
  "cleanup",
  "recovery",
] as const;
const RECOVERY_MODES = [
  "startup",
  "reconcile-only",
  "takeover",
  "process-cold-start",
] as const;
const DISPOSITIONS = [
  "terminal",
  "durable-pause",
  "retry",
  "lease-lost",
  "unexpected-error",
] as const;
const UNITS = ["ms"] as const;

export type AsfTelemetrySpanName = (typeof ASF_TELEMETRY_SPAN_NAMES)[number];
export type AsfTelemetryCounterName =
  (typeof ASF_TELEMETRY_COUNTER_NAMES)[number];
export type AsfTelemetryHistogramName =
  (typeof ASF_TELEMETRY_HISTOGRAM_NAMES)[number];
export type AsfTelemetryUnit = (typeof UNITS)[number];

export interface AsfTelemetryAttributes {
  readonly mode: "asf-worker";
  readonly component?: (typeof COMPONENTS)[number] | undefined;
  readonly operation?: (typeof OPERATIONS)[number] | undefined;
  readonly outcome?: (typeof OUTCOMES)[number] | undefined;
  readonly reason_code?: (typeof REASON_CODES)[number] | undefined;
  readonly role?: (typeof ROLES)[number] | undefined;
  readonly provider?: (typeof PROVIDERS)[number] | undefined;
  readonly stage?: (typeof STAGES)[number] | undefined;
  readonly recovery_mode?: (typeof RECOVERY_MODES)[number] | undefined;
  readonly disposition?: (typeof DISPOSITIONS)[number] | undefined;
}

export type AsfTelemetryAttributeInput = Omit<AsfTelemetryAttributes, "mode">;

const SPAN_SEMANTICS = {
  "runmill.asf.service.lifecycle": {
    component: "service",
    operations: ["service-lifecycle"],
  },
  "runmill.asf.work_order.admission": {
    component: "admission",
    operations: ["work-order-admit"],
  },
  "runmill.asf.run.dispatch": {
    component: "runner",
    operations: ["run-dispatch"],
  },
  "runmill.asf.run.outcome": {
    component: "runner",
    operations: ["run-complete"],
  },
  "runmill.asf.reconciliation": {
    component: "reconciliation",
    operations: ["reconcile"],
  },
  "runmill.asf.cancellation": {
    component: "cancellation",
    operations: ["cancel"],
  },
  "runmill.asf.identity.lifecycle": {
    component: "identity",
    operations: ["lease-acquire", "lease-renew", "lease-retire"],
  },
  "runmill.asf.github.delivery": {
    component: "github",
    operations: ["github-deliver"],
  },
  "runmill.asf.evidence.finalization": {
    component: "evidence",
    operations: ["evidence-finalize"],
  },
} as const;

interface AsfTelemetrySignalBase {
  readonly schema: typeof ASF_TELEMETRY_SCHEMA;
  readonly timestamp: string;
  readonly attributes: AsfTelemetryAttributes;
}

export interface AsfTelemetrySpanSignal extends AsfTelemetrySignalBase {
  readonly kind: "span";
  readonly name: AsfTelemetrySpanName;
  /** Completed operation duration; the monotonic clock origin stays private. */
  readonly duration_ms: number;
}

export interface AsfTelemetryCounterSignal extends AsfTelemetrySignalBase {
  readonly kind: "counter";
  readonly name: AsfTelemetryCounterName;
  readonly value: number;
}

export interface AsfTelemetryHistogramSignal extends AsfTelemetrySignalBase {
  readonly kind: "histogram";
  readonly name: AsfTelemetryHistogramName;
  readonly value: number;
  readonly unit: AsfTelemetryUnit;
}

export type AsfTelemetrySignal =
  | AsfTelemetrySpanSignal
  | AsfTelemetryCounterSignal
  | AsfTelemetryHistogramSignal;

/** Adapter seam for an OpenTelemetry SDK exporter. Signals are non-authoritative. */
export interface AsfTelemetrySink {
  /** Never include content, identifiers, paths, credentials, or capabilities. */
  record(signal: AsfTelemetrySignal): void | Promise<void>;
}

export class NoopAsfTelemetrySink implements AsfTelemetrySink {
  record(_signal: AsfTelemetrySignal): void {}
}

const ATTRIBUTE_VALUES = {
  mode: ["asf-worker"],
  component: COMPONENTS,
  operation: OPERATIONS,
  outcome: OUTCOMES,
  reason_code: REASON_CODES,
  role: ROLES,
  provider: PROVIDERS,
  stage: STAGES,
  recovery_mode: RECOVERY_MODES,
  disposition: DISPOSITIONS,
} as const;
const ATTRIBUTE_KEYS = Object.freeze(Object.keys(ATTRIBUTE_VALUES).sort());

function ownEnumerableDataEntries(
  value: object,
): readonly (readonly [string, unknown])[] | null {
  try {
    const entries: (readonly [string, unknown])[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        return null;
      }
      entries.push([key, descriptor.value]);
    }
    return entries;
  } catch {
    return null;
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const entries = ownEnumerableDataEntries(value);
  return (
    entries !== null &&
    entries
      .map(([key]) => key)
      .sort()
      .join("\u0000") === [...expected].sort().join("\u0000")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function member<T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function validSpanSemantics(
  name: AsfTelemetrySpanName,
  attributes: AsfTelemetryAttributes,
): boolean {
  const semantics = SPAN_SEMANTICS[name];
  return (
    attributes.component === semantics.component &&
    member(semantics.operations, attributes.operation) &&
    attributes.outcome !== undefined
  );
}

function parseAttributes(raw: unknown): AsfTelemetryAttributes | null {
  if (!isRecord(raw)) return null;
  const entries = ownEnumerableDataEntries(raw);
  if (entries === null) return null;
  const keys = entries.map(([key]) => key);
  if (
    !keys.includes("mode") ||
    keys.some((key) => !ATTRIBUTE_KEYS.includes(key))
  ) {
    return null;
  }
  const output: Record<string, string> = {};
  for (const [key, value] of entries) {
    try {
      const values = ATTRIBUTE_VALUES[key as keyof typeof ATTRIBUTE_VALUES];
      if (values === undefined || !member(values, value)) return null;
      output[key] = value;
    } catch {
      return null;
    }
  }
  return Object.freeze(output) as unknown as AsfTelemetryAttributes;
}

function buildAttributes(raw: unknown): AsfTelemetryAttributes | null {
  if (!isRecord(raw)) return null;
  const entries = ownEnumerableDataEntries(raw);
  if (entries === null) return null;
  const output: Record<string, string> = { mode: "asf-worker" };
  for (const [key, value] of entries) {
    if (key === "mode" || !ATTRIBUTE_KEYS.includes(key)) return null;
    const values = ATTRIBUTE_VALUES[key as keyof typeof ATTRIBUTE_VALUES];
    if (values === undefined || !member(values, value)) return null;
    output[key] = value;
  }
  return Object.freeze(output) as unknown as AsfTelemetryAttributes;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** Strictly parse and freeze one signal. Unknown fields or values return null. */
export function parseAsfTelemetrySignal(
  raw: unknown,
): AsfTelemetrySignal | null {
  try {
    if (!isRecord(raw)) return null;
    const rawEntries = ownEnumerableDataEntries(raw);
    if (rawEntries === null) return null;
    const snapshot = Object.freeze(Object.fromEntries(rawEntries));
    const schema = snapshot["schema"];
    const kind = snapshot["kind"];
    const timestamp = snapshot["timestamp"];
    const attributes = parseAttributes(snapshot["attributes"]);
    if (
      schema !== ASF_TELEMETRY_SCHEMA ||
      attributes === null ||
      !canonicalTimestamp(timestamp)
    ) {
      return null;
    }
    if (kind === "span") {
      const name = snapshot["name"];
      const durationMs = snapshot["duration_ms"];
      if (
        !exactKeys(snapshot, [
          "schema",
          "kind",
          "name",
          "timestamp",
          "duration_ms",
          "attributes",
        ]) ||
        !member(ASF_TELEMETRY_SPAN_NAMES, name) ||
        !validSpanSemantics(name, attributes) ||
        typeof durationMs !== "number" ||
        !Number.isFinite(durationMs) ||
        durationMs < 0
      ) {
        return null;
      }
      return Object.freeze({
        schema: ASF_TELEMETRY_SCHEMA,
        kind: "span",
        name,
        timestamp,
        duration_ms: durationMs,
        attributes,
      });
    }
    if (kind === "counter") {
      const name = snapshot["name"];
      const value = snapshot["value"];
      if (
        !exactKeys(snapshot, [
          "schema",
          "kind",
          "name",
          "value",
          "timestamp",
          "attributes",
        ]) ||
        !member(ASF_TELEMETRY_COUNTER_NAMES, name) ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value <= 0
      ) {
        return null;
      }
      return Object.freeze({
        schema: ASF_TELEMETRY_SCHEMA,
        kind: "counter",
        name,
        value,
        timestamp,
        attributes,
      });
    }
    if (kind === "histogram") {
      const name = snapshot["name"];
      const value = snapshot["value"];
      const unit = snapshot["unit"];
      if (
        !exactKeys(snapshot, [
          "schema",
          "kind",
          "name",
          "value",
          "unit",
          "timestamp",
          "attributes",
        ]) ||
        !member(ASF_TELEMETRY_HISTOGRAM_NAMES, name) ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        !member(UNITS, unit) ||
        unit !== "ms"
      ) {
        return null;
      }
      return Object.freeze({
        schema: ASF_TELEMETRY_SCHEMA,
        kind: "histogram",
        name,
        value,
        unit,
        timestamp,
        attributes,
      });
    }
  } catch {
    return null;
  }
  return null;
}

export interface SafeAsfTelemetryRecorderOptions {
  readonly clock: Clock;
  readonly sink: AsfTelemetrySink;
}

export interface AsfTelemetryRecorder {
  /** Emit one independently mappable, completed OpenTelemetry span. */
  span(
    name: AsfTelemetrySpanName,
    durationMs: number,
    attributes?: AsfTelemetryAttributeInput,
  ): void;
  counter(
    name: AsfTelemetryCounterName,
    value: number,
    attributes?: AsfTelemetryAttributeInput,
  ): void;
  histogram(
    name: AsfTelemetryHistogramName,
    value: number,
    unit: AsfTelemetryUnit,
    attributes?: AsfTelemetryAttributeInput,
  ): void;
}

/**
 * Non-authoritative ASF recorder. It maps to an OTel exporter through the
 * sink, but sink failures can never influence policy, readiness, state, or
 * side effects. Content and controller capabilities are outside this API.
 */
export class SafeAsfTelemetryRecorder implements AsfTelemetryRecorder {
  readonly #clock: Clock;
  readonly #sink: AsfTelemetrySink;

  constructor(options: SafeAsfTelemetryRecorderOptions) {
    this.#clock = options.clock;
    this.#sink = options.sink;
  }

  span(
    name: AsfTelemetrySpanName,
    durationMs: number,
    attributes: AsfTelemetryAttributeInput = {},
  ): void {
    this.#record({ kind: "span", name, duration_ms: durationMs, attributes });
  }

  counter(
    name: AsfTelemetryCounterName,
    value: number,
    attributes: AsfTelemetryAttributeInput = {},
  ): void {
    this.#record({ kind: "counter", name, value, attributes });
  }

  histogram(
    name: AsfTelemetryHistogramName,
    value: number,
    unit: AsfTelemetryUnit,
    attributes: AsfTelemetryAttributeInput = {},
  ): void {
    this.#record({ kind: "histogram", name, value, unit, attributes });
  }

  #record(input: Record<string, unknown>): void {
    try {
      const timestamp = this.#clock.now().toISOString();
      const attributes = buildAttributes(input.attributes);
      if (attributes === null) return;
      const signal = parseAsfTelemetrySignal({
        schema: ASF_TELEMETRY_SCHEMA,
        ...input,
        timestamp,
        attributes,
      });
      if (signal === null) return;
      const result = this.#sink.record(signal);
      if (result !== undefined)
        void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Telemetry never becomes authority or changes the worker outcome.
    }
  }
}

/** Create a frozen recorder whose validated signals are intentionally discarded. */
export function createNoopAsfTelemetryRecorder(
  clock: Clock,
): Readonly<SafeAsfTelemetryRecorder> {
  return Object.freeze(
    new SafeAsfTelemetryRecorder({
      clock,
      sink: Object.freeze(new NoopAsfTelemetrySink()),
    }),
  );
}
