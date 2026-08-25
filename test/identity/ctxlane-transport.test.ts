import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CTXLANE_NATIVE_SEQPACKET_DEPLOYMENT_CONTRACT,
  CTXLANE_NATIVE_SEQPACKET_TRANSPORT_STATUS,
  CTXLANE_UNIX_AUTOMATION_TRANSPORT_QUALIFICATION,
  CtxlaneIdentityProtocolError,
  CtxlaneNativeSeqpacketAutomationClient,
  CtxlaneUnixAutomationClient,
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

interface UnixFixtureHandler {
  (
    request: CtxlaneIdentityLeaseRequest,
    socket: Socket,
  ): Buffer | string | object | Promise<Buffer | string | object>;
}

async function unixFixture(
  handler: UnixFixtureHandler,
): Promise<{ socketPath: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "ctxlane-"));
  const socketPath = join(dir, "socket");
  const servers: Server[] = [];

  const server = createServer((socket) => {
    let buffer = "";

    const processChunk = async (chunk: Buffer): Promise<void> => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");

      if (lines.length > 1) {
        const requestLine = lines[0];
        buffer = lines.slice(1).join("\n");

        try {
          if (requestLine === undefined) throw new Error("missing request");
          const request = JSON.parse(
            requestLine,
          ) as CtxlaneIdentityLeaseRequest;
          const response = await handler(request, socket);

          if (Buffer.isBuffer(response)) {
            socket.write(response);
          } else if (typeof response === "string") {
            socket.write(response);
          } else {
            socket.write(JSON.stringify(response) + "\n");
          }
        } catch (_error) {
          socket.destroy();
        }
      }
    };
    socket.on("data", (chunk: Buffer) => {
      void processChunk(chunk);
    });
  });

  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () => {
      try {
        chmodSync(socketPath, 0o600);
        resolve();
      } catch (error) {
        reject(
          error instanceof Error ? error : new Error("socket setup failed"),
        );
      }
    });
  });

  const cleanup = () => {
    servers.forEach((s) => {
      try {
        s.close();
      } catch {}
    });
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };

  return { socketPath, cleanup };
}

