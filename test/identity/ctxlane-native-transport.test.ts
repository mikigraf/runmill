import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
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

const validOptions = {
  endpoint: "unix:///private/ctxlane.sock",
  expectedPeerExecutable: "/usr/bin/ctxlane",
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
        const client = new CtxlaneNativeSeqpacketAutomationClient({
          ...validOptions,
          expectedPeerExecutable: process.execPath,
        });

        await expect(client.acquire(fixtureRequest)).rejects.toThrow(
          /ctxlane control endpoint is not a private socket|ctxlane native exchange failed|ctxlane control connection failed/,
        );
      });
    },
  );
});
