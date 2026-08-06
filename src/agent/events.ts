import type { AgentRole } from "../domain/types.js";

/**
 * Correlation fields every event carries.
 *
 * Without a monotonic `seq` and stable identity, replaying buffered provider
 * output after a crash duplicates usage, commands, and audit entries — which
 * contradicts the requirement that normalized events survive a restart.
 */
export interface AgentEventBase {
  readonly seq: number;
  readonly ts: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly role: AgentRole;
  readonly attempt: number;
}

export type AgentEventBody =
  | { readonly type: "session.started" }
  | { readonly type: "assistant.message"; readonly text: string }
  | { readonly type: "tool.requested"; readonly callId: string; readonly tool: string; readonly input: unknown }
  | { readonly type: "tool.completed"; readonly callId: string; readonly tool: string; readonly outputRef: string }
  | {
      readonly type: "command.started";
      readonly callId: string;
      readonly command: string;
      readonly cwd: string;
      readonly envPolicyHash: string;
      readonly pid: number;
      readonly timeoutMs: number;
    }
  | {
      readonly type: "command.completed";
      readonly callId: string;
      readonly outputRef: string;
      readonly outcome: "exited" | "signaled" | "timeout" | "cancelled" | "sandbox-denied";
      readonly exitCode?: number | undefined;
      readonly signal?: string | undefined;
    }
  | {
      readonly type: "file.changed";
      readonly path: string;
      readonly op: "create" | "modify" | "delete" | "rename";
      readonly beforeHash?: string | undefined;
      readonly afterHash?: string | undefined;
    }
  | {
      readonly type: "permission.requested";
      readonly requestId: string;
      readonly action: string;
      readonly scope: string;
      readonly expiresAt: string;
    }
  | {
      readonly type: "usage.updated";
      readonly cumulative: true;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens?: number | undefined;
      readonly model: string;
      readonly costUsd?: number | undefined;
    }
  | {
      readonly type: "error";
      readonly class: "rate_limit" | "auth" | "context_overflow" | "transport" | "provider_internal";
      readonly retryable: boolean;
      readonly providerCode?: string | undefined;
    }
  | { readonly type: "result"; readonly status: "success" | "failure"; readonly outputRef: string };

export type AgentEvent = AgentEventBase & AgentEventBody;

export const KNOWN_EVENT_TYPES = new Set([
  "session.started",
  "assistant.message",
  "tool.requested",
  "tool.completed",
  "command.started",
  "command.completed",
  "file.changed",
  "permission.requested",
  "usage.updated",
  "error",
  "result",
]);

export class UnknownEventError extends Error {
  readonly code = "RM-PROVIDER-001";
  readonly discriminant: string;

  constructor(discriminant: string) {
    super(
      `unknown provider event type "${discriminant}"; refusing to interpret it heuristically`,
    );
    this.name = "UnknownEventError";
    this.discriminant = discriminant;
  }
}

/**
 * Fail closed on an unrecognised event.
 *
 * Best-effort parsing could misread a tool call or a terminal result, so an
 * unknown discriminant quarantines the run instead.
 */
export function assertKnownEvent(type: string): void {
  if (!KNOWN_EVENT_TYPES.has(type)) throw new UnknownEventError(type);
}

/** Running totals derived from a stream. Usage is cumulative, never delta. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string | undefined;
}

export function accumulateUsage(events: readonly AgentEvent[]): UsageTotals {
  const totals: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0, model: undefined };
  for (const event of events) {
    if (event.type !== "usage.updated") continue;
    // Cumulative: take the latest reading rather than summing deltas.
    totals.inputTokens = event.inputTokens;
    totals.outputTokens = event.outputTokens;
    totals.costUsd = event.costUsd ?? totals.costUsd;
    totals.model = event.model;
  }
  return totals;
}