describe("CtxlaneTransport", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch {}
    });
    cleanups.length = 0;
  });

  it("is explicitly classified as development-only and unqualified", () => {
    const client = new CtxlaneUnixAutomationClient({
      endpoint: "unix:///private/fixture.sock",
    });
    expect(client.qualification).toBe(
      CTXLANE_UNIX_AUTOMATION_TRANSPORT_QUALIFICATION,
    );
  });

  it("native transport refuses unsupported hosts or an unbuilt addon", async () => {
    const client = new CtxlaneNativeSeqpacketAutomationClient({
      endpoint: "unix:///private/fixture.sock",
    });
    await expect(client.acquire(fixtureRequest)).rejects.toThrow(
      process.platform === "linux"
        ? "native SOCK_SEQPACKET addon is unavailable"
        : "native SOCK_SEQPACKET transport is Linux-only",
    );
  });

  it("native transport rejects Linux sockaddr paths before native loading", () => {
    const longPath = `/private/${"x".repeat(120)}`;
    expect(
      () => new CtxlaneNativeSeqpacketAutomationClient({ endpoint: `unix://${longPath}` }),
    ).toThrow("exceeds the Linux sockaddr limit");
  });

  it("native transport requires explicit peer executable and cgroup policy", async () => {
    if (process.platform !== "linux") return;
    const client = new CtxlaneNativeSeqpacketAutomationClient({
      endpoint: "unix:///private/fixture.sock",
    });
    await expect(client.acquire(fixtureRequest)).rejects.toThrow(
      "native peer executable and cgroup policy are required",
    );
  });

  it("refuses authority over SOCK_STREAM without an explicit development opt-in", async () => {
    const { socketPath, cleanup } = await unixFixture(() => {
      throw new Error("unqualified stream must not contact the handler");
    });
    cleanups.push(cleanup);

    const client = new CtxlaneUnixAutomationClient({
      endpoint: `unix://${socketPath}`,
    });
    await expect(client.acquire(fixtureRequest)).rejects.toThrow(
      "native authenticated SOCK_SEQPACKET transport is unavailable",
    );
  });

  it("publishes an unqualified native deployment contract without claiming qualification", () => {
    const client = new CtxlaneUnixAutomationClient({
      endpoint: "unix:///private/fixture.sock",
    });
    expect(CTXLANE_NATIVE_SEQPACKET_DEPLOYMENT_CONTRACT).toMatchObject({
      schema: "ctxlane.runmill-native-seqpacket-contract/v1",
      status: CTXLANE_NATIVE_SEQPACKET_TRANSPORT_STATUS,
      addressFamily: "AF_UNIX",
      socketType: "SOCK_SEQPACKET",
      helperProcessAllowed: false,
      streamFallbackAllowed: false,
      lifecycleStatus: "private-lifecycle-response-not-published",
    });
    expect(client.qualification).not.toBe("native-seqpacket-authenticated");
  });

  it("exact direct request is observed and response resolves", async () => {
    const { socketPath, cleanup } = await unixFixture((request) => {
      expect(request).toEqual(fixtureRequest);
      return { success: true, acquired: true };
    });
    cleanups.push(cleanup);

    const client = new CtxlaneUnixAutomationClient({
      endpoint: `unix://${socketPath}`,
      allowDevelopmentOnlyTransport: true,
    });
    const response = await client.acquire(fixtureRequest);
    expect(response).toBeDefined();
  });

  it("group/world-writable socket refused before handler", async () => {
    const { socketPath, cleanup } = await unixFixture(() => {
      throw new Error("handler should not be called");
    });
    cleanups.push(cleanup);

    chmodSync(socketPath, 0o666);
    const client = new CtxlaneUnixAutomationClient({
      endpoint: `unix://${socketPath}`,
      allowDevelopmentOnlyTransport: true,
    });

    await expect(client.acquire(fixtureRequest)).rejects.toThrow(
      CtxlaneIdentityProtocolError,
    );
  });

  it("writable directory refused before handler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxlane-"));
    const socketPath = join(dir, "socket");

    const server = createServer(() => {
      throw new Error("handler should not be called");
    });

    await new Promise<void>((resolve) => {
      server.listen(socketPath, () => {
        chmodSync(socketPath, 0o600);
        resolve();
      });
    });

    chmodSync(dir, 0o777);

    cleanups.push(() => {
      try {
        server.close();
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    });

    const client = new CtxlaneUnixAutomationClient({
      endpoint: `unix://${socketPath}`,
      allowDevelopmentOnlyTransport: true,
    });
    await expect(client.acquire(fixtureRequest)).rejects.toThrow(
      CtxlaneIdentityProtocolError,
    );
  });

  it("malformed request with extra field refused before contact", async () => {
    const { socketPath, cleanup } = await unixFixture(() => {
      throw new Error("handler should not be called");
    });
    cleanups.push(cleanup);

    const malformed = {
      ...fixtureRequest,
      extraField: "invalid",
    } as CtxlaneIdentityLeaseRequest;
    const client = new CtxlaneUnixAutomationClient({
      endpoint: `unix://${socketPath}`,
      allowDevelopmentOnlyTransport: true,
    });

    await expect(client.acquire(malformed)).rejects.toThrow(
      CtxlaneIdentityProtocolError,
    );
  });

  it("signed/top-level mismatch refused before contact", async () => {
    const { socketPath, cleanup } = await unixFixture(() => {
      throw new Error("handler should not be called");
    });
    cleanups.push(cleanup);

    const mismatch = {
      ...fixtureRequest,
      tenant_id: "tenant-other",
    } as CtxlaneIdentityLeaseRequest;
    const client = new CtxlaneUnixAutomationClient({
      endpoint: `unix://${socketPath}`,
      allowDevelopmentOnlyTransport: true,
    });

    await expect(client.acquire(mismatch)).rejects.toThrow(
      CtxlaneIdentityProtocolError,
    );
  });

  it("invalid UTF-8 response rejects with fixed message", async () => {
    const { socketPath, cleanup } = await unixFixture(() => {
      return Buffer.from([0xff, 0xfe]);
    });
    cleanups.push(cleanup);

    const client = new CtxlaneUnixAutomationClient({
      endpoint: `unix://${socketPath}`,
      allowDevelopmentOnlyTransport: true,
    });
    await expect(client.acquire(fixtureRequest)).rejects.toThrow(
      "ctxlane returned invalid UTF-8",
    );
  });

  it("raw duplicate-key JSON response rejects with fixed invalid JSON message", async () => {
    const { socketPath, cleanup } = await unixFixture(() => {
      return '{"key":"value1","key":"value2"}\n';
    });
    cleanups.push(cleanup);

    const client = new CtxlaneUnixAutomationClient({
      endpoint: `unix://${socketPath}`,
      allowDevelopmentOnlyTransport: true,
    });
    await expect(client.acquire(fixtureRequest)).rejects.toThrow(
      "ctxlane returned invalid JSON",
    );
  });

  it("trickled response hits absolute 40ms timeout", async () => {
    const { socketPath, cleanup } = await unixFixture((_, socket) => {
      socket.write('{"');
      return new Promise(() => {});
    });
    cleanups.push(cleanup);

    const client = new CtxlaneUnixAutomationClient({
      endpoint: `unix://${socketPath}`,
      timeoutMs: 40,
      allowDevelopmentOnlyTransport: true,
    });
    await expect(client.acquire(fixtureRequest)).rejects.toThrow(
      "ctxlane request timed out",
    );
  });

  it("no response hits absolute 40ms timeout", async () => {
    const { socketPath, cleanup } = await unixFixture(() => {
      return new Promise(() => {});
    });
    cleanups.push(cleanup);

    const client = new CtxlaneUnixAutomationClient({
      endpoint: `unix://${socketPath}`,
      timeoutMs: 40,
      allowDevelopmentOnlyTransport: true,
    });
    await expect(client.acquire(fixtureRequest)).rejects.toThrow(
      "ctxlane request timed out",
    );
  });

  it("unsafe https endpoint throws", () => {
    expect(
      () =>
        new CtxlaneUnixAutomationClient({ endpoint: "https://example.com" }),
    ).toThrow(CtxlaneIdentityProtocolError);
  });

  it("relative unix path throws", () => {
    expect(
      () =>
        new CtxlaneUnixAutomationClient({ endpoint: "unix://relative/path" }),
    ).toThrow(CtxlaneIdentityProtocolError);
  });

  it("query string in endpoint throws", () => {
    expect(
      () =>
        new CtxlaneUnixAutomationClient({
          endpoint: "unix:///tmp/socket?query=1",
        }),
    ).toThrow(CtxlaneIdentityProtocolError);
  });

  it("userinfo in endpoint throws", () => {
    expect(
      () =>
        new CtxlaneUnixAutomationClient({
          endpoint: "unix://user@/tmp/socket",
        }),
    ).toThrow(CtxlaneIdentityProtocolError);
  });

  it("control characters in endpoint throws", () => {
    expect(
      () =>
        new CtxlaneUnixAutomationClient({ endpoint: "unix:///tmp/socket\n" }),
    ).toThrow(CtxlaneIdentityProtocolError);
  });

  it("timeout 30001 throws", () => {
    expect(
      () =>
        new CtxlaneUnixAutomationClient({
          endpoint: "unix:///tmp/socket",
          timeoutMs: 30_001,
        }),
    ).toThrow(CtxlaneIdentityProtocolError);
  });
});
