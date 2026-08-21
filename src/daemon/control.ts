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
import { dirname, join } from "node:path";
import type { RunRow, SideEffectRow } from "../state/store.js";

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 64 * 1024;

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

export type ControlRequest =
  | { readonly type: "snapshot" }
  | { readonly type: "inspect"; readonly runId: string }
  | { readonly type: "stop" };

export type ControlResponse =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: string };

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
    typeof value.pid !== "number" ||
    typeof value.socketPath !== "string"
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

/** User-private newline-delimited JSON control channel for the TUI. */
export class DaemonControlServer {
  readonly #server: Server;
  readonly #paths: RuntimePaths;
  #closed = false;

  private constructor(server: Server, paths: RuntimePaths) {
    this.#server = server;
    this.#paths = paths;
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

    const server = createServer((socket) => DaemonControlServer.#serve(socket, options.handle));
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

    return new DaemonControlServer(server, paths);
  }

  static #serve(
    socket: Socket,
    handle: ControlServerOptions["handle"],
  ): void {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        socket.end(`${JSON.stringify({ ok: false, error: "request too large" })}\n`);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      void (async () => {
        try {
          const request = JSON.parse(line) as ControlRequest;
          if (!request || !["snapshot", "inspect", "stop"].includes(request.type)) {
            throw new Error("unknown control request");
          }
          if (request.type === "inspect" && typeof request.runId !== "string") {
            throw new Error("inspect requires a runId");
          }
          const data = await handle(request);
          socket.end(`${JSON.stringify({ ok: true, data } satisfies ControlResponse)}\n`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          socket.end(`${JSON.stringify({ ok: false, error: message } satisfies ControlResponse)}\n`);
        }
      })();
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
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
): Promise<T> {
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
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("end", () => {
      try {
        const parsed = JSON.parse(response) as ControlResponse;
        if (!parsed.ok) throw new Error(parsed.error);
        resolve(parsed.data as T);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
