import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ctxlaneIdentityLeaseRequestSchema,
  type CtxlaneIdentityLeaseRequest,
} from "./ctxlane-contracts.js";

export const MAX_CTXLANE_CONTROL_MESSAGE_BYTES = 256 * 1024;
export const DEFAULT_CTXLANE_REQUEST_TIMEOUT_MS = 5_000;
export const MAX_CTXLANE_REQUEST_TIMEOUT_MS = 30_000;
export const CTXLANE_UNIX_AUTOMATION_TRANSPORT_QUALIFICATION =
  "development-only-unqualified" as const;
/**
 * This value is reserved for a separately qualified deployment.  The native
 * addon deliberately reports the unqualified value until live Linux peer
 * and sandbox qualification has passed.
 */
export const CTXLANE_NATIVE_SEQPACKET_TRANSPORT_QUALIFICATION =
  "native-seqpacket-unqualified" as const;
export const CTXLANE_NATIVE_SEQPACKET_TRANSPORT_STATUS =
  "implemented-unqualified" as const;

/**
 * Exact requirements for the first-party Runmill transport.  Implementation
 * status describes source/package availability only; it is not a production
 * qualification claim.
 */
export const CTXLANE_NATIVE_SEQPACKET_DEPLOYMENT_CONTRACT = Object.freeze({
  schema: "ctxlane.runmill-native-seqpacket-contract/v1" as const,
  status: CTXLANE_NATIVE_SEQPACKET_TRANSPORT_STATUS,
  addressFamily: "AF_UNIX" as const,
  socketType: "SOCK_SEQPACKET" as const,
  recordBoundary: "one-bounded-record-per-sendmsg-recvmsg" as const,
  callerBinding: Object.freeze([
    "SO_PEERCRED",
    "SO_PEERPIDFD",
    "SO_PASSCRED",
    "SCM_CREDENTIALS",
    "pidfd-revalidation",
    "protected-executable-and-cgroup-attestation",
  ] as const),
  acquisitionRequestSchema: "ctxlane.identity-lease-request/v1" as const,
  acquisitionResponseSchemas: Object.freeze([
    "ctxlane.identity-lease/v1",
    "ctxlane.automation-error/v1",
  ] as const),
  lifecycleStatus: "private-lifecycle-response-not-published" as const,
  helperProcessAllowed: false as const,
  streamFallbackAllowed: false as const,
});
export const CTXLANE_STDIO_AUTOMATION_TRANSPORT_QUALIFICATION =
  "operator-pinned-unqualified" as const;
export const CTXLANE_STDIO_AUTOMATION_ARGS = [
  "mcp",
  "serve",
  "--stdio",
] as const;

/**
 * The stdio adapter may carry only capability-free observations.  In
 * particular, its MCP lease projections cannot carry the private execution
 * handle required by Runmill's identity broker, so authority-bearing methods
 * must never be reachable through this bridge.
 */
const CTXLANE_STDIO_OBSERVATION_METHODS = new Set([
  "ctxlane_health",
  "ctxlane_check_profile",
]);

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_EXECUTABLE_PATH_BYTES = 4_096;
const STDIO_KILL_GRACE_MS = 250;

const CONTROL_CHARACTER_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "u",
);

export class CtxlaneJsonDuplicateKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CtxlaneJsonDuplicateKeyError";
  }
}

