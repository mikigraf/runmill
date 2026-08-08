import { constants, accessSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export interface KeepAwakeCommand {
  readonly name: "caffeinate" | "systemd-inhibit";
  readonly executable: string;
  readonly args: readonly string[];
}

export interface KeepAwakeHandle {
  readonly active: boolean;
  readonly name?: KeepAwakeCommand["name"] | undefined;
  readonly message: string;
  release(): void;
}

type CommandLookup = (name: string) => string | undefined;

function findOnPath(name: string): string | undefined {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking. Missing optional host tooling is reported by the caller.
    }
  }
  return undefined;
}

/** Resolve the native, process-scoped sleep inhibitor for a host. */
export function keepAwakeCommand(
  platform: NodeJS.Platform,
  lookup: CommandLookup = findOnPath,
): KeepAwakeCommand | undefined {
  if (platform === "darwin") {
    const executable = lookup("caffeinate");
    return executable === undefined
      ? undefined
      : {
          name: "caffeinate",
          executable,
          // -u normally expires after five seconds without -t. A very long
          // timeout keeps the user-active assertion (and therefore the screen
          // saver) inhibited for the child lifetime; release still kills it.
          args: ["-dimsu", "-t", "2147483647"],
        };
  }

  if (platform === "linux") {
    const executable = lookup("systemd-inhibit");
    return executable === undefined
      ? undefined
      : {
          name: "systemd-inhibit",
          executable,
          args: [
            "--what=idle:sleep:handle-lid-switch",
            "--who=runmill",
            "--why=Runmill loop orchestrator daemon is active",
            "--mode=block",
            "sleep",
            "infinity",
          ],
        };
  }

  return undefined;
}

/**
 * Keep the host awake until release. Failure is non-fatal: a headless host or
 * minimal Linux image may not provide an inhibitor, and the operator gets a
 * clear warning instead of a daemon that refuses to start.
 */
export function startKeepAwake(
  platform: NodeJS.Platform = process.platform,
  lookup: CommandLookup = findOnPath,
  launch: typeof spawn = spawn,
): KeepAwakeHandle {
  const command = keepAwakeCommand(platform, lookup);
  if (command === undefined) {
    return {
      active: false,
      message: `sleep inhibitor unavailable on ${platform}; the host may suspend`,
      release() {},
    };
  }

  let child: ChildProcess | undefined;
  try {
    child = launch(command.executable, [...command.args], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {
      child = undefined;
    });
  } catch {
    return {
      active: false,
      name: command.name,
      message: `${command.name} could not start; the host may suspend`,
      release() {},
    };
  }

  return {
    active: true,
    name: command.name,
    message: `sleep inhibitor active: ${command.name}`,
    release() {
      const running = child;
      child = undefined;
      if (running !== undefined && running.exitCode === null && running.signalCode === null) {
        running.kill("SIGTERM");
      }
    },
  };
}
