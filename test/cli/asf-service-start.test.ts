import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DaemonControlServer,
  requestDaemon,
  type DaemonSnapshot,
  type RuntimePaths,
} from "../../src/daemon/control.js";
import { run, runWithInput } from "../../src/platform/process.js";

const CLI = resolve(process.cwd(), "src/cli/main.ts");
const TSX = resolve(process.cwd(), "node_modules/.bin/tsx");
const RUNTIME_MODULE = resolve(process.cwd(), "test/asf/service-runtime-fixture.ts");

let directory: string | undefined;
let child: ChildProcess | undefined;
let standalone: DaemonControlServer | undefined;

afterEach(async () => {
  if (child?.exitCode === null) child.kill("SIGTERM");
  await waitForExit(child, 2_000).catch(() => undefined);
  child = undefined;
  await standalone?.close();
  standalone = undefined;
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function runtimePaths(base: string, name: string): RuntimePaths {
  const runtime = join(base, name);
  return {
    directory: runtime,
    registry: join(runtime, "daemon.json"),
    socket: join(runtime, "daemon.sock"),
  };
}

async function waitForFile(
  path: string,
  process: ChildProcess | undefined,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (process !== undefined && process.exitCode !== null) {
      throw new Error("service exited before publishing its registry");
    }
    if (Date.now() >= deadline) throw new Error("timed out waiting for service registry");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function waitForExit(process: ChildProcess | undefined, timeoutMs: number): Promise<number | null> {
  if (process === undefined || process.exitCode !== null) {
    return Promise.resolve(process?.exitCode ?? null);
  }
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for service process")), timeoutMs);
    process.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}

function mcpInput(): string {
  return [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "isolation-test", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "runmill_health", arguments: {} },
    },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n") + "\n";
}

describe("runmill service start", () => {
  it("runs in the foreground, coexists with standalone, and exits after ASF stop", async () => {
    directory = mkdtempSync(join(tmpdir(), "runmill-asf-service-cli-"));
    const standalonePaths = runtimePaths(directory, "standalone");
    const asfRegistry = join(directory, "asf", "asf-worker.json");
    const keyFile = join(directory, "asf-control.key");
    const dataDir = join(directory, "data");
    writeFileSync(keyFile, "asf-service-integration-control-key-00000001\n", { mode: 0o600 });
    chmodSync(keyFile, 0o600);

    standalone = await DaemonControlServer.start({
      paths: standalonePaths,
      repoRoot: directory,
      configPath: join(directory, "runmill.yaml"),
      startedAt: "2026-08-21T10:00:00.000Z",
      handle: (request) => {
        if (request.type === "snapshot") {
          return {
            protocolVersion: 1,
            daemon: {
              pid: process.pid,
              phase: "idle",
              startedAt: "2026-08-21T10:00:00.000Z",
              repoRoot: directory as string,
              configPath: join(directory as string, "runmill.yaml"),
              pollSeconds: 30,
              sleepInhibitor: "unavailable",
            },
            runs: [],
            pendingEffects: 0,
            activeLeases: 0,
            logs: [],
          } satisfies DaemonSnapshot;
        }
        if (request.type === "stop") return { stopping: true };
        throw new Error("standalone daemon does not serve ASF");
      },
    });

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      RUNMILL_DATA_DIR: dataDir,
      RUNMILL_DAEMON_REGISTRY: standalonePaths.registry,
      RUNMILL_ASF_DAEMON_REGISTRY: asfRegistry,
      RUNMILL_ASF_RUNTIME_MODULE: RUNTIME_MODULE,
      RUNMILL_ASF_CONTROL_CONTROLLER_ID: "asf-controller-test",
      RUNMILL_ASF_CONTROL_KEY_ID: "asf-control-test",
      RUNMILL_ASF_CONTROL_KEY_FILE: keyFile,
    };
    let stdout = "";
    let stderr = "";
    child = spawn(TSX, [CLI, "service", "start", "--mode", "asf-worker"], {
      cwd: directory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await waitForFile(asfRegistry, child);
    await expect(
      requestDaemon<DaemonSnapshot>({ type: "snapshot" }, standalonePaths.registry),
    ).resolves.toMatchObject({ daemon: { phase: "idle" } });

    const status = await run(TSX, [CLI, "--json", "service", "status"], {
      cwd: directory,
      env: environment,
    });
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      running: true,
      health: { mode: "asf-worker", ready: true },
    });

    // The MCP adapter uses the ASF registry by default even while a standalone
    // daemon is registered in RUNMILL_DAEMON_REGISTRY.
    const mcp = await runWithInput(
      TSX,
      [CLI, "mcp", "serve", "--stdio"],
      mcpInput(),
      { cwd: directory, env: environment },
    );
    expect(mcp.code).toBe(0);
    const responses = mcp.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(responses).toHaveLength(2);
    expect(responses[1]).toMatchObject({
      id: 2,
      result: {
        isError: false,
        structuredContent: { mode: "asf-worker", ready: true },
      },
    });

    const stopped = await run(TSX, [CLI, "service", "stop"], {
      cwd: directory,
      env: environment,
    });
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain("ASF worker is stopping");
    await expect(waitForExit(child, 15_000)).resolves.toBe(0);
    expect(stdout).toContain("ASF worker is ready");
    expect(stderr).toBe("");
    expect(existsSync(asfRegistry)).toBe(false);
    expect(existsSync(dataDir)).toBe(false);

    await expect(
      requestDaemon<DaemonSnapshot>({ type: "snapshot" }, standalonePaths.registry),
    ).resolves.toMatchObject({ daemon: { phase: "idle" } });
  }, 45_000);

  it("fails closed before loading a runtime for missing or non-ASF mode", async () => {
    directory = mkdtempSync(join(tmpdir(), "runmill-asf-service-refusal-"));
    const missing = await run(
      TSX,
      [CLI, "service", "start", "--mode", "asf-worker"],
      {
        cwd: directory,
        env: {
          ...process.env,
          RUNMILL_DATA_DIR: join(directory, "data"),
          RUNMILL_ASF_RUNTIME_MODULE: "",
        },
      },
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("runtime-module-required");

    const wrongMode = await run(
      TSX,
      [CLI, "service", "start", "--mode", "standalone"],
      {
        cwd: directory,
        env: {
          ...process.env,
          RUNMILL_DATA_DIR: join(directory, "data"),
          RUNMILL_ASF_RUNTIME_MODULE: join(directory, "must-not-be-read.mjs"),
        },
      },
    );
    expect(wrongMode.code).toBe(1);
    expect(wrongMode.stderr).toContain("requires --mode asf-worker");
    expect(wrongMode.stderr).not.toContain("runtime-module-file");
    expect(existsSync(join(directory, "data"))).toBe(false);
  });
});
