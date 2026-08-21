import type { AgentRole } from "../domain/types.js";
import type { AgentEvent } from "./events.js";

export interface ProviderInstallation {
  readonly installed: boolean;
  readonly version?: string | undefined;
  readonly path?: string | undefined;
}

export interface AuthStatus {
  readonly authenticated: boolean;
  readonly detail?: string | undefined;
}

/**
 * Enumerated capability contract.
 *
 * "Capability probe" without a model is untestable. Both providers self-update,
 * so this is checked on every invocation rather than only at doctor time.
 */
export interface ProviderCapabilities {
  readonly streamingOutput: boolean;
  readonly sessionResume: boolean;
  readonly turnLimits: boolean;
  readonly toolAllowDeny: boolean;
  readonly sandboxMode: boolean;
  readonly modelSelection: boolean;
  readonly costReporting: boolean;
  readonly structuredOutput: boolean;
}

export interface AgentRunRequest {
  readonly runId: string;
  readonly issueId: string;
  readonly role: AgentRole;
  readonly attempt: number;
  readonly workingDirectory: string;
  readonly taskPacketPath: string;
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly allowedCommands: readonly string[];
  readonly network: "proxy" | "none";
  readonly maxTurns: number;
  readonly timeoutMs: number;
  /**
   * Repository-provided review guidance captured before implementation starts.
   *
   * The live provider always places this after Runmill's immutable rubric and
   * labels it untrusted, narrowing-only data. It is never a replacement for
   * the built-in review contract.
   */
  readonly supplementalReviewGuidance?:
    | { readonly source: string; readonly content: string }
    | undefined;
  /** Cancels the session even before `session.started` arrives. */
  readonly signal?: AbortSignal | undefined;
}

export interface AgentRunResult {
  readonly status: "success" | "failure" | "cancelled" | "timeout";
  readonly sessionId: string;
  readonly events: readonly AgentEvent[];
  readonly outputRef?: string | undefined;
  readonly error?:
    | {
        readonly class: string;
        readonly retryable: boolean;
        /**
         * What the provider actually said, trimmed to a line or two.
         *
         * Without this a failed run reports only "agent implementer returned
         * failure", which is true of a bad API key, a sandbox that denied the
         * binary, and a model that gave up -- three problems with nothing in
         * common except the sentence describing them.
         */
        readonly detail?: string | undefined;
      }
    | undefined;
}

/**
 * A live agent session.
 *
 * Returned instead of a bare AsyncIterable for two reasons: a provider that
 * stalls before emitting `session.started` has no session id to cancel by, and
 * an iterator offers no reverse channel, so a permission request would
 * deadlock forever with no way to answer it.
 */
export interface AgentSession {
  readonly sessionId: Promise<string>;
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentRunResult>;
  respondToPermission(requestId: string, decision: "allow" | "deny"): Promise<void>;
  abort(reason: string): Promise<void>;
}

export interface CodingAgentAdapter {
  readonly name: string;
  detect(): Promise<ProviderInstallation>;
  authStatus(): Promise<AuthStatus>;
  capabilities(): Promise<ProviderCapabilities>;
  start(request: AgentRunRequest): Promise<AgentSession>;
  /** Only the implementer role may resume; reviewers always start fresh. */
  resume(request: AgentRunRequest & { sessionId: string }): Promise<AgentSession>;
}

export class ResumeNotPermittedError extends Error {
  constructor(role: AgentRole) {
    super(
      `role "${role}" may not resume a session: resume replays prior context, which would ` +
        `silently break reviewer independence`,
    );
    this.name = "ResumeNotPermittedError";
  }
}

export function assertResumable(role: AgentRole): void {
  if (role !== "implementer") throw new ResumeNotPermittedError(role);
}
