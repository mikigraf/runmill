import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asfDaemonRuntimePaths,
  DaemonControlServer,
  daemonRuntimePaths,
  parseControlRequest,
  readDaemonRegistry,
  requestDaemon,
  type RuntimePaths,
} from "../../src/daemon/control.js";
import { RemoteAsfControlError } from "../../src/asf/control.js";
import { RunmillError } from "../../src/errors/runmill-error.js";

const openServers: DaemonControlServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function paths(): RuntimePaths {
  const directory = mkdtempSync(join(tmpdir(), "runmill-control-"));
  return {
    directory,
    registry: join(directory, "daemon.json"),
    socket: join(directory, "daemon.sock"),
  };
}

describe("daemon control channel", () => {
  it("serves snapshots and control requests through the registered socket", async () => {
    const runtime = paths();
    const requests: string[] = [];
    const server = await DaemonControlServer.start({
      paths: runtime,
      repoRoot: "/repo",
      configPath: "/repo/runmill.yaml",
      startedAt: "2026-08-09T10:00:00.000Z",
      handle: (request) => {
        requests.push(request.type);
        return request.type === "snapshot" ? { phase: "idle" } : { accepted: true };
      },
    });
    openServers.push(server);

    await expect(requestDaemon({ type: "snapshot" }, runtime.registry)).resolves.toEqual({
      phase: "idle",
    });
    await expect(requestDaemon({ type: "stop" }, runtime.registry)).resolves.toEqual({
      accepted: true,
    });
    expect(requests).toEqual(["snapshot", "stop"]);
  });

  it("carries bounded ASF service requests without making them standalone commands", async () => {
    const runtime = paths();
    const server = await DaemonControlServer.start({
      paths: runtime,
      repoRoot: "/repo",
      configPath: "/repo/runmill.yaml",
      startedAt: "2026-08-09T10:00:00.000Z",
      handle: (request) => ({ requestType: request.type }),
    });
    openServers.push(server);

    await expect(
      requestDaemon(
        { type: "asf.get_run", runId: "run_01J" },
        runtime.registry,
      ),
    ).resolves.toEqual({ requestType: "asf.get_run" });
    await expect(
      requestDaemon(
        { type: "asf.list_run_events", runId: "run_01J", after: 4, limit: 25 },
        runtime.registry,
      ),
    ).resolves.toEqual({ requestType: "asf.list_run_events" });
  });

  it("preserves catalogued ASF failure codes, retry, owner, and action details", async () => {
    const runtime = paths();
    const server = await DaemonControlServer.start({
      paths: runtime,
      repoRoot: "/repo",
      configPath: "/repo/runmill.yaml",
      startedAt: "2026-08-09T10:00:00.000Z",
      handle: () => {
        throw RunmillError.fromCatalog("RM-CI-002", {
          whatHappened: "ci/test did not report for candidate aaaaaaa",
          runId: "run_01J",
          resumeFrom: "CI_WAIT",
          cause: {
            retryDisposition: "reconcile-first",
            requiredActor: "repository-owner",
            requiredAction: "Restore ci/test, then reconcile this run.",
            evidenceRefs: [`sha256:${"c".repeat(64)}`],
          },
        });
      },
    });
    openServers.push(server);

    try {
      await requestDaemon(
        { type: "asf.get_run", runId: "run_01J" },
        runtime.registry,
      );
      expect.unreachable("expected the ASF request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteAsfControlError);
      expect(error).toBeInstanceOf(RunmillError);
      expect(error).toMatchObject({
        code: "RM-CI-002",
        recoverable: true,
        runId: "run_01J",
        resumeFrom: "CI_WAIT",
        retryDisposition: "reconcile-first",
        requiredActor: "repository-owner",
        requiredAction: "Restore ci/test, then reconcile this run.",
        evidenceRefs: [`sha256:${"c".repeat(64)}`],
      });
    }
  });

  it("keeps standalone and unclassified ASF failures on the legacy string contract", async () => {
    const runtime = paths();
    const server = await DaemonControlServer.start({
      paths: runtime,
      repoRoot: "/repo",
      configPath: "/repo/runmill.yaml",
      startedAt: "2026-08-09T10:00:00.000Z",
      handle: (request) => {
        if (request.type === "snapshot") {
          throw RunmillError.fromCatalog("RM-STATE-001", {
            whatHappened: "standalone state is newer than this binary",
          });
        }
        throw new Error("unclassified ASF adapter failure");
      },
    });
    openServers.push(server);

    try {
      await requestDaemon({ type: "snapshot" }, runtime.registry);
      expect.unreachable("expected the standalone request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(RunmillError);
      expect((error as Error).message).toMatch(/^RM-STATE-001 /u);
    }
    try {
      await requestDaemon(
        { type: "asf.get_run", runId: "run_01J" },
        runtime.registry,
      );
      expect.unreachable("expected the ASF request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(RemoteAsfControlError);
      expect((error as Error).message).toBe("unclassified ASF adapter failure");
    }
  });

  it("writes user-private discovery files and removes them on close", async () => {
    const runtime = paths();
    const server = await DaemonControlServer.start({
      paths: runtime,
      repoRoot: "/repo",
      configPath: "/repo/runmill.yaml",
      startedAt: "2026-08-09T10:00:00.000Z",
      handle: () => ({}),
    });
    openServers.push(server);
    expect(statSync(runtime.registry).mode & 0o777).toBe(0o600);
    expect(statSync(runtime.socket).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(runtime.registry, "utf8"))).toMatchObject({
      pid: process.pid,
      repoRoot: "/repo",
      socketPath: runtime.socket,
    });

    await server.close();
    openServers.pop();
    await expect(requestDaemon({ type: "snapshot" }, runtime.registry)).rejects.toThrow(
      /No Runmill daemon/,
    );
  });

  it("distinguishes an invalid registry from no registered daemon", () => {
    const runtime = paths();
    mkdirSync(runtime.directory, { recursive: true });
    writeFileSync(runtime.registry, "{not-json\n", { mode: 0o600 });

    expect(() => readDaemonRegistry(runtime.registry)).toThrow(/registry is invalid/u);
  });

  it("refuses a symlinked registry instead of following it", () => {
    if (process.platform === "win32") return;
    const runtime = paths();
    const target = join(runtime.directory, "redirected.json");
    writeFileSync(target, "{}\n", { mode: 0o600 });
    symlinkSync(target, runtime.registry);

    expect(() => readDaemonRegistry(runtime.registry)).toThrow(/could not be read safely/u);
    expect(readFileSync(target, "utf8")).toBe("{}\n");
  });

  it("refuses to overwrite an invalid or incompatible registry", async () => {
    const runtime = paths();
    mkdirSync(runtime.directory, { recursive: true });
    writeFileSync(runtime.registry, "{not-json\n", { mode: 0o600 });

    await expect(
      DaemonControlServer.start({
        paths: runtime,
        repoRoot: "/replacement",
        configPath: "/replacement/runmill.yaml",
        startedAt: "2026-08-29T10:00:00.000Z",
        handle: () => ({}),
      }),
    ).rejects.toThrow(/registry is invalid/u);
    expect(readFileSync(runtime.registry, "utf8")).toBe("{not-json\n");
  });

  it("resolves the registry outside the repository", () => {
    expect(daemonRuntimePaths({}, "/home/dev")).toEqual({
      directory: "/home/dev/.runmill",
      registry: "/home/dev/.runmill/daemon.json",
      socket: "/home/dev/.runmill/daemon.sock",
    });
  });

  it("keeps ASF discovery separate from the standalone daemon namespace", () => {
    expect(asfDaemonRuntimePaths({}, "/home/dev")).toEqual({
      directory: "/home/dev/.runmill",
      registry: "/home/dev/.runmill/asf-worker.json",
      socket: "/home/dev/.runmill/asf-worker.sock",
    });
    expect(
      asfDaemonRuntimePaths(
        { RUNMILL_ASF_DAEMON_REGISTRY: "/private/runtime/worker.json" },
        "/home/dev",
      ),
    ).toEqual({
      directory: "/private/runtime",
      registry: "/private/runtime/worker.json",
      socket: "/private/runtime/asf-worker.sock",
    });
    expect(
      asfDaemonRuntimePaths(
        { RUNMILL_DAEMON_REGISTRY: "/standalone/daemon.json" },
        "/home/dev",
      ).registry,
    ).toBe("/home/dev/.runmill/asf-worker.json");
    expect(() =>
      asfDaemonRuntimePaths(
        { RUNMILL_ASF_DAEMON_REGISTRY: "relative/asf-worker.json" },
        "/home/dev",
      ),
    ).toThrow(/absolute, bounded/u);
  });

  it("refuses to replace a live daemon registry", async () => {
    const runtime = paths();
    const server = await DaemonControlServer.start({
      paths: runtime,
      repoRoot: "/first",
      configPath: "/first/runmill.yaml",
      startedAt: "2026-08-09T10:00:00.000Z",
      handle: () => ({}),
    });
    openServers.push(server);
    await expect(
      DaemonControlServer.start({
        paths: runtime,
        repoRoot: "/second",
        configPath: "/second/runmill.yaml",
        startedAt: "2026-08-09T10:01:00.000Z",
        handle: () => ({}),
      }),
    ).rejects.toThrow(/already registered/);
  });

  it("fails closed when PID liveness cannot be determined", async () => {
    const runtime = paths();
    mkdirSync(runtime.directory, { recursive: true });
    writeFileSync(
      runtime.registry,
      `${JSON.stringify({
        protocolVersion: 1,
        pid: 424_242,
        socketPath: runtime.socket,
        startedAt: "2026-08-29T10:00:00.000Z",
        repoRoot: "/unknown-owner",
        configPath: "/unknown-owner/runmill.yaml",
      })}\n`,
      { mode: 0o600 },
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    try {
      await expect(
        DaemonControlServer.start({
          paths: runtime,
          repoRoot: "/replacement",
          configPath: "/replacement/runmill.yaml",
          startedAt: "2026-08-29T10:01:00.000Z",
          handle: () => ({}),
        }),
      ).rejects.toThrow(/already registered/u);
      expect(readDaemonRegistry(runtime.registry).repoRoot).toBe("/unknown-owner");
    } finally {
      kill.mockRestore();
    }
  });

  it("grants startup ownership to exactly one concurrent server", async () => {
    const runtime = paths();
    const options = {
      paths: runtime,
      repoRoot: "/repo",
      configPath: "/repo/runmill.yaml",
      startedAt: "2026-08-29T10:00:00.000Z",
      handle: () => ({}),
    };

    const results = await Promise.allSettled([
      DaemonControlServer.start(options),
      DaemonControlServer.start(options),
    ]);
    const started = results.filter(
      (result): result is PromiseFulfilledResult<DaemonControlServer> =>
        result.status === "fulfilled",
    );
    const refused = results.filter((result) => result.status === "rejected");
    expect(started).toHaveLength(1);
    expect(refused).toHaveLength(1);
    openServers.push(started[0]?.value as DaemonControlServer);
  });

  it("reconciles a valid registry only after its recorded PID is definitively dead", async () => {
    const runtime = paths();
    mkdirSync(runtime.directory, { recursive: true });
    writeFileSync(
      runtime.registry,
      `${JSON.stringify({
        protocolVersion: 1,
        pid: Number.MAX_SAFE_INTEGER,
        socketPath: runtime.socket,
        startedAt: "2026-08-29T10:00:00.000Z",
        repoRoot: "/crashed",
        configPath: "/crashed/runmill.yaml",
      })}\n`,
      { mode: 0o600 },
    );

    const server = await DaemonControlServer.start({
      paths: runtime,
      repoRoot: "/replacement",
      configPath: "/replacement/runmill.yaml",
      startedAt: "2026-08-29T10:01:00.000Z",
      handle: () => ({}),
    });
    openServers.push(server);

    expect(readDaemonRegistry(runtime.registry)).toMatchObject({
      pid: process.pid,
      repoRoot: "/replacement",
    });
  });

  it("dispatches at most one request per control connection", async () => {
    const runtime = paths();
    const requests: string[] = [];
    const server = await DaemonControlServer.start({
      paths: runtime,
      repoRoot: "/repo",
      configPath: "/repo/runmill.yaml",
      startedAt: "2026-08-09T10:00:00.000Z",
      handle: (request) => {
        requests.push(request.type);
        return { accepted: true };
      },
    });
    openServers.push(server);

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(runtime.socket);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(
          `${JSON.stringify({ type: "snapshot" })}\n${JSON.stringify({ type: "stop" })}\n`,
        );
      });
      socket.once("end", resolve);
      socket.resume();
    });

    expect(requests).toEqual(["snapshot"]);
  });

  it("bounds requests and responses on both sides of the private channel", async () => {
    const runtime = paths();
    const server = await DaemonControlServer.start({
      paths: runtime,
      repoRoot: "/repo",
      configPath: "/repo/runmill.yaml",
      startedAt: "2026-08-09T10:00:00.000Z",
      handle: () => ({ oversized: "x".repeat(2 * 1024 * 1024) }),
    });
    openServers.push(server);

    await expect(requestDaemon({ type: "snapshot" }, runtime.registry)).rejects.toThrow(
      /response too large/u,
    );
    await expect(
      requestDaemon(
        {
          type: "asf.submit_work_order",
          envelope: { oversized: "x".repeat(2 * 1024 * 1024) },
        },
        runtime.registry,
      ),
    ).rejects.toThrow(/request is too large/u);
  });

  it("does not let an idle client prevent service shutdown", async () => {
    const runtime = paths();
    const server = await DaemonControlServer.start({
      paths: runtime,
      repoRoot: "/repo",
      configPath: "/repo/runmill.yaml",
      startedAt: "2026-08-09T10:00:00.000Z",
      handle: () => ({}),
    });
    openServers.push(server);
    const socket = createConnection(runtime.socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const clientClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    await server.close();
    await clientClosed;
    openServers.pop();

    expect(socket.destroyed).toBe(true);
  });
});

describe("parseControlRequest", () => {
  it("accepts the versioned ASF submission shape", () => {
    expect(
      parseControlRequest({
        type: "asf.submit_work_order",
        envelope: { schema: "asf.work-order-envelope/v1" },
      }),
    ).toEqual({
      type: "asf.submit_work_order",
      envelope: { schema: "asf.work-order-envelope/v1" },
    });
  });

  it.each([
    { type: "merge_now", runId: "run_01J" },
    { type: "asf.submit_work_order" },
    { type: "asf.submit_work_order", envelope: [] },
    { type: "asf.get_run", runId: "" },
    { type: "asf.list_run_events", runId: "run_01J", after: -1 },
    { type: "asf.list_run_events", runId: "run_01J", limit: 1_001 },
    { type: "stop", arbitrary: "shell" },
  ])("refuses malformed, unbounded, or arbitrary authority: %j", (request) => {
    expect(() => parseControlRequest(request)).toThrow(/control request/u);
  });
});
