import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Output ceiling for captured subprocess results.
 *
 * Node's `execFile` default is 1 MB and it SIGTERMs the child on overflow, so
 * a large `git diff --name-only` would fail as a generic error. Everything
 * funnels through here, so the ceiling is set once and generously.
 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * A bounded tail of a byte stream.
 *
 * Retains the last `max` bytes without re-copying: the naive
 * `buffer = (buffer + chunk).slice(-max)` flattens the whole rope on every
 * chunk, which is ~500x slower on a stream that overruns the cap. Decoding
 * once at the end also avoids splitting a multi-byte UTF-8 sequence across a
 * chunk boundary, which corrupts both halves.
 */
export class BoundedCapture {
  readonly #max: number;
  #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;

  constructor(max: number) {
    this.#max = max;
  }

  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
    while (this.#chunks.length > 1 && this.#bytes - (this.#chunks[0]?.length ?? 0) >= this.#max) {
      this.#bytes -= this.#chunks.shift()?.length ?? 0;
      this.#truncated = true;
    }
  }

  text(): string {
    if (this.#chunks.length === 0) return "";
    const joined = Buffer.concat(this.#chunks);
    const tail = joined.length > this.#max ? joined.subarray(joined.length - this.#max) : joined;
    return this.#truncated ? `[...truncated...]\n${tail.toString("utf8")}` : tail.toString("utf8");
  }
}

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
      maxBuffer: MAX_BUFFER_BYTES,
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

const KILL_GRACE_MS = 2_000;

/**
 * Ask a process tree to stop, then make it.
 *
 * The same escalation the timeout path uses. A single SIGTERM is a request,
 * and a provider that traps or ignores it stays alive with its stdio open,
 * which leaves the awaiting run pending forever rather than cancelled.
 */
export function terminateTree(child: ChildProcess): void {
  killTree(child, "SIGTERM");
  setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS).unref();
}

/** SIGTERM, then SIGKILL after a grace period. Returns a cancel function. */
export function armKillTimer(
  child: ChildProcess,
  timeoutMs: number,
  onTimeout?: () => void,
): () => void {
  const timer = setTimeout(() => {
    onTimeout?.();
    killTree(child, "SIGTERM");
    setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS).unref();
  }, timeoutMs);
  return () => clearTimeout(timer);
}
