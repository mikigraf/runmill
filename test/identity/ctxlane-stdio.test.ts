import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CTXLANE_STDIO_AUTOMATION_TRANSPORT_QUALIFICATION,
  CtxlaneIdentityProtocolError,
  CtxlaneStdioAutomationClient,
} from "../../src/identity/ctxlane-transport.js";
import type { CtxlaneIdentityLeaseRequest } from "../../src/identity/ctxlane-contracts.js";

const REQUEST = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "..",
      "fixtures",
      "ctxlane",
      "examples",
      "identity-lease-request.v1.json",
    ),
    "utf8",
  ),
) as CtxlaneIdentityLeaseRequest;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function executable(script: string): { path: string; digest: string } {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "runmill-ctxlane-stdio-"),
  );
  const path = join(directory, "ctxlane");
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const digest = `sha256:${createHash("sha256")
    .update(readFileSync(path))
    .digest("hex")}`;
  return { path, digest };
}

function client(path: string, digest: string, timeoutMs = 1_000) {
  return new CtxlaneStdioAutomationClient({
    executable: path,
    executableSha256: digest,
    timeoutMs,
    trustedOwnerUids: [process.getuid?.() ?? 0],
  });
}

describe("CtxlaneStdioAutomationClient", () => {
  it("pins the executable, uses fixed args, and clears its environment", async () => {
    const target = executable(
      'read _request; printf \'{"jsonrpc":"2.0","id":"req-1","result":{"ok":true,"args":"%s %s %s","home":"%s"}}\\n\' "$1" "$2" "$3" "${HOME-}"',
    );
    const bridge = client(target.path, target.digest);
    expect(bridge.qualification).toBe(
      CTXLANE_STDIO_AUTOMATION_TRANSPORT_QUALIFICATION,
    );
    await expect(
      bridge.call("ctxlane_health", {}, "req-1"),
    ).resolves.toEqual({
      jsonrpc: "2.0",
      id: "req-1",
      result: {
        ok: true,
        args: "mcp serve --stdio",
        home: "",
      },
    });
  });

  it("does not expose acquisition authority or capability-bearing MCP methods", async () => {
    const target = executable(
      'read _request; printf \'{"jsonrpc":"2.0","id":"req-1","result":{}}\\n\'',
    );
    const bridge = client(target.path, target.digest);
    expect(bridge).not.toHaveProperty("acquire");
    await expect(
      bridge.call("ctxlane_acquire_identity_lease", REQUEST, "req-1"),
    ).rejects.toThrow("observation methods only");
  });

  it("refuses a digest mismatch and a symlink before spawning", async () => {
    const target = executable("read _request; printf '{}\\n'");
    const link = join(target.path, "..", "link");
    symlinkSync(target.path, link);
    cleanups.push(() => rmSync(link, { force: true }));
    await expect(
      new CtxlaneStdioAutomationClient({
        executable: target.path,
        executableSha256: `sha256:${"0".repeat(64)}`,
        trustedOwnerUids: [process.getuid?.() ?? 0],
      }).call("ctxlane_health", {}, "req-1"),
    ).rejects.toBeInstanceOf(CtxlaneIdentityProtocolError);
    await expect(
      new CtxlaneStdioAutomationClient({
        executable: link,
        executableSha256: target.digest,
        trustedOwnerUids: [process.getuid?.() ?? 0],
      }).call("ctxlane_health", {}, "req-1"),
    ).rejects.toBeInstanceOf(CtxlaneIdentityProtocolError);
  });

  it("terminates a non-responsive adapter on timeout", async () => {
    const target = executable("sleep 10");
    await expect(
      client(target.path, target.digest, 30).call(
        "ctxlane_health",
        {},
        "req-1",
      ),
    ).rejects.toThrow("ctxlane request timed out");
  });
});
