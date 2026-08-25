import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import {
  CTXLANE_NATIVE_SEQPACKET_DEPLOYMENT_CONTRACT,
  CTXLANE_NATIVE_SEQPACKET_TRANSPORT_QUALIFICATION,
  CTXLANE_NATIVE_SEQPACKET_TRANSPORT_STATUS,
  CtxlaneIdentityProtocolError,
  CtxlaneNativeSeqpacketAutomationClient,
  decodeNativeSeqpacketResponse,
} from "../../src/identity/ctxlane-broker.js";
import type { CtxlaneIdentityLeaseRequest } from "../../src/identity/ctxlane-contracts.js";

const fixtureRequest: CtxlaneIdentityLeaseRequest = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "..",
      "fixtures",
      "ctxlane",
      "examples",
      "identity-lease-request.v1.json",
    ),
    "utf-8",
  ),
);

interface NativeSeqpacketAddonFixture {
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

const nativeSeqpacketArtifact = join(
  __dirname,
  "..",
  "..",
  "dist-native",
  `linux-${process.arch}`,
  "ctxlane-seqpacket.node",
);
const nativeSeqpacketArtifactAvailable =
  process.platform === "linux" && existsSync(nativeSeqpacketArtifact);
const nativeRequire = createRequire(import.meta.url);

function loadNativeSeqpacketAddonFixture(): NativeSeqpacketAddonFixture {
  return nativeRequire(nativeSeqpacketArtifact) as NativeSeqpacketAddonFixture;
}

// The native addon snapshots the configured peer executable before the async
// exchange, so the policy path must be a real protected executable on Linux.
// /usr/bin/true is the stable fixture already used by ctxlane-transport.test.ts.
const validOptions = {
  endpoint: "unix:///private/ctxlane.sock",
  expectedPeerExecutable: "/usr/bin/true",
  expectedPeerCgroup: "0::/run/ctxlane",
} as const;

describe("CtxlaneNativeSeqpacketAutomationClient", () => {
  it("publishes the implemented-but-unqualified native boundary", () => {
    const client = new CtxlaneNativeSeqpacketAutomationClient(validOptions);

    expect(client.qualification).toBe(
      CTXLANE_NATIVE_SEQPACKET_TRANSPORT_QUALIFICATION,
    );
    expect(client.qualification).not.toBe("native-seqpacket-authenticated");
    expect(CTXLANE_NATIVE_SEQPACKET_DEPLOYMENT_CONTRACT).toMatchObject({
      status: CTXLANE_NATIVE_SEQPACKET_TRANSPORT_STATUS,
      addressFamily: "AF_UNIX",
      socketType: "SOCK_SEQPACKET",
      streamFallbackAllowed: false,
      helperProcessAllowed: false,
      lifecycleStatus: "ctxlane.identity-lease-lifecycle-private/v1",
    });
  });

  it("accepts a path at the Linux sockaddr pathname limit", () => {
    const socketPath = `/private/${"x".repeat(98)}`;

    expect(Buffer.byteLength(socketPath, "utf8")).toBe(107);
    expect(
      () =>
        new CtxlaneNativeSeqpacketAutomationClient({
          ...validOptions,
          endpoint: `unix://${socketPath}`,
        }),
    ).not.toThrow();
  });

  it("rejects a path beyond the Linux sockaddr pathname limit", () => {
    const socketPath = `/private/${"x".repeat(99)}`;

    expect(Buffer.byteLength(socketPath, "utf8")).toBe(108);
    expect(
      () =>
        new CtxlaneNativeSeqpacketAutomationClient({
          ...validOptions,
          endpoint: `unix://${socketPath}`,
        }),
    ).toThrow("exceeds the Linux sockaddr limit");
  });

  it.each([
    ["timeout below one millisecond", { timeoutMs: 0 }],
    ["timeout above the configured maximum", { timeoutMs: 30_001 }],
    ["record limit below the native minimum", { maxMessageBytes: 1_023 }],
    ["record limit above the configured maximum", { maxMessageBytes: 262_145 }],
    ["empty trusted owner set", { trustedOwnerUids: [] }],
    ["negative trusted owner", { trustedOwnerUids: [-1] }],
  ] as const)("rejects unsafe %s", (_description, options) => {
    expect(
      () => new CtxlaneNativeSeqpacketAutomationClient({ ...validOptions, ...options }),
    ).toThrow(CtxlaneIdentityProtocolError);
  });

  it.each([
    ["relative peer executable", { expectedPeerExecutable: "ctxlane" }],
    [
      "non-normalized peer executable",
      { expectedPeerExecutable: "/usr/bin/../bin/ctxlane" },
    ],
    [
      "control-bearing peer executable",
      { expectedPeerExecutable: "/usr/bin/ctxlane\n" },
    ],
    ["non-v2 peer cgroup", { expectedPeerCgroup: "/run/ctxlane" }],
    [
      "control-bearing peer cgroup",
      { expectedPeerCgroup: "0::/run/ctxlane\n" },
    ],
    [
      "overlong peer cgroup",
      { expectedPeerCgroup: `0::/${"x".repeat(4_092)}` },
    ],
  ] as const)("rejects unsafe %s policy before native authority", (_description, options) => {
    expect(
      () =>
        new CtxlaneNativeSeqpacketAutomationClient({
          ...validOptions,
          ...options,
        }),
    ).toThrow(CtxlaneIdentityProtocolError);
  });

  it.each([
    "https://example.com",
    "unix://relative/path",
    "unix:///private/ctxlane.sock?query=1",
    "unix:///private/ctxlane.sock#fragment",
    "unix://user@/private/ctxlane.sock",
    "unix:///private/ctxlane/../ctxlane.sock",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(
      () =>
        new CtxlaneNativeSeqpacketAutomationClient({
          ...validOptions,
          endpoint,
        }),
    ).toThrow(CtxlaneIdentityProtocolError);
  });

  it("refuses before consulting a socket on unsupported hosts", async () => {
    const client = new CtxlaneNativeSeqpacketAutomationClient(validOptions);

    await expect(client.acquire(fixtureRequest)).rejects.toThrow(
      process.platform === "linux"
        ? /native SOCK_SEQPACKET addon is unavailable|ctxlane control endpoint is not a private socket/
        : "ctxlane native SOCK_SEQPACKET transport is Linux-only",
    );
  });

  it("refuses a malformed record before native authority", async () => {
    const client = new CtxlaneNativeSeqpacketAutomationClient(validOptions);
    const malformed = {
      ...fixtureRequest,
      unbound_field: "must not cross the native boundary",
    } as CtxlaneIdentityLeaseRequest;

    await expect(client.acquire(malformed)).rejects.toThrow(
      process.platform === "linux"
        ? "ctxlane request is malformed or unbound"
        : "ctxlane native SOCK_SEQPACKET transport is Linux-only",
    );
  });

  it("refuses an oversized record before native authority", async () => {
    const client = new CtxlaneNativeSeqpacketAutomationClient({
      ...validOptions,
      maxMessageBytes: 1_024,
    });

    await expect(client.acquire(fixtureRequest)).rejects.toThrow(
      process.platform === "linux"
        ? nativeSeqpacketArtifactAvailable
          ? "ctxlane request exceeds the control limit"
          : "ctxlane native SOCK_SEQPACKET addon is unavailable"
        : "ctxlane native SOCK_SEQPACKET transport is Linux-only",
    );
  });

  it("refuses an already-cancelled request before native authority", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new CtxlaneNativeSeqpacketAutomationClient(validOptions);

    await expect(client.acquire(fixtureRequest, controller.signal)).rejects.toThrow(
      process.platform === "linux"
        ? nativeSeqpacketArtifactAvailable
          ? "ctxlane request was cancelled"
          : "ctxlane native SOCK_SEQPACKET addon is unavailable"
        : "ctxlane native SOCK_SEQPACKET transport is Linux-only",
    );
  });

  it.each([
    ["non-buffer result", {}, "ctxlane native exchange returned an invalid record"],
    ["empty record", Buffer.alloc(0), "ctxlane returned an empty response"],
    [
      "oversized record",
      Buffer.alloc(1_025, 0x20),
      "ctxlane response exceeds the control limit",
    ],
    [
      "truncated JSON record",
      Buffer.from('{"status":"active"', "utf8"),
      "ctxlane returned invalid JSON",
    ],
    [
      "duplicate-key JSON record",
      Buffer.from('{"status":"active","status":"revoked"}', "utf8"),
      "ctxlane returned invalid JSON",
    ],
    ["invalid UTF-8 record", Buffer.from([0xff]), "ctxlane returned invalid UTF-8"],
  ] as const)("rejects native %s at the record boundary", (_description, record, message) => {
    expect(() => decodeNativeSeqpacketResponse(record, 1_024)).toThrow(message);
  });

  describe.runIf(nativeSeqpacketArtifactAvailable)(
    "Linux native addon argument boundary",
    () => {
      it("rejects a record larger than the configured bound synchronously", () => {
        const addon = loadNativeSeqpacketAddonFixture();

        expect(() =>
          addon.exchange(
            "/private/ctxlane.sock",
            Buffer.from(JSON.stringify(fixtureRequest), "utf8"),
            1_024,
            1_000,
            process.execPath,
            "0::/run/ctxlane",
            [process.getuid?.() ?? 0],
          ),
        ).toThrow("ctxlane native exchange arguments are outside safe bounds");
      });

      it("rejects an overlong pathname synchronously", () => {
        const addon = loadNativeSeqpacketAddonFixture();

        expect(() =>
          addon.exchange(
            `/private/${"x".repeat(100)}`,
            Buffer.from("{}", "utf8"),
            1_024,
            1_000,
            process.execPath,
            "0::/run/ctxlane",
            [process.getuid?.() ?? 0],
          ),
        ).toThrow("ctxlane native exchange arguments are outside safe bounds");
      });

      it("rejects a missing private endpoint without stream fallback", async () => {
        const client = new CtxlaneNativeSeqpacketAutomationClient(validOptions);

        await expect(client.acquire(fixtureRequest)).rejects.toThrow(
          /ctxlane control endpoint is not a private socket|ctxlane native exchange failed|ctxlane control connection failed/,
        );
      });
    },
  );

  describe.runIf(nativeSeqpacketArtifactAvailable)(
    "Linux native addon live seqpacket fixture",
    () => {
      it("round-trips one record while attesting the live peer executable and cgroup", async () => {
        // The native transport intentionally rejects world-writable ancestors.
        // Keep the live fixture below the protected checkout instead of /tmp,
        // whose sticky bit would make the production boundary reject it.
        const fixtureRoot = mkdtempSync(
          join(process.cwd(), "node_modules", ".runmill-ctxlane-seqpacket-"),
        );
        const socketPath = join(fixtureRoot, "ctxlane.sock");
        const pythonServer = spawn(
          "python3",
          [
            "-c",
            [
              "import json, os, socket, sys",
              "path = sys.argv[1]",
              "server = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)",
              "server.bind(path)",
              "os.chmod(path, 0o600)",
              "server.listen(1)",
              "print('ready', flush=True)",
              "connection, _ = server.accept()",
              "connection.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)",
              "request = connection.recv(262144)",
              "decoded = json.loads(request.decode('utf-8'))",
              "response = {'schema': 'ctxlane.live-fixture-response/v1', 'client_request_id': decoded['client_request_id']} ",
              "connection.send(json.dumps(response, separators=(',', ':')).encode('utf-8'))",
              // Keep the peer alive until the native client has completed its
              // post-response attestation and closed the connected socket.
              "connection.recv(1)",
              "connection.close()",
              "server.close()",
            ].join("\n"),
            socketPath,
          ],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        const stdout = createInterface({ input: pythonServer.stdout });
        try {
          await new Promise<void>((resolve, reject) => {
            const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
              reject(new Error(`seqpacket fixture exited before ready (${code ?? signal ?? "unknown"})`));
            };
            pythonServer.once("exit", onExit);
            stdout.once("line", (line) => {
              pythonServer.off("exit", onExit);
              if (line !== "ready") {
                reject(new Error(`unexpected seqpacket fixture readiness: ${line}`));
                return;
              }
              resolve();
            });
          });

          if (pythonServer.pid === undefined) {
            throw new Error("seqpacket fixture has no child pid");
          }
          const peerExecutable = realpathSync(`/proc/${pythonServer.pid}/exe`);
          const peerCgroup = readFileSync(`/proc/${pythonServer.pid}/cgroup`, "utf8").trim();
          const client = new CtxlaneNativeSeqpacketAutomationClient({
            endpoint: `unix://${socketPath}`,
            expectedPeerExecutable: peerExecutable,
            expectedPeerCgroup: peerCgroup,
            trustedOwnerUids: [0, process.getuid?.() ?? 0],
          });

          await expect(client.acquire(fixtureRequest)).resolves.toEqual({
            schema: "ctxlane.live-fixture-response/v1",
            client_request_id: fixtureRequest.client_request_id,
          });
          await new Promise<void>((resolve, reject) => {
            pythonServer.once("exit", (code, signal) =>
              code === 0
                ? resolve()
                : reject(new Error(`seqpacket fixture failed (${code ?? signal ?? "unknown"})`)),
            );
          });
        } finally {
          stdout.close();
          if (!pythonServer.killed && pythonServer.exitCode === null) {
            pythonServer.kill("SIGTERM");
          }
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      });

      it("refuses the same live endpoint when peer cgroup policy is tampered", async () => {
        const fixtureRoot = mkdtempSync(
          join(process.cwd(), "node_modules", ".runmill-ctxlane-seqpacket-"),
        );
        const socketPath = join(fixtureRoot, "ctxlane.sock");
        const pythonServer = spawn(
          "python3",
          [
            "-c",
            [
              "import os, socket, sys, time",
              "path = sys.argv[1]",
              "server = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)",
              "server.bind(path)",
              "os.chmod(path, 0o600)",
              "server.listen(1)",
              "print('ready', flush=True)",
              "connection, _ = server.accept()",
              "time.sleep(2)",
            ].join("\n"),
            socketPath,
          ],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        const stdout = createInterface({ input: pythonServer.stdout });
        try {
          await new Promise<void>((resolve, reject) => {
            const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
              reject(new Error(`seqpacket fixture exited before ready (${code ?? signal ?? "unknown"})`));
            };
            pythonServer.once("exit", onExit);
            stdout.once("line", (line) => {
              pythonServer.off("exit", onExit);
              if (line === "ready") {
                resolve();
              } else {
                reject(new Error("fixture was not ready"));
              }
            });
          });
          if (pythonServer.pid === undefined) throw new Error("seqpacket fixture has no child pid");
          const client = new CtxlaneNativeSeqpacketAutomationClient({
            endpoint: `unix://${socketPath}`,
            expectedPeerExecutable: realpathSync(`/proc/${pythonServer.pid}/exe`),
            expectedPeerCgroup: "0::/tampered-by-test",
            trustedOwnerUids: [0, process.getuid?.() ?? 0],
            timeoutMs: 500,
          });
          await expect(client.acquire(fixtureRequest)).rejects.toThrow(
            "ctxlane peer cgroup does not match policy",
          );
        } finally {
          stdout.close();
          if (!pythonServer.killed && pythonServer.exitCode === null) {
            pythonServer.kill("SIGTERM");
          }
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      });
    },
  );
});
