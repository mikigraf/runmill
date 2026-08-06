import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentSession,
  AuthStatus,
  CodingAgentAdapter,
  ProviderCapabilities,
  ProviderInstallation,
} from "../agent/adapter.js";
import { assertResumable } from "../agent/adapter.js";
import type { AgentEvent, AgentEventBody } from "../agent/events.js";
import { assertKnownEvent } from "../agent/events.js";
import type { Clock } from "../platform/clock.js";
import { SystemClock } from "../platform/clock.js";

/** A scripted action the fake agent performs inside its workspace. */
export type ScriptedAction =
  | { readonly kind: "write"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "say"; readonly text: string }
  | { readonly kind: "requestPermission"; readonly action: string; readonly scope: string }
  | { readonly kind: "stallForever" }
  | {
      readonly kind: "fail";
      readonly errorClass: "rate_limit" | "auth" | "context_overflow" | "transport" | "provider_internal";
      readonly retryable: boolean;
    }
  | { readonly kind: "emitUnknownEvent"; readonly type: string };

export interface FakeProviderScript {
  /** Actions per role. The implementer usually writes files; reviewers report. */
  readonly byRole?: Partial<Record<string, readonly ScriptedAction[]>> | undefined;
  readonly defaultActions?: readonly ScriptedAction[] | undefined;
  /** Structured output written to the output ref, e.g. review findings JSON. */
  readonly outputByRole?: Partial<Record<string, unknown>> | undefined;
  readonly costUsdPerCall?: number | undefined;
}

/**
 * A deterministic coding agent.
 *
 * Real enough to close the loop: it edits files in the workspace, emits a
 * correlated event stream, honours cancellation, and can be scripted to
 * misbehave in exactly the ways the recovery paths must handle.
 */
export class FakeProviderAdapter implements CodingAgentAdapter {
  readonly name = "fake";
  #script: FakeProviderScript;
  #clock: Clock;
  #sessionSeq = 0;
  readonly startedRequests: AgentRunRequest[] = [];

  constructor(script: FakeProviderScript = {}, clock: Clock = new SystemClock()) {
    this.#script = script;
    this.#clock = clock;
  }

  setScript(script: FakeProviderScript): void {
    this.#script = script;
  }

  async detect(): Promise<ProviderInstallation> {
    return { installed: true, version: "fake-1.0.0" };
  }

  async authStatus(): Promise<AuthStatus> {
    return { authenticated: true };
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      streamingOutput: true,
      sessionResume: true,
      turnLimits: true,
      toolAllowDeny: true,
      sandboxMode: true,
      modelSelection: false,
      costReporting: true,
      structuredOutput: true,
    };
  }

  async resume(request: AgentRunRequest & { sessionId: string }): Promise<AgentSession> {
    assertResumable(request.role);
    return this.start(request);
  }

  async start(request: AgentRunRequest): Promise<AgentSession> {
    this.startedRequests.push(request);
    this.#sessionSeq += 1;
    const sessionId = `fake-session-${this.#sessionSeq}`;
    const actions =
      this.#script.byRole?.[request.role] ?? this.#script.defaultActions ?? [];

    const events: AgentEvent[] = [];
    let seq = 0;
    const emit = (body: AgentEventBody): AgentEvent => {
      assertKnownEvent(body.type);
      seq += 1;
      const event = {
        seq,
        ts: this.#clock.now().toISOString(),
        runId: request.runId,
        sessionId,
        role: request.role,
        attempt: request.attempt,
        ...body,
      } as AgentEvent;
      events.push(event);
      return event;
    };

    const pendingPermissions = new Map<string, (decision: "allow" | "deny") => void>();
    let aborted: string | undefined;

    const resultPromise = (async (): Promise<AgentRunResult> => {
      emit({ type: "session.started" });

      for (const action of actions) {
        if (aborted !== undefined) {
          return { status: "cancelled", sessionId, events };
        }

        switch (action.kind) {
          case "write": {
            const target = join(request.workingDirectory, action.path);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, action.content);
            emit({ type: "file.changed", path: action.path, op: "modify" });
            break;
          }
          case "delete": {
            rmSync(join(request.workingDirectory, action.path), { force: true });
            emit({ type: "file.changed", path: action.path, op: "delete" });
            break;
          }
          case "say":
            emit({ type: "assistant.message", text: action.text });
            break;
          case "requestPermission": {
            const requestId = `perm-${seq + 1}`;
            emit({
              type: "permission.requested",
              requestId,
              action: action.action,
              scope: action.scope,
              expiresAt: new Date(this.#clock.now().getTime() + 60_000).toISOString(),
            });
            await new Promise<void>((resolve) => {
              pendingPermissions.set(requestId, () => resolve());
              if (request.signal?.aborted === true) resolve();
            });
            break;
          }
          case "stallForever":
            await new Promise<void>((resolve) => {
              request.signal?.addEventListener("abort", () => resolve(), { once: true });
              if (request.signal?.aborted === true) resolve();
            });
            return { status: "cancelled", sessionId, events };
          case "fail":
            emit({ type: "error", class: action.errorClass, retryable: action.retryable });
            emit({ type: "result", status: "failure", outputRef: "" });
            return {
              status: "failure",
              sessionId,
              events,
              error: { class: action.errorClass, retryable: action.retryable },
            };
          case "emitUnknownEvent":
            // Throws UnknownEventError: an unrecognised discriminant must
            // quarantine rather than be interpreted heuristically.
            assertKnownEvent(action.type);
            break;
        }
      }

      emit({
        type: "usage.updated",
        cumulative: true,
        inputTokens: 1000,
        outputTokens: 500,
        model: "fake-model",
        costUsd: this.#script.costUsdPerCall ?? 0.01,
      });

      const output = this.#script.outputByRole?.[request.role];
      let outputRef = "";
      if (output !== undefined) {
        outputRef = join(request.workingDirectory, ".runmill", "run", `${request.role}-output.json`);
        mkdirSync(dirname(outputRef), { recursive: true });
        writeFileSync(outputRef, JSON.stringify(output, null, 2));
      }

      emit({ type: "result", status: "success", outputRef });
      return { status: "success", sessionId, events, outputRef };
    })();

    return {
      sessionId: Promise.resolve(sessionId),
      events: (async function* () {
        await resultPromise.catch(() => undefined);
        for (const event of events) yield event;
      })(),
      result: resultPromise,
      respondToPermission: async (requestId, decision) => {
        pendingPermissions.get(requestId)?.(decision);
        pendingPermissions.delete(requestId);
      },
      abort: async (reason) => {
        aborted = reason;
        for (const resolve of pendingPermissions.values()) resolve("deny");
        pendingPermissions.clear();
      },
    };
  }
}
