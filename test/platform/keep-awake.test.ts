import { describe, expect, it, vi } from "vitest";
import { keepAwakeCommand, startKeepAwake } from "../../src/platform/keep-awake.js";

describe("keep awake", () => {
  it("uses caffeinate on macOS", () => {
    expect(keepAwakeCommand("darwin", () => "/usr/bin/caffeinate")).toEqual({
      name: "caffeinate",
      executable: "/usr/bin/caffeinate",
      args: ["-dimsu", "-t", "2147483647"],
    });
  });

  it("uses a systemd idle and sleep inhibitor on Linux", () => {
    const command = keepAwakeCommand("linux", () => "/usr/bin/systemd-inhibit");
    expect(command?.name).toBe("systemd-inhibit");
    expect(command?.args).toContain("--what=idle:sleep:handle-lid-switch");
    expect(command?.args).toContain("infinity");
  });

  it("reports unsupported hosts without throwing", () => {
    const handle = startKeepAwake("freebsd", () => undefined);
    expect(handle.active).toBe(false);
    expect(handle.message).toMatch(/unavailable/);
    handle.release();
  });

  it("terminates the inhibitor when released", () => {
    const child = {
      on: vi.fn(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    };
    const launch = vi.fn(() => child);
    const handle = startKeepAwake(
      "darwin",
      () => "/usr/bin/caffeinate",
      launch as never,
    );
    expect(handle.active).toBe(true);
    handle.release();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
