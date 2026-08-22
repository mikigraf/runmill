import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  deserializeAsfControlError,
  serializeAsfControlError,
  type AsfControlError,
} from "../asf/control.js";
import type {
  AsfControlAuthenticationProvider,
  AsfControlAuthenticationVerifier,
} from "../asf/control-auth.js";
import { approvalEnvelopeSchema } from "../asf/approval.js";
import { cancellationRequestSchema } from "../asf/cancellation.js";
import { outcomeAcknowledgementSchema } from "../asf/outcome.js";
import { reconciliationRequestSchema } from "../asf/reconciliation.js";
import type { RunRow, SideEffectRow } from "../state/store.js";

const PROTOCOL_VERSION = 1;
// A signed Work Order may contain a substantial immutable specification. Keep
// the channel bounded, but do not force callers to put authority-bearing input
// in an ambient temporary file merely to fit the TUI-sized historical limit.
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONTROL_PATH_BYTES = 4_096;
const CONTROL_CONNECTION_TIMEOUT_MS = 10_000;
const AUTHENTICATED_CONTROL_REQUEST_SCHEMA = "asf.authenticated-control-request/v1" as const;

export type DaemonPhase = "starting" | "watching" | "idle" | "running" | "stopping";

export interface DaemonLogLine {
  readonly at: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}

export interface DaemonSnapshot {
  readonly protocolVersion: 1;
  readonly daemon: {
    readonly pid: number;
    readonly phase: DaemonPhase;
    readonly startedAt: string;
    readonly repoRoot: string;
    readonly configPath: string;
    readonly pollSeconds: number;
    readonly activeIssue?: string | undefined;
    readonly sleepInhibitor: string;
  };
  readonly runs: readonly RunRow[];
  readonly pendingEffects: number;
  readonly activeLeases: number;
  readonly logs: readonly DaemonLogLine[];
}

export interface RunDetail {
  readonly run: RunRow;
  readonly transitions: readonly {
    from: string;
    to: string;
    at: string;
  }[];
  readonly events: readonly { seq: number; type: string; payload: unknown }[];
  readonly pending: readonly SideEffectRow[];
}

export type StandaloneControlRequest =
  | { readonly type: "snapshot" }
  | { readonly type: "inspect"; readonly runId: string }
  | { readonly type: "stop" };

export type AsfControlRequest =
  | { readonly type: "asf.submit_work_order"; readonly envelope: Record<string, unknown> }
  | { readonly type: "asf.get_run"; readonly runId: string }
  | {
      readonly type: "asf.list_run_events";
      readonly runId: string;
      readonly after?: number | undefined;
      readonly limit?: number | undefined;
    }
  | { readonly type: "asf.get_evidence"; readonly runId: string }
  | {
      readonly type: "asf.request_cancel";
      readonly request: z.infer<typeof cancellationRequestSchema>;
    }
  | {
      readonly type: "asf.record_approval";
      readonly envelope: z.infer<typeof approvalEnvelopeSchema>;
    }
  | {
      readonly type: "asf.reconcile_run";
      readonly request: z.infer<typeof reconciliationRequestSchema>;
    }
  | {
      readonly type: "asf.acknowledge_outcome";
      readonly acknowledgement: z.infer<typeof outcomeAcknowledgementSchema>;
    }
  | { readonly type: "asf.health" };

export type ControlRequest = StandaloneControlRequest | AsfControlRequest;

const controlRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot") }).strict(),
  z.object({ type: z.literal("inspect"), runId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("stop") }).strict(),
  z
    .object({
      type: z.literal("asf.submit_work_order"),
      envelope: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z.object({ type: z.literal("asf.get_run"), runId: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal("asf.list_run_events"),
      runId: z.string().min(1),
      after: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(1_000).optional(),
    })
    .strict(),
  z.object({ type: z.literal("asf.get_evidence"), runId: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal("asf.request_cancel"),
      request: cancellationRequestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("asf.record_approval"),
      envelope: approvalEnvelopeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("asf.reconcile_run"),
      request: reconciliationRequestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("asf.acknowledge_outcome"),
      acknowledgement: outcomeAcknowledgementSchema,
    })
    .strict(),
  z.object({ type: z.literal("asf.health") }).strict(),
]);

export function parseControlRequest(raw: unknown): ControlRequest {
  const parsed = controlRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "invalid or unknown control request: " +
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; "),
    );
  }
  return parsed.data;
}

export type ControlResponse =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      /** Kept for protocol-v1 standalone clients and older ASF clients. */
      readonly error: string;
      /** Present only for a catalogued failure from a valid ASF request. */
      readonly asfError?: AsfControlError | undefined;
    };

function isAsfControlRequest(
  request: ControlRequest | undefined,
): request is AsfControlRequest {
  return request !== undefined && request.type.startsWith("asf.");
}

export interface DaemonRegistry {
  readonly protocolVersion: 1;
  readonly pid: number;
  readonly socketPath: string;
  readonly startedAt: string;
  readonly repoRoot: string;
  readonly configPath: string;
}