/** Decode one JSON value while rejecting duplicate decoded object keys. */
export function strictJsonDecode(text: string): unknown {
  let index = 0;

  function fail(message: string): never {
    throw new CtxlaneJsonDuplicateKeyError(message);
  }
  function skipWhitespace(): void {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d)
        index += 1;
      else break;
    }
  }
  function expect(character: string): void {
    if (text[index] !== character) {
      fail(
        `ctxlane response is malformed JSON: expected ${JSON.stringify(character)}`,
      );
    }
    index += 1;
  }
  function parseLiteral<T>(literal: string, value: T): T {
    if (text.slice(index, index + literal.length) !== literal) {
      fail("ctxlane response is malformed JSON");
    }
    index += literal.length;
    return value;
  }
  function isDigit(character: string | undefined): character is string {
    return character !== undefined && character >= "0" && character <= "9";
  }
  function parseNumber(): number {
    const start = index;
    if (text[index] === "-") index += 1;
    if (text[index] === "0") {
      index += 1;
    } else if (isDigit(text[index]) && text[index] !== "0") {
      while (isDigit(text[index])) index += 1;
    } else {
      fail("ctxlane response is malformed JSON: invalid number");
    }
    if (text[index] === ".") {
      index += 1;
      if (!isDigit(text[index]))
        fail("ctxlane response is malformed JSON: invalid number");
      while (isDigit(text[index])) index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      if (!isDigit(text[index]))
        fail("ctxlane response is malformed JSON: invalid number");
      while (isDigit(text[index])) index += 1;
    }
    return Number(text.slice(start, index));
  }
  function parseString(): string {
    expect('"');
    let result = "";
    for (;;) {
      const character = text[index];
      if (character === undefined) {
        fail("ctxlane response is malformed JSON: unterminated string");
      }
      if (character === '"') {
        index += 1;
        return result;
      }
      if (character === "\\") {
        index += 1;
        const escape = text[index];
        switch (escape) {
          case '"':
            result += '"';
            break;
          case "\\":
            result += "\\";
            break;
          case "/":
            result += "/";
            break;
          case "b":
            result += "\b";
            break;
          case "f":
            result += "\f";
            break;
          case "n":
            result += "\n";
            break;
          case "r":
            result += "\r";
            break;
          case "t":
            result += "\t";
            break;
          case "u": {
            const hex = text.slice(index + 1, index + 5);
            if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
              fail(
                "ctxlane response is malformed JSON: invalid unicode escape",
              );
            }
            result += String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
            break;
          }
          default:
            fail("ctxlane response is malformed JSON: invalid escape");
        }
        index += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) {
        fail("ctxlane response is malformed JSON: unescaped control character");
      }
      result += character;
      index += 1;
    }
  }
  function parseArray(): unknown[] {
    expect("[");
    const result: unknown[] = [];
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return result;
    }
    for (;;) {
      result.push(parseValue());
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        return result;
      }
      fail('ctxlane response is malformed JSON: expected "," or "]"');
    }
  }
  function parseObject(): Record<string, unknown> {
    expect("{");
    const result = Object.create(null) as Record<string, unknown>;
    const seen = new Set<string>();
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return result;
    }
    for (;;) {
      skipWhitespace();
      if (text[index] !== '"') {
        fail("ctxlane response is malformed JSON: expected an object key");
      }
      const key = parseString();
      if (seen.has(key)) {
        fail(
          `ctxlane response contains a duplicate object member: ${JSON.stringify(key)}`,
        );
      }
      seen.add(key);
      skipWhitespace();
      expect(":");
      result[key] = parseValue();
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      fail('ctxlane response is malformed JSON: expected "," or "}"');
    }
  }
  function parseValue(): unknown {
    skipWhitespace();
    const character = text[index];
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (character === '"') return parseString();
    if (character === "t") return parseLiteral("true", true);
    if (character === "f") return parseLiteral("false", false);
    if (character === "n") return parseLiteral("null", null);
    if (character === "-" || isDigit(character)) return parseNumber();
    fail("ctxlane response is malformed JSON");
  }

  const value = parseValue();
  skipWhitespace();
  if (index !== text.length) {
    fail("ctxlane response is malformed JSON: trailing data");
  }
  return value;
}

export interface CtxlaneIdentityLeaseAcquisitionClient {
  acquire(
    request: CtxlaneIdentityLeaseRequest,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface CtxlaneStdioAutomationClientOptions {
  /** Absolute, operator-owned ctxlane executable; PATH lookup is forbidden. */
  readonly executable: string;
  /** Operator-pinned SHA-256 of the executable bytes. */
  readonly executableSha256: string;
  readonly timeoutMs?: number | undefined;
  readonly maxMessageBytes?: number | undefined;
  /** Allowed executable owners. Defaults to root and the current uid. */
  readonly trustedOwnerUids?: readonly number[] | undefined;
}

export class CtxlaneIdentityProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CtxlaneIdentityProtocolError";
  }
}

