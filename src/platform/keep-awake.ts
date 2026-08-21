import { constants, accessSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { terminateTree } from "./process.js";

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
type ProcessTerminator = (child: ChildProcess) => void;

/**
 * A shell-free Linux parent watcher.
 *
 * `systemd-inhibit` holds its lock for the command it runs. A plain
 * `sleep infinity` becomes an orphan if Runmill is killed before `release()`.
 * This tiny Node command checks the original Runmill PID four times a second
 * and exits as soon as it disappears, which makes systemd-inhibit release the
 * lock too. The PID is a separate argv value rather than interpolated code.
 */
const LINUX_PARENT_WATCH = [
  "const parent=Number(process.argv[1]);",
  "if(!Number.isSafeInteger(parent)||parent<=1)process.exit(2);",
  "const alive=()=>{try{process.kill(parent,0);return true}catch{return false}};",
  "const check=()=>{if(!alive())process.exit(0)};",
  "check();setInterval(check,250);",
].join("");

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
  parentPid: number = process.pid,
  nodeExecutable: string = process.execPath,
): KeepAwakeCommand | undefined {
  if (platform === "darwin") {
    const executable = lookup("caffeinate");
    return executable === undefined
      ? undefined
      : {
          name: "caffeinate",
          executable,
          // The kernel releases every assertion when this exact Runmill PID
          // exits, even after SIGKILL. No wall-clock timeout can orphan it.
          args: ["-dimsu", "-w", String(parentPid)],
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
            nodeExecutable,
            "-e",
            LINUX_PARENT_WATCH,
            String(parentPid),
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
  terminate: ProcessTerminator = terminateTree,
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
  let failed = false;
  try {
    child = launch(command.executable, [...command.args], {
      stdio: "ignore",
      windowsHide: true,
      // A separate process group lets release terminate systemd-inhibit and
      // its watcher together. The watcher covers abrupt parent death.
      detached: true,
    });
    child.unref();
    child.on("error", () => {
      child = undefined;
      failed = true;
    });
    child.on("exit", () => {
      child = undefined;
      failed = true;
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
    get active() {
      return child !== undefined && child.exitCode === null && child.signalCode === null;
    },
    name: command.name,
    get message() {
      return failed
        ? `${command.name} stopped; the host may suspend`
        : `sleep inhibitor active: ${command.name}`;
    },
    release() {
      const running = child;
      child = undefined;
      if (running !== undefined && running.exitCode === null && running.signalCode === null) {
        terminate(running);
      }
    },
  };
}
