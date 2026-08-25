import { randomBytes } from "node:crypto";
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
  "runmill.asf.identity.leases",
  "runmill.asf.stale_fence.rejections",
  "runmill.asf.effects.ambiguous",
  "runmill.asf.evidence.acknowledgements",
  "runmill.asf.cleanup.failures",
  "runmill.asf.quarantines",
] as const);

/** Point-in-time worker state metrics. These are gauges, not monotonic sums. */
export const ASF_TELEMETRY_GAUGE_NAMES = Object.freeze([
  "runmill.asf.queue.depth",
  "runmill.asf.run.active",
] as const);

export const ASF_TELEMETRY_HISTOGRAM_NAMES = Object.freeze([
  "runmill.asf.operation.duration",
  "runmill.asf.queue.latency",
  "runmill.asf.recovery.duration",
  "runmill.asf.reconciliation.continuation_lag",
  "runmill.asf.evidence.acknowledgement_lag",
] as const);
export const ASF_TELEMETRY_LOG_NAMES = Object.freeze([
  "runmill.asf.service.event",
  "runmill.asf.run.event",
  "runmill.asf.recovery.event",
  "runmill.asf.security.event",
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
const LOG_SEVERITIES = ["info", "warn", "error"] as const;
const CORRELATION_KEYS = [
  "tenant_id",
  "work_order_id",
  "attempt_id",
  "run_id",
  "invocation_id",
  "candidate_sha",
] as const;
const SAFE_CORRELATION_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$(?![\s\S])/u;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$(?![\s\S])/u;

export type AsfTelemetrySpanName = (typeof ASF_TELEMETRY_SPAN_NAMES)[number];
export type AsfTelemetryCounterName =
  (typeof ASF_TELEMETRY_COUNTER_NAMES)[number];
export type AsfTelemetryGaugeName = (typeof ASF_TELEMETRY_GAUGE_NAMES)[number];
export type AsfTelemetryHistogramName =
  (typeof ASF_TELEMETRY_HISTOGRAM_NAMES)[number];
export type AsfTelemetryLogName = (typeof ASF_TELEMETRY_LOG_NAMES)[number];
export type AsfTelemetryLogSeverity = (typeof LOG_SEVERITIES)[number];
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
  /** Non-secret, bounded identifiers used to correlate one attempt. */
  readonly tenant_id?: string | undefined;
  readonly work_order_id?: string | undefined;
  readonly attempt_id?: string | undefined;
  readonly run_id?: string | undefined;
  readonly invocation_id?: string | undefined;
  /** Candidate content is represented only by its canonical SHA-256 digest. */
  readonly candidate_sha?: string | undefined;
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

export interface AsfTelemetryGaugeSignal extends AsfTelemetrySignalBase {
  readonly kind: "gauge";
  readonly name: AsfTelemetryGaugeName;
  readonly value: number;
}

export interface AsfTelemetryHistogramSignal extends AsfTelemetrySignalBase {
  readonly kind: "histogram";
  readonly name: AsfTelemetryHistogramName;
  readonly value: number;
  readonly unit: AsfTelemetryUnit;
}

/** Structured operational event; the event name is the complete log body. */
export interface AsfTelemetryLogSignal extends AsfTelemetrySignalBase {
  readonly kind: "log";
  readonly name: AsfTelemetryLogName;
  readonly severity: AsfTelemetryLogSeverity;
}

export type AsfTelemetrySignal =
  | AsfTelemetrySpanSignal
  | AsfTelemetryCounterSignal
  | AsfTelemetryGaugeSignal
  | AsfTelemetryHistogramSignal
  | AsfTelemetryLogSignal;

/** Adapter seam for an OpenTelemetry SDK exporter. Signals are non-authoritative. */
export interface AsfTelemetrySink {
  /** Never include content, identifiers, paths, credentials, or capabilities. */
  record(signal: AsfTelemetrySignal): void | Promise<void>;
}

export const ASF_OTLP_HTTP_TELEMETRY_HEALTH_SCHEMA =
  "runmill.asf-otlp-http-telemetry-health/v1" as const;

export interface AsfTelemetryHealth {
  readonly schema: typeof ASF_OTLP_HTTP_TELEMETRY_HEALTH_SCHEMA;
  readonly status: "unknown" | "healthy" | "degraded";
  readonly consecutiveFailures: number;
  readonly lastSuccessAt: string | null;
}

export interface AsfTelemetryHttpRequest {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface AsfTelemetryHttpResponse {
  readonly ok: boolean;
  readonly status: number;
}

/** Injectable transport used by the OTLP adapter, keeping network I/O testable. */
export type AsfTelemetryHttpClient = (
  url: string,
  request: AsfTelemetryHttpRequest,
) => Promise<AsfTelemetryHttpResponse>;

export interface OtlpHttpAsfTelemetrySinkOptions {
  /** OTLP/HTTP base URL, or a URL ending in `/v1/traces`, `/v1/metrics`, or `/v1/logs`. */
  readonly endpoint: string;
  /** Additional exporter headers (for example, an operator-managed auth header). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly httpClient?: AsfTelemetryHttpClient;
}

export class AsfTelemetryConfigurationError extends Error {
  readonly code = "INVALID_ASF_TELEMETRY_CONFIGURATION" as const;

  constructor(message: string) {
    super(message);
    this.name = "AsfTelemetryConfigurationError";
  }
}

const DEFAULT_OTLP_TIMEOUT_MS = 5_000;
const MAX_OTLP_TIMEOUT_MS = 60_000;
const MAX_OTLP_ENDPOINT_LENGTH = 2_048;
const MAX_OTLP_HEADER_VALUE_LENGTH = 4_096;
const MAX_OTLP_FAILURES = 100_000;

function defaultAsfTelemetryHttpClient(
  url: string,
  request: AsfTelemetryHttpRequest,
): Promise<AsfTelemetryHttpResponse> {
  return globalThis
    .fetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    })
    .then((response) => ({ ok: response.ok, status: response.status }));
}

function validateOtlpHeaders(
  raw: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (raw === undefined) return Object.freeze({ "content-type": "application/json" });
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype
  ) {
    throw new AsfTelemetryConfigurationError("OTLP headers must be a plain object");
  }
  const output: Record<string, string> = { "content-type": "application/json" };
  for (const [key, value] of Object.entries(raw)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key) ||
      key.length > 128 ||
      typeof value !== "string" ||
      value.length > MAX_OTLP_HEADER_VALUE_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new AsfTelemetryConfigurationError("OTLP headers contain an invalid field");
    }
    output[key.toLowerCase()] = value;
  }
  return Object.freeze(output);
}

function otlpEndpoints(raw: string): { traces: string; metrics: string; logs: string } {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_OTLP_ENDPOINT_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(raw)
  ) {
    throw new AsfTelemetryConfigurationError("OTLP endpoint is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AsfTelemetryConfigurationError("OTLP endpoint is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new AsfTelemetryConfigurationError("OTLP endpoint must be an http(s) URL without credentials");
  }
  const suffix = parsed.pathname.replace(/\/+$/u, "");
  const basePath =
    suffix.endsWith("/v1/traces") ||
    suffix.endsWith("/v1/metrics") ||
    suffix.endsWith("/v1/logs")
    ? suffix.slice(0, suffix.lastIndexOf("/v1/"))
    : suffix;
  const base = `${parsed.origin}${basePath === "" ? "" : basePath}`;
  return {
    traces: `${base}/v1/traces`,
    metrics: `${base}/v1/metrics`,
    logs: `${base}/v1/logs`,
  };
}

function otlpAttribute(key: string, value: string): Record<string, unknown> {
  return { key, value: { stringValue: value } };
}

function otlpAttributes(
  attributes: AsfTelemetryAttributes,
): readonly Record<string, unknown>[] {
  return Object.entries(attributes).map(([key, value]) => otlpAttribute(key, value));
}

function unixNanosFromMilliseconds(milliseconds: number): string {
  const whole = Math.trunc(milliseconds);
  const fractionNanos = Math.round((milliseconds - whole) * 1_000_000);
  return (BigInt(whole) * 1_000_000n + BigInt(fractionNanos)).toString();
}

function signalUnixNanos(signal: AsfTelemetrySignal): string {
  return unixNanosFromMilliseconds(Date.parse(signal.timestamp));
}

function spanPayload(signal: AsfTelemetrySpanSignal): Record<string, unknown> {
  const endMs = Date.parse(signal.timestamp);
  const startMs = Math.max(0, endMs - Math.min(signal.duration_ms, endMs));
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            otlpAttribute("service.name", "runmill"),
            otlpAttribute("service.namespace", "asf"),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "runmill.asf", version: "1" },
            spans: [
              {
                traceId: randomBytes(16).toString("hex"),
                spanId: randomBytes(8).toString("hex"),
                name: signal.name,
                kind: 1,
                startTimeUnixNano: unixNanosFromMilliseconds(startMs),
                endTimeUnixNano: unixNanosFromMilliseconds(endMs),
                attributes: otlpAttributes(signal.attributes),
              },
            ],
          },
        ],
      },
    ],
  };
}

function metricPayload(
  signal:
    | AsfTelemetryCounterSignal
    | AsfTelemetryGaugeSignal
    | AsfTelemetryHistogramSignal,
): Record<string, unknown> {
  const dataPoint = {
    attributes: otlpAttributes(signal.attributes),
    timeUnixNano: signalUnixNanos(signal),
  };
  const metric =
    signal.kind === "counter"
      ? {
          name: signal.name,
          sum: {
            dataPoints: [{ ...dataPoint, asDouble: signal.value }],
            aggregationTemporality: 2,
            isMonotonic: true,
          },
        }
      : signal.kind === "gauge"
        ? {
            name: signal.name,
            gauge: {
              dataPoints: [{ ...dataPoint, asDouble: signal.value }],
            },
          }
        : {
            name: signal.name,
            unit: signal.unit,
            histogram: {
              dataPoints: [
                {
                  ...dataPoint,
                  count: "1",
                  sum: signal.value,
                  bucketCounts: ["1"],
                  explicitBounds: [],
                },
              ],
              aggregationTemporality: 2,
            },
          };
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            otlpAttribute("service.name", "runmill"),
            otlpAttribute("service.namespace", "asf"),
          ],
        },
        scopeMetrics: [
          {
            scope: { name: "runmill.asf", version: "1" },
            metrics: [metric],
          },
        ],
      },
    ],
  };
}

function logPayload(signal: AsfTelemetryLogSignal): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            otlpAttribute("service.name", "runmill"),
            otlpAttribute("service.namespace", "asf"),
          ],
        },
        scopeLogs: [
          {
            scope: { name: "runmill.asf", version: "1" },
            logRecords: [
              {
                timeUnixNano: signalUnixNanos(signal),
                observedTimeUnixNano: signalUnixNanos(signal),
                severityText: signal.severity.toUpperCase(),
                body: { stringValue: signal.name },
                attributes: otlpAttributes(signal.attributes),
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Small OTLP/HTTP JSON exporter for the fixed ASF signal contract.
 *
 * It deliberately exports one completed signal per request. Export failures
 * update health and reject only the telemetry promise; SafeAsfTelemetryRecorder
 * consumes that promise so the exporter can never affect authority or state.
 */
export class OtlpHttpAsfTelemetrySink implements AsfTelemetrySink {
  readonly #tracesEndpoint: string;
  readonly #metricsEndpoint: string;
  readonly #logsEndpoint: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #timeoutMs: number;
  readonly #httpClient: AsfTelemetryHttpClient;
  #consecutiveFailures = 0;
  #lastSuccessAt: string | null = null;
  #hasAttempted = false;

  constructor(options: OtlpHttpAsfTelemetrySinkOptions) {
    const endpoints = otlpEndpoints(options.endpoint);
    const timeoutMs = options.timeoutMs ?? DEFAULT_OTLP_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_OTLP_TIMEOUT_MS) {
      throw new AsfTelemetryConfigurationError("OTLP timeout must be an integer between 1 and 60000 ms");
    }
    this.#tracesEndpoint = endpoints.traces;
    this.#metricsEndpoint = endpoints.metrics;
    this.#logsEndpoint = endpoints.logs;
    this.#headers = validateOtlpHeaders(options.headers);
    this.#timeoutMs = timeoutMs;
    this.#httpClient = options.httpClient ?? defaultAsfTelemetryHttpClient;
  }

  health(): AsfTelemetryHealth {
    return Object.freeze({
      schema: ASF_OTLP_HTTP_TELEMETRY_HEALTH_SCHEMA,
      status: !this.#hasAttempted
        ? "unknown"
        : this.#consecutiveFailures === 0
          ? "healthy"
          : "degraded",
      consecutiveFailures: this.#consecutiveFailures,
      lastSuccessAt: this.#lastSuccessAt,
    });
  }

  async record(signal: AsfTelemetrySignal): Promise<void> {
    const validated = parseAsfTelemetrySignal(signal);
    if (validated === null) return;
    const isSpan = validated.kind === "span";
    const isLog = validated.kind === "log";
    const url = isSpan
      ? this.#tracesEndpoint
      : isLog
        ? this.#logsEndpoint
        : this.#metricsEndpoint;
    const body = JSON.stringify(
      isSpan
        ? spanPayload(validated)
        : isLog
          ? logPayload(validated)
          : metricPayload(validated),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#httpClient(url, {
        method: "POST",
        headers: this.#headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OTLP exporter returned HTTP ${String(response.status)}`);
      this.#hasAttempted = true;
      this.#consecutiveFailures = 0;
      this.#lastSuccessAt = validated.timestamp;
    } catch (error) {
      this.#hasAttempted = true;
      this.#consecutiveFailures = Math.min(this.#consecutiveFailures + 1, MAX_OTLP_FAILURES);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
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

function isCorrelationKey(
  key: string,
): key is (typeof CORRELATION_KEYS)[number] {
  return (CORRELATION_KEYS as readonly string[]).includes(key);
}

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
    keys.some(
      (key) => !ATTRIBUTE_KEYS.includes(key) && !isCorrelationKey(key),
    )
  ) {
    return null;
  }
  const output: Record<string, string> = {};
  for (const [key, value] of entries) {
    try {
      if (isCorrelationKey(key)) {
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > 256 ||
          /[\u0000-\u001f\u007f]/u.test(value) ||
          (key === "candidate_sha"
            ? !SHA256_DIGEST_PATTERN.test(value)
            : !SAFE_CORRELATION_ID_PATTERN.test(value))
        ) {
          return null;
        }
        output[key] = value;
        continue;
      }
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
    if (key === "mode") return null;
    if (isCorrelationKey(key)) {
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 256 ||
        /[\u0000-\u001f\u007f]/u.test(value) ||
        (key === "candidate_sha"
          ? !SHA256_DIGEST_PATTERN.test(value)
          : !SAFE_CORRELATION_ID_PATTERN.test(value))
      ) {
        return null;
      }
      output[key] = value;
      continue;
    }
    if (!ATTRIBUTE_KEYS.includes(key)) return null;
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
    if (kind === "gauge") {
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
        !member(ASF_TELEMETRY_GAUGE_NAMES, name) ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0
      ) {
        return null;
      }
      return Object.freeze({
        schema: ASF_TELEMETRY_SCHEMA,
        kind: "gauge",
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
    if (kind === "log") {
      const name = snapshot["name"];
      const severity = snapshot["severity"];
      if (
        !exactKeys(snapshot, [
          "schema",
          "kind",
          "name",
          "severity",
          "timestamp",
          "attributes",
        ]) ||
        !member(ASF_TELEMETRY_LOG_NAMES, name) ||
        !member(LOG_SEVERITIES, severity)
      ) {
        return null;
      }
      return Object.freeze({
        schema: ASF_TELEMETRY_SCHEMA,
        kind: "log",
        name,
        severity,
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
  /** Emit a point-in-time metric; absent on legacy operator sinks. */
  readonly gauge?: (
    name: AsfTelemetryGaugeName,
    value: number,
    attributes?: AsfTelemetryAttributeInput,
  ) => void;
  histogram(
    name: AsfTelemetryHistogramName,
    value: number,
    unit: AsfTelemetryUnit,
    attributes?: AsfTelemetryAttributeInput,
  ): void;
  /** Emit a closed-name structured event without a free-form message body. */
  readonly log?: (
    name: AsfTelemetryLogName,
    severity: AsfTelemetryLogSeverity,
    attributes?: AsfTelemetryAttributeInput,
  ) => void;
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

  gauge(
    name: AsfTelemetryGaugeName,
    value: number,
    attributes: AsfTelemetryAttributeInput = {},
  ): void {
    this.#record({ kind: "gauge", name, value, attributes });
  }

  histogram(
    name: AsfTelemetryHistogramName,
    value: number,
    unit: AsfTelemetryUnit,
    attributes: AsfTelemetryAttributeInput = {},
  ): void {
    this.#record({ kind: "histogram", name, value, unit, attributes });
  }

  log(
    name: AsfTelemetryLogName,
    severity: AsfTelemetryLogSeverity,
    attributes: AsfTelemetryAttributeInput = {},
  ): void {
    this.#record({ kind: "log", name, severity, attributes });
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
