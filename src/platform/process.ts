import { execFile, spawn, type ChildProcess } from "node:child_process";
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

export interface RunWithInputOptions extends RunOptions {
  /** Start a new session so interactive tools cannot reopen the caller's TTY. */
  readonly detached?: boolean | undefined;
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

/**
 * Run a command while supplying sensitive input through a private stdin pipe.
 *
 * The input is deliberately a separate parameter: it is never joined into the
 * command arguments or copied into a failure diagnostic.
 */
export async function runWithInput(
  command: string,
  args: readonly string[],
  input: string,
  options: RunWithInputOptions = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const stdout = new BoundedCapture(MAX_BUFFER_BYTES);
    const stderr = new BoundedCapture(MAX_BUFFER_BYTES);
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        detached: options.detached === true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        ok: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        code: null,
      });
      return;
    }

    let spawnError: Error | undefined;
    let timedOut = false;
    const cancelTimer =
      options.timeoutMs === undefined
        ? () => undefined
        : armKillTimer(child, options.timeoutMs, () => {
            timedOut = true;
          });

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code) => {
      cancelTimer();
      const failure = [
        stderr.text(),
        ...(timedOut ? [`command timed out after ${String(options.timeoutMs)} ms`] : []),
        ...(spawnError === undefined ? [] : [spawnError.message]),
      ]
        .filter((part) => part !== "")
        .join("\n");
      resolve({
        ok: code === 0 && !timedOut && spawnError === undefined,
        stdout: stdout.text(),
        stderr: failure,
        code,
      });
    });

    // A command may reject input before consuming it. EPIPE is an ordinary
    // command failure reported through close/stderr, not an unhandled event.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
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

export type ControlledProcessOutcome =
  | "exited"
  | "signaled"
  | "timeout"
  | "aborted"
  | "output-limit"
  | "spawn-error";

export interface ControlledProcessInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string | undefined;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
}

export interface ControlledProcessResult {
  readonly outcome: ControlledProcessOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputBytesObserved: number;
}

function utf8Suffix(text: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maximumBytes) return text;
  const output: string[] = [];
  let used = 0;
  for (const character of [...text].reverse()) {
    const width = Buffer.byteLength(character, "utf8");
    if (used + width > maximumBytes) break;
    output.push(character);
    used += width;
  }
  return output.reverse().join("");
}

/**
 * Abortable process execution with an operator-owned aggregate output bound.
 *
 * Like every other Runmill subprocess, this lives in the single trusted
 * platform process boundary and never invokes a shell.
 */
export function runControlledProcess(
  input: ControlledProcessInput,
): Promise<ControlledProcessResult> {
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    !Number.isSafeInteger(input.maxOutputBytes) ||
    input.maxOutputBytes <= 0
  ) {
    throw new Error("controlled process limits must be positive safe integers");
  }

  return new Promise((resolve) => {
    const stdout = new BoundedCapture(input.maxOutputBytes);
    const stderr = new BoundedCapture(input.maxOutputBytes);
    let child: ChildProcess;
    let settled = false;
    let timedOut = false;
    let aborted = input.signal.aborted;
    let outputLimited = false;
    let observedBytes = 0;
    let spawnError: Error | undefined;

    const finish = (result: ControlledProcessResult): void => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = (): void => {
      aborted = true;
      if (child !== undefined) terminateTree(child);
    };

    if (aborted) {
      finish({
        outcome: "aborted",
        exitCode: null,
        signal: "ABORT",
        stdout: "",
        stderr: "",
        outputBytesObserved: 0,
      });
      return;
    }

    try {
      child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: { ...input.env },
        detached: true,
        stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        outcome: "spawn-error",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        outputBytesObserved: 0,
      });
      return;
    }

    input.signal.addEventListener("abort", onAbort, { once: true });
    // EventTarget does not replay an abort that raced addEventListener().
    if (input.signal.aborted) onAbort();

    const observe = (capture: BoundedCapture, chunk: Buffer): void => {
      observedBytes += chunk.length;
      capture.push(chunk);
      if (observedBytes > input.maxOutputBytes && !outputLimited) {
        outputLimited = true;
        terminateTree(child);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => observe(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => observe(stderr, chunk));
    child.on("error", (error) => {
      spawnError = error;
    });

    const cancelTimer = armKillTimer(child, input.timeoutMs, () => {
      timedOut = true;
    });

    child.on("close", (code, signal) => {
      cancelTimer();
      const outcome: ControlledProcessOutcome = aborted
        ? "aborted"
        : timedOut
          ? "timeout"
          : outputLimited
            ? "output-limit"
            : spawnError !== undefined
              ? "spawn-error"
              : signal !== null
                ? "signaled"
                : "exited";
      const rawErrors = [stderr.text(), ...(spawnError === undefined ? [] : [spawnError.message])]
        .filter((part) => part !== "")
        .join("\n");
      const stdoutBudget = Math.floor(input.maxOutputBytes / 2);
      const safeStdout = utf8Suffix(stdout.text(), stdoutBudget);
      const stderrBudget = input.maxOutputBytes - Buffer.byteLength(safeStdout, "utf8");
      const safeStderr = utf8Suffix(rawErrors, stderrBudget);
      finish({
        outcome,
        exitCode: code,
        signal:
          outcome === "aborted"
            ? "ABORT"
            : outcome === "output-limit"
              ? "OUTPUT_LIMIT"
              : signal,
        stdout: safeStdout,
        stderr: safeStderr,
        outputBytesObserved: observedBytes,
      });
    });

    if (input.stdin !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input.stdin);
    }
  });
}