function parseUnixEndpoint(endpoint: string): string {
  if (!endpoint.startsWith("unix:///")) {
    throw new CtxlaneIdentityProtocolError(
      "ctxlane endpoint must be an absolute unix URI",
    );
  }
  if (
    CONTROL_CHARACTER_PATTERN.test(endpoint) ||
    endpoint.includes("?") ||
    endpoint.includes("#") ||
    endpoint.includes("@")
  ) {
    throw new CtxlaneIdentityProtocolError(
      "ctxlane endpoint contains forbidden URI data",
    );
  }
  let socketPath: string;
  try {
    socketPath = decodeURIComponent(endpoint.slice("unix://".length));
  } catch {
    throw new CtxlaneIdentityProtocolError(
      "ctxlane endpoint contains invalid escaping",
    );
  }
  if (
    !isAbsolute(socketPath) ||
    socketPath.length > 4_096 ||
    socketPath !== normalize(socketPath) ||
    CONTROL_CHARACTER_PATTERN.test(socketPath) ||
    /[?#@]/u.test(socketPath)
  ) {
    throw new CtxlaneIdentityProtocolError(
      "ctxlane socket path must be absolute",
    );
  }
  return socketPath;
}

interface CtxlaneNativeSeqpacketAddon {
  exchange(
    socketPath: string,
    request: Buffer,
    maxMessageBytes: number,
    timeoutMs: number,
    expectedPeerExecutable: string,
    expectedPeerCgroup: string,
    trustedOwnerUids: readonly number[],
  ): Promise<Buffer>;
}

const nativeRequire = createRequire(import.meta.url);

function loadCtxlaneNativeAddon(): CtxlaneNativeSeqpacketAddon | undefined {
  if (process.platform !== "linux") return undefined;
  const artifact = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../dist-native",
    `linux-${process.arch}`,
    "ctxlane-seqpacket.node",
  );
  try {
    return nativeRequire(artifact) as CtxlaneNativeSeqpacketAddon;
  } catch {
    return undefined;
  }
}

const ctxlaneNativeAddon = loadCtxlaneNativeAddon();

export interface CtxlaneNativeSeqpacketAutomationClientOptions {
  readonly endpoint: string;
  readonly timeoutMs?: number | undefined;
  readonly maxMessageBytes?: number | undefined;
  readonly trustedOwnerUids?: readonly number[] | undefined;
  /** Exact `/proc/<peer-pid>/exe` value required by the native peer attestation. */
  readonly expectedPeerExecutable?: string | undefined;
  /** Exact normalized `/proc/<peer-pid>/cgroup` contents required by attestation. */
  readonly expectedPeerCgroup?: string | undefined;
}

/**
 * Direct Linux AF_UNIX/SOCK_SEQPACKET ctxlane client.
 *
 * The addon is optional at source-install time and unavailable on unsupported
 * platforms.  This class never falls back to node:net, stdio, PATH lookup, or
 * a helper process.  It also requires operator-pinned peer executable and
 * cgroup values before the native boundary can be reached.
 */