export interface RuntimePaths {
  readonly directory: string;
  readonly registry: string;
  readonly socket: string;
}

/** A user-scoped location, independent of the caller's current directory. */
export function daemonRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): RuntimePaths {
  const explicit = env["RUNMILL_DAEMON_REGISTRY"];
  if (explicit !== undefined && explicit !== "") {
    return {
      directory: dirname(explicit),
      registry: explicit,
      socket: join(dirname(explicit), "daemon.sock"),
    };
  }
  const runtime = env["XDG_RUNTIME_DIR"];
  const directory = runtime === undefined || runtime === "" ? join(userHome, ".runmill") : join(runtime, "runmill");
  return { directory, registry: join(directory, "daemon.json"), socket: join(directory, "daemon.sock") };
}

/**
 * ASF has a separate discovery namespace from the standalone daemon.
 *
 * Keeping this resolver separate is a safety property, not cosmetic naming:
 * an authenticated ASF client must never reinterpret a standalone daemon's
 * legacy `stop` request, and both processes need to be able to run for the same
 * operator at the same time.
 */
export function asfDaemonRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): RuntimePaths {
  const explicit = env["RUNMILL_ASF_DAEMON_REGISTRY"];
  if (explicit !== undefined && explicit !== "") {
    return validateAsfRuntimePaths({
      directory: dirname(explicit),
      registry: explicit,
      socket: join(dirname(explicit), "asf-worker.sock"),
    });
  }
  const runtime = env["XDG_RUNTIME_DIR"];
  const directory =
    runtime === undefined || runtime === ""
      ? join(userHome, ".runmill")
      : join(runtime, "runmill");
  return validateAsfRuntimePaths({
    directory,
    registry: join(directory, "asf-worker.json"),
    socket: join(directory, "asf-worker.sock"),
  });
}

function validateAsfRuntimePaths(paths: RuntimePaths): RuntimePaths {
  if (
    Object.values(paths).some(
      (path) =>
        !isAbsolute(path) ||
        /[\u0000-\u001f\u007f]/u.test(path) ||
        Buffer.byteLength(path, "utf8") > MAX_CONTROL_PATH_BYTES,
    )
  ) {
    throw new Error("ASF control paths must be absolute, bounded, and contain no controls.");
  }
  return paths;
}

export function readDaemonRegistry(path = daemonRuntimePaths().registry): DaemonRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("No Runmill daemon is registered. Start one with `runmill start`.");
  }
  const value = parsed as Partial<DaemonRegistry>;
  if (
    value.protocolVersion !== PROTOCOL_VERSION ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid ?? 0) <= 0 ||
    typeof value.socketPath !== "string" ||
    !isAbsolute(value.socketPath) ||
    /[\u0000-\u001f\u007f]/u.test(value.socketPath) ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    typeof value.repoRoot !== "string" ||
    value.repoRoot === "" ||
    typeof value.configPath !== "string" ||
    value.configPath === ""
  ) {
    throw new Error("The Runmill daemon registry is invalid or belongs to an incompatible version.");
  }
  return value as DaemonRegistry;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeIfExists(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Cleanup is best effort; listen/write below returns a useful error.
  }
}

export interface ControlServerOptions {
  readonly repoRoot: string;
  readonly configPath: string;
  readonly startedAt: string;
  readonly paths?: RuntimePaths | undefined;
  /** Required for the ASF worker host; omitted by the standalone daemon. */
  readonly controlAuthentication?: AsfControlAuthenticationVerifier | undefined;
  /**
   * Handles one control request.
   *
   * A function-typed property rather than a method, because it is detached from
   * `options` and passed to the connection handler. Declared as a method it
   * would be legal to satisfy with something that needs its receiver, which
   * would then be called without one.
   */
  readonly handle: (request: ControlRequest) => Promise<unknown> | unknown;
}

interface ControlConnectionState {
  readonly socket: Socket;
  handling: boolean;
}

/** User-private newline-delimited JSON control channel for the TUI. */
export class DaemonControlServer {
  readonly #server: Server;
  readonly #paths: RuntimePaths;
  readonly #connections: Set<ControlConnectionState>;
  #closed = false;

  private constructor(
    server: Server,
    paths: RuntimePaths,
    connections: Set<ControlConnectionState>,
  ) {
    this.#server = server;
    this.#paths = paths;
    this.#connections = connections;
  }

