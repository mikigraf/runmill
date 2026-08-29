import { execFile, spawn, type ChildProcess } from "node:child_process";
import { fstatSync } from "node:fs";
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

export interface RunBytesResult {
  readonly ok: boolean;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly code: number | null;
}

export interface RunOptions {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface RunBytesOptions extends RunOptions {
  /** Hard ceiling for each captured stream. */
  readonly maxOutputBytes: number;
}

export interface RunWithInputOptions extends RunOptions {
  /** Start a new session so interactive tools cannot reopen the caller's TTY. */
  readonly detached?: boolean | undefined;
  /** Stop the child process tree when the caller's operation is cancelled. */
  readonly signal?: AbortSignal | undefined;
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

/** Run a command while preserving stdout as exact, size-bounded bytes. */
export async function runBytes(
  command: string,
  args: readonly string[],
  options: RunBytesOptions,
): Promise<RunBytesResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      encoding: "buffer",
      maxBuffer: options.maxOutputBytes,
    });
    return {
      ok: true,
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
      stderr: stderr.toString(),
      code: 0,
    };
  } catch (err) {
    const e = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      code?: number;
      message?: string;
    };
    return {
      ok: false,
      stdout:
        e.stdout === undefined
          ? Buffer.alloc(0)
          : Buffer.isBuffer(e.stdout)
            ? e.stdout
            : Buffer.from(e.stdout),
      stderr: e.stderr?.toString() ?? e.message ?? "",
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
    if (options.signal?.aborted === true) {
      resolve({
        ok: false,
        stdout: "",
        stderr: "command cancelled",
        code: null,
      });
      return;
    }
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
    let cancelled = false;
    let terminal = false;
    let settled = false;
    let exitCode: number | null = null;
    let drainTimedOut = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const abort = (): void => {
      if (cancelled || terminal) return;
      cancelled = true;
      terminateTree(child);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const cancelTimer =
      options.timeoutMs === undefined
        ? () => undefined
        : armKillTimer(child, options.timeoutMs, () => {
            timedOut = true;
          });

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      terminal = true;
      cancelTimer();
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", abort);
      const failure = [
        stderr.text(),
        ...(timedOut ? [`command timed out after ${String(options.timeoutMs)} ms`] : []),
        ...(cancelled ? ["command cancelled"] : []),
        ...(spawnError === undefined ? [] : [spawnError.message]),
        ...(drainTimedOut
          ? ["command output pipes did not close after the process exited"]
          : []),
      ]
        .filter((part) => part !== "")
        .join("\n");
      resolve({
        ok:
          code === 0 &&
          !timedOut &&
          !cancelled &&
          !drainTimedOut &&
          spawnError === undefined,
        stdout: stdout.text(),
        stderr: failure,
        code,
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("exit", (code) => {
      terminal = true;
      exitCode = code;
      cancelTimer();
      options.signal?.removeEventListener("abort", abort);
      // A descendant can inherit stdout/stderr and keep `close` from ever
      // arriving after the direct child exits. Numeric PID/PGID signalling is
      // no longer safe at this point, so bound the drain, destroy only our pipe
      // handles, and report the incomplete drain as a failure.
      drainTimer = setTimeout(() => {
        drainTimedOut = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exitCode);
      }, KILL_GRACE_MS);
      drainTimer.unref();
    });
    child.on("close", (code) => {
      finish(code ?? exitCode);
    });

    // A command may reject input before consuming it. EPIPE is an ordinary
    // command failure reported through close/stderr, not an unhandled event.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
    // Close the small check-to-listener race if the caller aborted while the
    // child was being spawned and its stdio handlers were installed.
    if (options.signal !== undefined && options.signal.aborted) abort();
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

/** Immediately stop the still-owned child group without a delayed PGID signal. */
export function terminateTree(child: ChildProcess): void {
  // A delayed escalation cannot retain a safe identity for a reaped process
  // group. Until a kernel-owned containment resource exists, terminate the
  // still-owned child group immediately and arm no later numeric-PGID signal.
  killTree(child, "SIGKILL");
}

/** One cancellable timeout; no secondary callback survives terminal close. */
export function armKillTimer(
  child: ChildProcess,
  timeoutMs: number,
  onTimeout?: () => void,
): () => void {
  const timer = setTimeout(() => {
    onTimeout?.();
    killTree(child, "SIGKILL");
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
  readonly onStdout?: ((chunk: Buffer) => void) | undefined;
  readonly onStderr?: ((chunk: Buffer) => void) | undefined;
  /**
   * Detached process-group signaling only. This never proves descendants are
   * gone; a lifecycle backend needs its own kernel-resource acknowledgement.
   */
  readonly containment?: "process-group" | undefined;
  /** Already-open sources inherited as child descriptors 3, 4, ... in order. */
  readonly inheritedFileDescriptors?: readonly number[] | undefined;
}

export interface ControlledProcessResult {
  readonly outcome: ControlledProcessOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputBytesObserved: number;
  /** True only when exit of an owned kernel containment resource proves teardown. */
  readonly containmentConfirmed: boolean;
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
  const inherited = input.inheritedFileDescriptors ?? [];
  if (inherited.length > 1_024 || new Set(inherited).size !== inherited.length) {
    throw new Error("controlled process inherited descriptor inventory is invalid");
  }
  for (const descriptor of inherited) {
    if (!Number.isSafeInteger(descriptor) || descriptor < 3) {
      throw new Error("controlled process inherited descriptor inventory is invalid");
    }
    const info = fstatSync(descriptor);
    if (!info.isFile() && !info.isDirectory()) {
      throw new Error("controlled process inherits only regular files or directories");
    }
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
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let stopTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let exited = false;

    const clearStopTimers = (): void => {
      if (stopTimer !== undefined) clearTimeout(stopTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      stopTimer = undefined;
      forceTimer = undefined;
      drainTimer = undefined;
    };

    const requestStop = (): void => {
      if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
      killTree(child, "SIGTERM");
      if (stopTimer !== undefined) return;
      stopTimer = setTimeout(() => {
        stopTimer = undefined;
        if (child.exitCode === null && child.signalCode === null) killTree(child, "SIGKILL");
        forceTimer = setTimeout(() => {
          forceTimer = undefined;
          if (child.exitCode !== null || child.signalCode !== null || settled) return;
          finish({
            outcome: "spawn-error",
            exitCode: null,
            signal: null,
            stdout: utf8Suffix(stdout.text(), Math.floor(input.maxOutputBytes / 2)),
            stderr: utf8Suffix(
              "contained process did not exit after SIGKILL; cleanup is not proven safe",
              Math.ceil(input.maxOutputBytes / 2),
            ),
            outputBytesObserved: observedBytes,
            containmentConfirmed: false,
          });
        }, KILL_GRACE_MS);
        forceTimer.unref();
      }, KILL_GRACE_MS);
      stopTimer.unref();
    };

    const finish = (result: ControlledProcessResult): void => {
      if (settled) return;
      settled = true;
      clearStopTimers();
      input.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const completeAfterExit = (containmentConfirmed: boolean): void => {
      const outcome: ControlledProcessOutcome = aborted
        ? "aborted"
        : timedOut
          ? "timeout"
          : outputLimited
            ? "output-limit"
            : spawnError !== undefined
              ? "spawn-error"
              : exitSignal !== null
                ? "signaled"
                : "exited";
      const rawErrors = [stderr.text(), ...(spawnError === undefined ? [] : [spawnError.message])]
        .filter((part) => part !== "")
        .join("\n");
      const stdoutBudget = Math.floor(input.maxOutputBytes / 2);
      const safeStdout = utf8Suffix(stdout.text(), stdoutBudget);
      const stderrBudget = input.maxOutputBytes - Buffer.byteLength(safeStdout, "utf8");
      finish({
        outcome,
        exitCode,
        signal:
          outcome === "aborted"
            ? "ABORT"
            : outcome === "output-limit"
              ? "OUTPUT_LIMIT"
              : exitSignal,
        stdout: safeStdout,
        stderr: utf8Suffix(rawErrors, stderrBudget),
        outputBytesObserved: observedBytes,
        containmentConfirmed,
      });
    };

    const onAbort = (): void => {
      aborted = true;
      if (child !== undefined) requestStop();
    };

    if (aborted) {
      finish({
        outcome: "aborted",
        exitCode: null,
        signal: "ABORT",
        stdout: "",
        stderr: "",
        outputBytesObserved: 0,
        containmentConfirmed: true,
      });
      return;
    }

    try {
      child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: { ...input.env },
        detached: true,
        stdio: [
          input.stdin === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe",
          ...(input.inheritedFileDescriptors ?? []),
        ],
      });
    } catch (error) {
      finish({
        outcome: "spawn-error",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        outputBytesObserved: 0,
        containmentConfirmed: true,
      });
      return;
    }

    input.signal.addEventListener("abort", onAbort, { once: true });
    // EventTarget does not replay an abort that raced addEventListener().
    if (input.signal.aborted) onAbort();

    const observe = (
      capture: BoundedCapture,
      callback: ((chunk: Buffer) => void) | undefined,
      chunk: Buffer,
    ): void => {
      observedBytes += chunk.length;
      capture.push(chunk);
      if (observedBytes <= input.maxOutputBytes) callback?.(chunk);
      if (observedBytes > input.maxOutputBytes && !outputLimited) {
        outputLimited = true;
        requestStop();
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      observe(stdout, input.onStdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      observe(stderr, input.onStderr, chunk);
    });
    child.on("error", (error) => {
      spawnError = error;
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, input.timeoutMs);
    const cancelTimer = (): void => clearTimeout(timeoutTimer);

    // Direct-child exit starts a bounded drain. We never poll or signal the
    // numeric PGID after this event, avoiding PID/PGID reuse (ABA).
    child.on("exit", (code, signal) => {
      cancelTimer();
      clearStopTimers();
      exited = true;
      exitCode = code;
      exitSignal = signal;
      // Allow buffered pipe data to drain, but bound the wait because an
      // uncontained descendant can retain a pipe forever. This runner does
      // not claim backend-wide containment; bwrap must add a PID-init sync-fd
      // acknowledgement before production may treat teardown as confirmed.
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        completeAfterExit(false);
      }, KILL_GRACE_MS);
      drainTimer.unref();
    });

    child.on("close", () => {
      cancelTimer();
      if (exited) {
        completeAfterExit(false);
        return;
      }
      // ENOENT and equivalent asynchronous spawn failures may never emit
      // `exit`; `close` plus the captured spawn error is terminal.
      if (spawnError !== undefined) {
        exitCode = null;
        exitSignal = null;
        completeAfterExit(true);
      }
    });

    if (input.stdin !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input.stdin);
    }
  });
}
