import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { TextDecoder } from "node:util";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentRole } from "../domain/types.js";

export const MAX_STRUCTURED_OUTPUT_BYTES = 1024 * 1024;

/**
 * Which roles produce structured output, and where it lands.
 *
 * One table, read by every provider adapter to resolve the path and by the
 * orchestrator to know whether output is owed at all. Spreading this
 * across three files is what let the fake and the real adapter disagree about
 * when `outputRef` is present — tests passed while the real reviewer path
 * could never produce output at all.
 */
export interface OutputContract {
  readonly schema: string;
  readonly fileName: string;
}

export const OUTPUT_CONTRACTS: Partial<Record<AgentRole, OutputContract>> = {
  "local-reviewer": { schema: "review-findings@1", fileName: "local-reviewer-output.json" },
  "pr-reviewer": { schema: "review-findings@1", fileName: "pr-reviewer-output.json" },
};

export function outputContractFor(role: AgentRole): OutputContract | undefined {
  return OUTPUT_CONTRACTS[role];
}

/** Absolute path a role's structured output must be written to, if any. */
export function outputPathFor(workingDirectory: string, role: AgentRole): string | undefined {
  const contract = outputContractFor(role);
  return contract === undefined
    ? undefined
    : join(workingDirectory, ".runmill", "run", contract.fileName);
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("structured output directory escapes the workspace");
  }
}

/**
 * Create a fresh reviewer-output target under proven, non-symlink ancestors.
 *
 * The output is intentionally pre-created: native sandbox transports can then
 * grant one writable file without granting its orchestrator-owned parent. A
 * stale approval can never survive into a later attempt.
 */
export function prepareStructuredOutput(
  workingDirectory: string,
  role: AgentRole,
): string | undefined {
  const path = outputPathFor(workingDirectory, role);
  if (path === undefined) return undefined;

  const workspace = resolve(workingDirectory);
  const workspaceInfo = lstatSync(workspace);
  if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) {
    throw new Error("structured output workspace is not a proven directory");
  }
  const canonicalWorkspace = realpathSync(workspace);
  let current = workspace;
  for (const component of [".runmill", "run"]) {
    current = join(current, component);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`structured output ancestor is not a regular directory: ${current}`);
    }
    assertInside(canonicalWorkspace, realpathSync(current));
  }

  rmSync(path, { force: true });
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
    0o600,
  );
  closeSync(descriptor);
  return path;
}

/** Read one bounded, regular, no-follow structured output file. */
export function readStructuredOutput(path: string): string {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("structured output is not a regular file");
  }
  if (before.size > MAX_STRUCTURED_OUTPUT_BYTES) {
    throw new Error("structured output exceeds the 1 MiB limit");
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag(),
    );
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("structured output changed while it was opened");
    }
    if (opened.size > MAX_STRUCTURED_OUTPUT_BYTES) {
      throw new Error("structured output exceeds the 1 MiB limit");
    }

    const bytes = Buffer.allocUnsafe(MAX_STRUCTURED_OUTPUT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_STRUCTURED_OUTPUT_BYTES) {
      throw new Error("structured output exceeds the 1 MiB limit");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } catch {
      throw new Error("structured output is not valid UTF-8");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
