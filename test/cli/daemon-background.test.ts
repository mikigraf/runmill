import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/platform/process.js";
import { requestDaemon, type DaemonSnapshot } from "../../src/daemon/control.js";

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
    };
    const started = await run(TSX, [CLI, "daemon", "--detach", "--poll-seconds", "1"], {
      cwd: repository,
      env: environment,
    });
    expect(started.code).toBe(0);
    expect(started.stdout).toContain("runmill tui");

    // The client is intentionally in another directory and receives only the
    // global registry path, never the config or repository path.
    const snapshot = await requestDaemon<DaemonSnapshot>({ type: "snapshot" }, registry);
    daemonPid = snapshot.daemon.pid;
    expect(snapshot.daemon.repoRoot).toBe(realpathSync(repository));
    expect(snapshot.daemon.phase).toBe("idle");

    await requestDaemon({ type: "stop" }, registry);
    const deadline = Date.now() + 3_000;
    while (existsSync(registry) && Date.now() < deadline) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    expect(existsSync(registry)).toBe(false);
    daemonPid = undefined;
  }, 20_000);

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