export class CtxlaneNativeSeqpacketAutomationClient
  implements CtxlaneIdentityLeaseAcquisitionClient
{
  readonly qualification = CTXLANE_NATIVE_SEQPACKET_TRANSPORT_QUALIFICATION;
  readonly #socketPath: string;
  readonly #timeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #trustedOwnerUids: readonly number[];
  readonly #expectedPeerExecutable: string;
  readonly #expectedPeerCgroup: string;

  constructor(options: CtxlaneNativeSeqpacketAutomationClientOptions) {
    this.#socketPath = parseUnixEndpoint(options.endpoint);
    if (Buffer.byteLength(this.#socketPath, "utf8") > 107) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane native unix socket path exceeds the Linux sockaddr limit",
      );
    }
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_CTXLANE_REQUEST_TIMEOUT_MS;
    this.#maxMessageBytes =
      options.maxMessageBytes ?? MAX_CTXLANE_CONTROL_MESSAGE_BYTES;
    const currentUid = process.getuid?.();
    const owners = options.trustedOwnerUids ??
      (currentUid === undefined ? [0] : [0, currentUid]);
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > MAX_CTXLANE_REQUEST_TIMEOUT_MS ||
      !Number.isSafeInteger(this.#maxMessageBytes) ||
      this.#maxMessageBytes < 1_024 ||
      this.#maxMessageBytes > MAX_CTXLANE_CONTROL_MESSAGE_BYTES ||
      owners.length === 0 ||
      owners.some((uid) => !Number.isSafeInteger(uid) || uid < 0)
    ) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane native transport options are outside the safe range",
      );
    }
    this.#trustedOwnerUids = [...new Set(owners)];
    this.#expectedPeerExecutable = options.expectedPeerExecutable ?? "";
    this.#expectedPeerCgroup = options.expectedPeerCgroup ?? "";
  }

  async acquire(
    request: CtxlaneIdentityLeaseRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (process.platform !== "linux") {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane native SOCK_SEQPACKET transport is Linux-only",
      );
    }
    let validated: CtxlaneIdentityLeaseRequest;
    try {
      const parsed = ctxlaneIdentityLeaseRequestSchema.safeParse(request);
      if (!parsed.success) throw new Error("invalid request");
      validated = parsed.data;
    } catch {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane request is malformed or unbound",
      );
    }
    if (this.#expectedPeerExecutable.length === 0 || this.#expectedPeerCgroup.length === 0) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane native peer executable and cgroup policy are required",
      );
    }
    if (ctxlaneNativeAddon === undefined) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane native SOCK_SEQPACKET addon is unavailable; refusing authority",
      );
    }
    if (signal?.aborted) {
      throw new CtxlaneIdentityProtocolError("ctxlane request was cancelled");
    }
    const requestBytes = Buffer.from(JSON.stringify(validated), "utf8");
    if (requestBytes.byteLength > this.#maxMessageBytes) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane request exceeds the control limit",
      );
    }
    const result = await ctxlaneNativeAddon.exchange(
      this.#socketPath,
      requestBytes,
      this.#maxMessageBytes,
      this.#timeoutMs,
      this.#expectedPeerExecutable,
      this.#expectedPeerCgroup,
      this.#trustedOwnerUids,
    );
    if (signal?.aborted === true) {
      throw new CtxlaneIdentityProtocolError("ctxlane request was cancelled");
    }
    let responseText: string;
    try {
      responseText = new TextDecoder("utf-8", { fatal: true }).decode(result);
    } catch {
      throw new CtxlaneIdentityProtocolError("ctxlane returned invalid UTF-8");
    }
    try {
      return strictJsonDecode(responseText);
    } catch {
      throw new CtxlaneIdentityProtocolError("ctxlane returned invalid JSON");
    }
  }
}

export interface CtxlaneUnixAutomationClientOptions {
  readonly endpoint: string;
  readonly timeoutMs?: number | undefined;
  readonly maxMessageBytes?: number | undefined;
  readonly trustedOwnerUids?: readonly number[] | undefined;
  /**
   * Explicit test-only opt-in for the unqualified newline stream fixture.
   * Production callers must leave this false/omitted and use the future
   * native seqpacket deployment instead.
   */
  readonly allowDevelopmentOnlyTransport?: boolean | undefined;
}

interface PrivateSocketSnapshot {
  readonly socketDevice: number;
  readonly socketInode: number;
  readonly directoryDevice: number;
  readonly directoryInode: number;
}

function sameSocketSnapshot(
  expected: PrivateSocketSnapshot,
  current: PrivateSocketSnapshot,
): boolean {
  return (
    expected.socketDevice === current.socketDevice &&
    expected.socketInode === current.socketInode &&
    expected.directoryDevice === current.directoryDevice &&
    expected.directoryInode === current.directoryInode
  );
}

