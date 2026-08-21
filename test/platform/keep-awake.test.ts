import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { keepAwakeCommand, startKeepAwake } from "../../src/platform/keep-awake.js";

describe("keep awake", () => {
  it("uses caffeinate on macOS", () => {
    expect(keepAwakeCommand("darwin", () => "/usr/bin/caffeinate", 4242)).toEqual({
      name: "caffeinate",
      executable: "/usr/bin/caffeinate",
      args: ["-dimsu", "-w", "4242"],
    });
  });

  it("uses a systemd idle and sleep inhibitor on Linux", () => {
    const command = keepAwakeCommand(
      "linux",
      () => "/usr/bin/systemd-inhibit",
      4242,
      "/opt/runmill/node",
    );
    expect(command?.name).toBe("systemd-inhibit");
    expect(command?.args).toContain("--what=idle:sleep:handle-lid-switch");
    expect(command?.args).toContain("/opt/runmill/node");
    expect(command?.args).toContain("4242");
    expect(command?.args).not.toContain("infinity");
    expect(command?.args).not.toContain("sleep");
  });

  it("makes the Linux inhibitor command exit promptly after its watched parent dies", async () => {
    const watched = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"], {
      stdio: "ignore",
    });
    expect(watched.pid).toBeDefined();
    const watchedExit = once(watched, "exit");
    const command = keepAwakeCommand(
      "linux",
      () => "/usr/bin/systemd-inhibit",
      watched.pid,
      process.execPath,
    );
    const commandIndex = command?.args.indexOf(process.execPath) ?? -1;
    expect(commandIndex).toBeGreaterThanOrEqual(0);
    const watcher = spawn(
      process.execPath,
      command?.args.slice(commandIndex + 1) ?? [],
      { stdio: "ignore" },
    );
    const watcherExit = once(watcher, "exit");

    let timer: NodeJS.Timeout | undefined;
    try {
      await watchedExit;
      await Promise.race([
        watcherExit,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("parent watcher did not exit")), 2_000);
        }),
      ]);
      expect(watcher.exitCode).toBe(0);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (watched.exitCode === null) watched.kill("SIGKILL");
      if (watcher.exitCode === null) watcher.kill("SIGKILL");
    }
  });

  it("reports unsupported hosts without throwing", () => {
    const handle = startKeepAwake("freebsd", () => undefined);
    expect(handle.active).toBe(false);
    expect(handle.message).toMatch(/unavailable/);
    handle.release();
  });

  it("terminates the inhibitor when released", () => {
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      unref: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    const launch = vi.fn(() => child);
    const terminate = vi.fn();
    const handle = startKeepAwake(
      "darwin",
      () => "/usr/bin/caffeinate",
      launch as never,
      terminate,
    );
    expect(handle.active).toBe(true);
    expect(launch).toHaveBeenCalledWith(
      "/usr/bin/caffeinate",
      expect.arrayContaining(["-w", String(process.pid)]),
      expect.objectContaining({ detached: true }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
    handle.release();
    expect(terminate).toHaveBeenCalledWith(child);
  });

  it("downgrades status when the inhibitor exits after spawn", () => {
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      unref: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    const handle = startKeepAwake(
      "linux",
      () => "/usr/bin/systemd-inhibit",
      vi.fn(() => child) as never,
    );
    expect(handle.active).toBe(true);
    child.emit("exit", 1, null);
    expect(handle.active).toBe(false);
    expect(handle.message).toMatch(/may suspend/);
  });
});