  static async start(options: ControlServerOptions): Promise<DaemonControlServer> {
    const paths = options.paths ?? daemonRuntimePaths();
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 });

    if (existsSync(paths.registry)) {
      try {
        const registered = readDaemonRegistry(paths.registry);
        if (pidIsAlive(registered.pid)) {
          throw new Error(
            `Runmill daemon ${registered.pid} is already registered for ${registered.repoRoot}.`,
          );
        }
      } catch (error) {
        if (error instanceof Error && /already registered/.test(error.message)) throw error;
      }
    }
    removeIfExists(paths.socket);
    removeIfExists(paths.registry);

    const connections = new Set<ControlConnectionState>();
    const server = createServer((socket) => {
      const state: ControlConnectionState = { socket, handling: false };
      connections.add(state);
      socket.once("close", () => connections.delete(state));
      DaemonControlServer.#serve(state, options.handle, options.controlAuthentication);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(paths.socket, () => {
        server.off("error", onError);
        resolve();
      });
    });
    try {
      chmodSync(paths.socket, 0o600);
      const registry: DaemonRegistry = {
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        socketPath: paths.socket,
        startedAt: options.startedAt,
        repoRoot: options.repoRoot,
        configPath: options.configPath,
      };
      const temporary = `${paths.registry}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, paths.registry);
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      removeIfExists(paths.socket);
      throw error;
    }

    return new DaemonControlServer(server, paths, connections);
  }

  static #serve(
    connection: ControlConnectionState,
    handle: ControlServerOptions["handle"],
    controlAuthentication: AsfControlAuthenticationVerifier | undefined,
  ): void {
    const { socket } = connection;
    socket.setEncoding("utf8");
    socket.setTimeout(CONTROL_CONNECTION_TIMEOUT_MS, () => socket.destroy());
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        socket.end(`${JSON.stringify({ ok: false, error: "request too large" })}\n`);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      connection.handling = true;
      const line = buffer.slice(0, newline);
      buffer = "";
      void (async () => {
        let request: ControlRequest | undefined;
        try {
          const raw = JSON.parse(line) as unknown;
          let rawRequest = raw;
          let rawAuthentication: unknown;
          if (controlAuthentication !== undefined) {
            const authenticated = parseAuthenticatedControlRequest(raw);
            rawRequest = authenticated.request;
            rawAuthentication = authenticated.authentication;
          }
          request = parseControlRequest(rawRequest);
          if (controlAuthentication !== undefined) {
            await controlAuthentication.verify(request, rawAuthentication);
          }
          const data = await handle(request);
          sendControlResponse(socket, { ok: true, data });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const asfError = isAsfControlRequest(request)
            ? serializeAsfControlError(error)
            : undefined;
          const response: ControlResponse =
            asfError === undefined
              ? { ok: false, error: message }
              : { ok: false, error: message, asfError };
          sendControlResponse(socket, response);
        }
      })();
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const connection of this.#connections) {
      if (!connection.handling) connection.socket.destroy();
    }
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    removeIfExists(this.#paths.socket);
    try {
      const registered = readDaemonRegistry(this.#paths.registry);
      if (registered.pid === process.pid) removeIfExists(this.#paths.registry);
    } catch {
      // Already gone or replaced.
    }
  }
}

export async function requestDaemon<T>(
  request: ControlRequest,
  registryPath = daemonRuntimePaths().registry,
  timeoutMs = 2_000,
  options: {
    readonly controlAuthentication?: AsfControlAuthenticationProvider | undefined;
  } = {},
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Runmill daemon timeout must be a positive safe integer.");
  }
  const wireRequest =
    options.controlAuthentication === undefined
      ? request
      : {
          schema: AUTHENTICATED_CONTROL_REQUEST_SCHEMA,
          request,
          authentication: options.controlAuthentication.authenticate(request),
        };
  const requestLine = `${JSON.stringify(wireRequest)}\n`;
  if (Buffer.byteLength(requestLine, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("Runmill daemon request is too large.");
  }
  const registry = readDaemonRegistry(registryPath);
  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(registry.socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    let response = "";
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", () =>
      fail(new Error(`Cannot connect to Runmill daemon ${registry.pid}. Its registry may be stale.`)),
    );
    socket.once("timeout", () => fail(new Error("Timed out waiting for the Runmill daemon.")));
    socket.on("connect", () => socket.write(requestLine));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
        fail(new Error("Runmill daemon response is too large."));
      }
    });
    socket.on("end", () => {
      try {
        const parsed = JSON.parse(response) as ControlResponse;
        if (!parsed.ok) {
          if (parsed.asfError !== undefined) {
            throw deserializeAsfControlError(parsed.asfError);
          }
          throw new Error(parsed.error);
        }
        resolve(parsed.data as T);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function sendControlResponse(socket: Socket, response: ControlResponse): void {
  let line = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_RESPONSE_BYTES) {
    line = `${JSON.stringify({
      ok: false,
      error: "response too large",
    } satisfies ControlResponse)}\n`;
  }
  socket.end(line);
}

function parseAuthenticatedControlRequest(raw: unknown): {
  readonly request: unknown;
  readonly authentication: unknown;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("authenticated ASF control request is malformed");
  }
  const value = raw as Readonly<Record<string, unknown>>;
  if (
    Object.keys(value).length !== 3 ||
    value["schema"] !== AUTHENTICATED_CONTROL_REQUEST_SCHEMA ||
    value["request"] === undefined ||
    value["authentication"] === undefined
  ) {
    throw new Error("authenticated ASF control request is malformed");
  }
  return {
    request: value["request"],
    authentication: value["authentication"],
  };
}
