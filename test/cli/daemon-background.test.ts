import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/platform/process.js";
import { requestDaemon, type DaemonSnapshot } from "../../src/daemon/control.js";
import { AsfControlRequestSigner } from "../../src/asf/control-auth.js";
import { SystemClock } from "../../src/platform/clock.js";

const CLI = resolve(process.cwd(), "src/cli/main.ts");
const TSX = resolve(process.cwd(), "node_modules/.bin/tsx");
const QUICKSTART = resolve(process.cwd(), "examples/quickstart");

let directory: string | undefined;
let daemonPid: number | undefined;

afterEach(async () => {
  if (daemonPid !== undefined) {
    try {
      process.kill(daemonPid, "SIGTERM");
    } catch {
      // It already stopped through the control channel.
    }
  }
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
  daemonPid = undefined;
});

describe("background daemon", () => {
  it("starts detached and is discoverable outside its repository", async () => {
    directory = mkdtempSync(join(tmpdir(), "runmill-detach-"));
    const repository = join(directory, "repository");
    cpSync(QUICKSTART, repository, { recursive: true });
    const issues = join(directory, "issues.json");
    const registry = join(directory, "runtime", "daemon.json");
    const data = join(directory, "data");
    writeFileSync(issues, "[]\n");

    const environment = {
      ...process.env,
      RUNMILL_DEMO: "1",
      RUNMILL_FAKE_BACKLOG: issues,
      RUNMILL_DAEMON_REGISTRY: registry,
      RUNMILL_DATA_DIR: data,
      // These values are deliberately unusable. Ordinary start/daemon/status/stop
      // must not inspect ASF configuration, much less try to read a key file.
      RUNMILL_ASF_CONTROL_CONTROLLER_ID: "invalid standalone poison",
      RUNMILL_ASF_CONTROL_KEY_ID: "invalid standalone poison",
      RUNMILL_ASF_CONTROL_KEY_FILE: join(directory, "must-not-be-read.key"),
      RUNMILL_ASF_RUNTIME_MODULE: join(directory, "must-not-be-read.mjs"),
      RUNMILL_ASF_DAEMON_REGISTRY: join(directory, "must-not-be-read.json"),
    };
    const started = await run(
      TSX,
      [CLI, "--config", join(repository, "runmill.yaml"), "start", "--poll-seconds", "1"],
      {
      cwd: repository,
      env: environment,
      },
    );
    expect(started.code).toBe(0);
    expect(started.stdout).toContain("runmill tui");
    expect(started.stdout).toContain("runmill status");
    expect(started.stdout).toContain("runmill stop");

    // The client is intentionally in another directory and receives only the
    // global registry path, never the config or repository path.
    const snapshot = await requestDaemon<DaemonSnapshot>({ type: "snapshot" }, registry);
    daemonPid = snapshot.daemon.pid;
    expect(snapshot.daemon.repoRoot).toBe(realpathSync(repository));
    expect(snapshot.daemon.phase).toBe("idle");

    // The standalone daemon refuses the ASF protocol even though the shared
    // local transport knows its bounded message shapes.
    await expect(
      requestDaemon({ type: "asf.health" }, registry),
    ).rejects.toThrow(/standalone Runmill daemon/u);

    // An authenticated ASF wire envelope cannot reinterpret the legacy stop
    // verb. The ordinary unsigned channel remains live after the refusal.
    const asfSigner = new AsfControlRequestSigner({
      key: {
        controllerId: "asf-controller-test",
        keyId: "asf-control-test",
        secret: "standalone-boundary-test-control-secret-0001",
      },
      clock: new SystemClock(),
    });
    await expect(
      requestDaemon({ type: "stop" }, registry, 2_000, {
        controlAuthentication: asfSigner,
      }),
    ).rejects.toThrow(/control request/u);
    const afterRefusal = await requestDaemon<DaemonSnapshot>(
      { type: "snapshot" },
      registry,
    );
    expect(afterRefusal.daemon.pid).toBe(daemonPid);
    expect(afterRefusal.daemon.phase).not.toBe("stopping");

    const status = await run(TSX, [CLI, "--json", "status"], {
      cwd: directory,
      env: environment,
    });
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      running: true,
      daemon: { repoRoot: realpathSync(repository) },
    });

    const stopped = await run(TSX, [CLI, "stop"], { cwd: directory, env: environment });
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain("stopping after the current safe boundary");
    const deadline = Date.now() + 3_000;
    while (existsSync(registry) && Date.now() < deadline) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    expect(existsSync(registry)).toBe(false);
    daemonPid = undefined;
  }, 20_000);

  it("reports a stopped daemon without creating project state", async () => {
    directory = mkdtempSync(join(tmpdir(), "runmill-status-client-"));
    const registry = join(directory, "runtime", "daemon.json");
    const state = join(directory, "state");
    const result = await run(TSX, [CLI, "--json", "status"], {
      cwd: directory,
      env: { ...process.env, RUNMILL_DAEMON_REGISTRY: registry, RUNMILL_DATA_DIR: state },
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ running: false });
    expect(existsSync(state)).toBe(false);

    const stopped = await run(TSX, [CLI, "--json", "stop"], {
      cwd: directory,
      env: { ...process.env, RUNMILL_DAEMON_REGISTRY: registry, RUNMILL_DATA_DIR: state },
    });
    expect(stopped.code).toBe(0);
    expect(JSON.parse(stopped.stdout)).toEqual({ stopping: false, running: false });
    expect(existsSync(state)).toBe(false);
  });

  it("does not create repository state when the TUI is launched elsewhere", async () => {
    directory = mkdtempSync(join(tmpdir(), "runmill-tui-client-"));
    const result = await run(TSX, [CLI, "tui"], {
      cwd: directory,
      env: process.env,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("interactive terminal");
    expect(existsSync(join(directory, ".runmill"))).toBe(false);
  });
});
