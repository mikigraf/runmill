import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonControlServer,
  daemonRuntimePaths,
  requestDaemon,
  type RuntimePaths,
} from "../../src/daemon/control.js";

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

  it("resolves the registry outside the repository", () => {
    expect(daemonRuntimePaths({}, "/home/dev")).toEqual({
      directory: "/home/dev/.runmill",
      registry: "/home/dev/.runmill/daemon.json",
      socket: "/home/dev/.runmill/daemon.sock",
    });
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
});
