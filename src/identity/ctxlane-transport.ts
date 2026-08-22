import { lstatSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, isAbsolute, normalize } from "node:path";
import { TextDecoder } from "node:util";
import {
  ctxlaneIdentityLeaseRequestSchema,
  type CtxlaneIdentityLeaseRequest,
} from "./ctxlane-contracts.js";

export const MAX_CTXLANE_CONTROL_MESSAGE_BYTES = 256 * 1024;
export const DEFAULT_CTXLANE_REQUEST_TIMEOUT_MS = 5_000;
export const MAX_CTXLANE_REQUEST_TIMEOUT_MS = 30_000;
export const CTXLANE_UNIX_AUTOMATION_TRANSPORT_QUALIFICATION =
  "development-only-unqualified" as const;

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

export interface CtxlaneUnixAutomationClientOptions {
  readonly endpoint: string;
  readonly timeoutMs?: number | undefined;
  readonly maxMessageBytes?: number | undefined;
  readonly trustedOwnerUids?: readonly number[] | undefined;
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

  constructor(options: CtxlaneUnixAutomationClientOptions) {
    this.#socketPath = parseUnixEndpoint(options.endpoint);
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

  async acquire(
    request: CtxlaneIdentityLeaseRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
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