/**
 * Development-only newline-delimited SOCK_STREAM fixture transport.
 *
 * ctxlane has not published a listener or framing contract. Path ownership
 * and mode checks do not authenticate the peer process, cgroup, or passed
 * credentials, so this client is never production-qualified. A future
 * production adapter must implement ctxlane's published authenticated
 * transport rather than treating this framing as precedent.
 */
export class CtxlaneUnixAutomationClient
  implements CtxlaneIdentityLeaseAcquisitionClient
{
  readonly qualification = CTXLANE_UNIX_AUTOMATION_TRANSPORT_QUALIFICATION;
  readonly #socketPath: string;
  readonly #timeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #trustedOwnerUids: ReadonlySet<number>;
  readonly #allowDevelopmentOnlyTransport: boolean;

  constructor(options: CtxlaneUnixAutomationClientOptions) {
    this.#socketPath = parseUnixEndpoint(options.endpoint);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_CTXLANE_REQUEST_TIMEOUT_MS;
    this.#maxMessageBytes =
      options.maxMessageBytes ?? MAX_CTXLANE_CONTROL_MESSAGE_BYTES;
    this.#allowDevelopmentOnlyTransport =
      options.allowDevelopmentOnlyTransport === true;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > MAX_CTXLANE_REQUEST_TIMEOUT_MS
    ) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane timeout is outside the safe range",
      );
    }
    if (
      !Number.isSafeInteger(this.#maxMessageBytes) ||
      this.#maxMessageBytes < 1_024 ||
      this.#maxMessageBytes > MAX_CTXLANE_CONTROL_MESSAGE_BYTES
    ) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane message limit is outside the safe range",
      );
    }
    const currentUid = process.getuid?.();
    const owners =
      options.trustedOwnerUids ??
      (currentUid === undefined ? [0] : [0, currentUid]);
    if (
      owners.length === 0 ||
      owners.some((uid) => !Number.isSafeInteger(uid) || uid < 0)
    ) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane trusted owner set is invalid",
      );
    }
    this.#trustedOwnerUids = new Set(owners);
  }

  async acquire(
    request: CtxlaneIdentityLeaseRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.#allowDevelopmentOnlyTransport) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane native authenticated SOCK_SEQPACKET transport is unavailable; refusing unqualified SOCK_STREAM authority",
      );
    }
    let validated: CtxlaneIdentityLeaseRequest;
    try {
      const parsed = ctxlaneIdentityLeaseRequestSchema.safeParse(request);
      if (!parsed.success) throw new Error("invalid request");
      validated = parsed.data;
    } catch {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane request is malformed or unbound",
      );
    }
    const requestText = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(requestText, "utf8") > this.#maxMessageBytes) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane request exceeds the control limit",
      );
    }
    if (signal?.aborted === true) {
      throw new CtxlaneIdentityProtocolError("ctxlane request was cancelled");
    }
    const expectedSocket = this.#privateSocketSnapshot();

    return await new Promise<unknown>((resolve, reject) => {
      let socket: Socket;
      try {
        socket = createConnection(this.#socketPath);
      } catch {
        reject(
          new CtxlaneIdentityProtocolError("ctxlane control connection failed"),
        );
        return;
      }
      let settled = false;
      let response = "";
      let receivedBytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const finish = (error: Error | undefined, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error === undefined) resolve(value);
        else reject(error);
      };
      const fail = (reason: string): void =>
        finish(new CtxlaneIdentityProtocolError(reason));
      const abort = (): void => fail("ctxlane request was cancelled");
      const deadline = setTimeout(
        () => fail("ctxlane request timed out"),
        this.#timeoutMs,
      );

      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) {
        abort();
        return;
      }
      socket.once("connect", () => {
        let currentSocket: PrivateSocketSnapshot;
        try {
          currentSocket = this.#privateSocketSnapshot();
        } catch {
          fail("ctxlane control endpoint changed before connection");
          return;
        }
        if (!sameSocketSnapshot(expectedSocket, currentSocket)) {
          fail("ctxlane control endpoint changed before connection");
          return;
        }
        socket.write(requestText, "utf8");
      });
      socket.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > this.#maxMessageBytes) {
          fail("ctxlane response exceeds the control limit");
          return;
        }
        try {
          response += decoder.decode(chunk, { stream: true });
        } catch {
          fail("ctxlane returned invalid UTF-8");
          return;
        }
        const newline = response.indexOf("\n");
        if (newline < 0) return;
        if (response.slice(newline + 1).trim() !== "") {
          fail("ctxlane returned more than one response");
          return;
        }
        try {
          finish(undefined, strictJsonDecode(response.slice(0, newline)));
        } catch {
          fail("ctxlane returned invalid JSON");
        }
      });
      socket.once("error", () => fail("ctxlane control connection failed"));
      socket.once("end", () => {
        if (settled) return;
        try {
          response += decoder.decode();
        } catch {
          fail("ctxlane returned invalid UTF-8");
          return;
        }
        fail("ctxlane closed without a complete response");
      });
      socket.once("close", () => {
        if (!settled) fail("ctxlane closed without a complete response");
      });
    });
  }

  #privateSocketSnapshot(): PrivateSocketSnapshot {
    try {
      const directory = lstatSync(dirname(this.#socketPath));
      if (!directory.isDirectory()) throw new Error("directory type");
      if (!this.#trustedOwnerUids.has(directory.uid))
        throw new Error("directory owner");
      if ((directory.mode & 0o022) !== 0) throw new Error("directory writable");
      const socket = lstatSync(this.#socketPath);
      if (!socket.isSocket()) throw new Error("not socket");
      if (!this.#trustedOwnerUids.has(socket.uid)) throw new Error("owner");
      if ((socket.mode & 0o022) !== 0) throw new Error("writable");
      return {
        socketDevice: socket.dev,
        socketInode: socket.ino,
        directoryDevice: directory.dev,
        directoryInode: directory.ino,
      };
    } catch {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane control endpoint or directory is missing or not privately owned",
      );
    }
  }
}

interface PrivateExecutableSnapshot {
  readonly device: number;
  readonly inode: number;
  readonly digest: string;
}

function validateStdioExecutablePath(executable: string): void {
  if (
    !isAbsolute(executable) ||
    Buffer.byteLength(executable, "utf8") > MAX_EXECUTABLE_PATH_BYTES ||
    executable !== normalize(executable) ||
    CONTROL_CHARACTER_PATTERN.test(executable)
  ) {
    throw new CtxlaneIdentityProtocolError(
      "ctxlane executable must be an absolute normalized path",
    );
  }
}

function validateStdioExecutableAncestors(
  executable: string,
  trustedOwnerUids: ReadonlySet<number>,
): void {
  let current = dirname(executable);
  for (;;) {
    const metadata = lstatSync(current);
    if (
      !metadata.isDirectory() ||
      (metadata.uid !== 0 && !trustedOwnerUids.has(metadata.uid)) ||
      (metadata.mode & 0o022) !== 0 ||
      (metadata.mode & 0o6000) !== 0
    ) {
      throw new Error("unsafe executable ancestor");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function snapshotStdioExecutable(
  executable: string,
  expectedDigest: string,
  trustedOwnerUids: ReadonlySet<number>,
): PrivateExecutableSnapshot {
  validateStdioExecutablePath(executable);
  if (!SHA256_DIGEST_PATTERN.test(expectedDigest)) {
    throw new CtxlaneIdentityProtocolError(
      "ctxlane executable digest is not a canonical sha256 digest",
    );
  }

  let descriptor: number | undefined;
  try {
    validateStdioExecutableAncestors(executable, trustedOwnerUids);
    const pathStat = lstatSync(executable);
    if (
      !pathStat.isFile() ||
      pathStat.nlink !== 1 ||
      !trustedOwnerUids.has(pathStat.uid) ||
      (pathStat.mode & 0o022) !== 0 ||
      (pathStat.mode & 0o6000) !== 0 ||
      (pathStat.mode & 0o111) === 0
    ) {
      throw new Error("unsafe executable metadata");
    }
    const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    const closeOnExec = (fsConstants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
    descriptor = openSync(
      executable,
      fsConstants.O_RDONLY | noFollow | closeOnExec,
    );
    const descriptorStat = fstatSync(descriptor);
    if (
      !descriptorStat.isFile() ||
      descriptorStat.nlink !== 1 ||
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino ||
      !trustedOwnerUids.has(descriptorStat.uid) ||
      (descriptorStat.mode & 0o022) !== 0 ||
      (descriptorStat.mode & 0o6000) !== 0 ||
      (descriptorStat.mode & 0o111) === 0
    ) {
      throw new Error("executable changed while opening");
    }
    const digest = `sha256:${createHash("sha256")
      .update(readFileSync(descriptor))
      .digest("hex")}`;
    if (digest !== expectedDigest) {
      throw new Error("executable digest mismatch");
    }
    return {
      device: descriptorStat.dev,
      inode: descriptorStat.ino,
      digest,
    };
  } catch (error) {
    if (error instanceof CtxlaneIdentityProtocolError) throw error;
    throw new CtxlaneIdentityProtocolError(
      "ctxlane executable is missing, mutable, or not operator-owned",
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the protocol-level refusal; descriptor cleanup is best effort.
      }
    }
  }
}

function terminateStdioChild(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child already exited.
      }
    }
  }, STDIO_KILL_GRACE_MS).unref();
}

/**
 * Operator-pinned development bridge for the Rust `mcp serve --stdio`
 * adapter. It is deliberately not an authenticated transport: the spawned
 * adapter performs the Rust-side seqpacket/credential attestation, while
 * this bridge only pins the executable and keeps Runmill credentials out of
 * its environment. Production qualification still requires a deployed
 * controller/cgroup policy and a native Runmill transport contract.
 */
export class CtxlaneStdioAutomationClient {
  readonly qualification = CTXLANE_STDIO_AUTOMATION_TRANSPORT_QUALIFICATION;
  readonly #executable: string;
  readonly #executableSha256: string;
  readonly #timeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #trustedOwnerUids: ReadonlySet<number>;

  constructor(options: CtxlaneStdioAutomationClientOptions) {
    validateStdioExecutablePath(options.executable);
    if (!SHA256_DIGEST_PATTERN.test(options.executableSha256)) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane executable digest is not a canonical sha256 digest",
      );
    }
    this.#executable = options.executable;
    this.#executableSha256 = options.executableSha256;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_CTXLANE_REQUEST_TIMEOUT_MS;
    this.#maxMessageBytes =
      options.maxMessageBytes ?? MAX_CTXLANE_CONTROL_MESSAGE_BYTES;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > MAX_CTXLANE_REQUEST_TIMEOUT_MS
    ) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane timeout is outside the safe range",
      );
    }
    if (
      !Number.isSafeInteger(this.#maxMessageBytes) ||
      this.#maxMessageBytes < 1_024 ||
      this.#maxMessageBytes > MAX_CTXLANE_CONTROL_MESSAGE_BYTES
    ) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane message limit is outside the safe range",
      );
    }
    const currentUid = process.getuid?.();
    const owners =
      options.trustedOwnerUids ??
      (currentUid === undefined ? [0] : [0, currentUid]);
    if (
      owners.length === 0 ||
      owners.some((uid) => !Number.isSafeInteger(uid) || uid < 0)
    ) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane trusted owner set is invalid",
      );
    }
    this.#trustedOwnerUids = new Set(owners);
  }

  async call(
    method: string,
    params: Readonly<Record<string, unknown>>,
    id: string | number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (
      !/^ctxlane_[a-z0-9_]+$/u.test(method) ||
      method.length > 128 ||
      (typeof id !== "string" &&
        !(typeof id === "number" && Number.isSafeInteger(id) && id >= 0)) ||
      (typeof id === "string" &&
        (id.length === 0 ||
          id.length > 256 ||
          CONTROL_CHARACTER_PATTERN.test(id))) ||
      params === null ||
      typeof params !== "object" ||
      Array.isArray(params)
    ) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane MCP request is malformed or unbound",
      );
    }
    if (!CTXLANE_STDIO_OBSERVATION_METHODS.has(method)) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane stdio bridge permits observation methods only",
      );
    }
    const requestText = `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    })}\n`;
    if (Buffer.byteLength(requestText, "utf8") > this.#maxMessageBytes) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane request exceeds the control limit",
      );
    }
    if (signal?.aborted === true) {
      throw new CtxlaneIdentityProtocolError("ctxlane request was cancelled");
    }
    const expected = snapshotStdioExecutable(
      this.#executable,
      this.#executableSha256,
      this.#trustedOwnerUids,
    );

    return await new Promise<unknown>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.#executable, [...CTXLANE_STDIO_AUTOMATION_ARGS], {
          cwd: "/",
          detached: true,
          env: {},
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch {
        reject(
          new CtxlaneIdentityProtocolError("ctxlane adapter failed to start"),
        );
        return;
      }

      let settled = false;
      let output = Buffer.alloc(0);
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
        terminateStdioChild(child);
        if (error === undefined) resolve(value);
        else reject(error);
      };
      const fail = (reason: string): void =>
        finish(new CtxlaneIdentityProtocolError(reason));
      const abort = (): void => fail("ctxlane request was cancelled");
      const deadline = setTimeout(
        () => fail("ctxlane request timed out"),
        this.#timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });

      try {
        const afterSpawn = snapshotStdioExecutable(
          this.#executable,
          this.#executableSha256,
          this.#trustedOwnerUids,
        );
        if (
          afterSpawn.device !== expected.device ||
          afterSpawn.inode !== expected.inode ||
          afterSpawn.digest !== expected.digest
        ) {
          fail("ctxlane executable changed before launch");
          return;
        }
      } catch {
        fail("ctxlane executable changed before launch");
        return;
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        output = Buffer.concat([output, chunk]);
        if (output.byteLength > this.#maxMessageBytes) {
          fail("ctxlane response exceeds the control limit");
          return;
        }
        const newline = output.indexOf(0x0a);
        if (newline < 0) return;
        const responseBytes = output.subarray(0, newline);
        const trailing = output.subarray(newline + 1);
        if (trailing.some((byte) => ![0x20, 0x09, 0x0d, 0x0a].includes(byte))) {
          fail("ctxlane returned more than one response");
          return;
        }
        let responseText: string;
        try {
          responseText = decoder.decode(responseBytes);
        } catch {
          fail("ctxlane returned invalid UTF-8");
          return;
        }
        try {
          const response = strictJsonDecode(responseText);
          if (
            response === null ||
            typeof response !== "object" ||
            Array.isArray(response)
          ) {
            throw new Error("response shape");
          }
          const record = response as Record<string, unknown>;
          const keys = Object.keys(record).sort();
          const hasResult = Object.prototype.hasOwnProperty.call(
            record,
            "result",
          );
          const hasError = Object.prototype.hasOwnProperty.call(
            record,
            "error",
          );
          if (
            keys.length !== 3 ||
            record.jsonrpc !== "2.0" ||
            !Object.is(record.id, id) ||
            hasResult === hasError
          ) {
            throw new Error("response envelope");
          }
          finish(undefined, response);
        } catch {
          fail("ctxlane returned invalid JSON");
        }
      });
      child.stdout?.on("error", () => fail("ctxlane adapter output failed"));
      child.stdin?.on("error", () => undefined);
      child.on("error", () => fail("ctxlane adapter failed"));
      child.once("close", () => {
        if (!settled)
          fail("ctxlane adapter closed without a complete response");
      });
      try {
        child.stdin?.end(requestText, "utf8");
      } catch {
        fail("ctxlane adapter input failed");
      }
    });
  }
}
