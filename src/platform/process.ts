import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export interface RunOptions {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Run a command and capture its output, without throwing on a non-zero exit.
 *
 * `execFile`, never a shell: arguments are passed as an array so no caller can
 * accidentally build an injectable command string.
 */
export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
      code: typeof e.code === "number" ? e.code : null,
    };
  }
}

/** Same, but a non-zero exit throws with the stderr attached. */
export async function runOrThrow(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const result = await run(command, args, options);
  if (!result.ok) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/**
 * Signal a whole process group.
 *
 * An agent spawns `npm test`, which spawns workers. Signalling only the direct
 * child leaves detached grandchildren holding file handles in the worktree,
 * and cleanup then fails.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/** SIGTERM, then SIGKILL after a grace period. Returns a cancel function. */
export function armKillTimer(
  child: ChildProcess,
  timeoutMs: number,
  onTimeout?: () => void,
  graceMs = 2_000,
): () => void {
  const timer = setTimeout(() => {
    onTimeout?.();
    killTree(child, "SIGTERM");
    setTimeout(() => killTree(child, "SIGKILL"), graceMs).unref();
  }, timeoutMs);
  return () => clearTimeout(timer);
}
