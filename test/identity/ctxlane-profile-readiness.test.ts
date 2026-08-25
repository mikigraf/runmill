import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CtxlaneMcpProfileReadinessProbe,
  CtxlaneProfileReadinessProbeError,
  toCtxlaneProfileReadinessObservationEnvelope,
} from "../../src/identity/ctxlane-profile-readiness.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const READY = {
  schema: "ctxlane.automation-readiness/v1",
  profile_uid: "profile_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  profile_ref: "codex:automation-production",
  provider: "codex",
  auth_mode: "wif",
  environment: "production",
  role: "implementer",
  ready: true,
  isolation: "credential-isolated",
  authentication_exception_acknowledged: false,
  isolation_exception_acknowledged: false,
  checked_at: "2026-08-21T10:00:00Z",
  valid_until: "2026-08-21T10:05:00Z",
  probe_cost: "provider-request-incurred",
  probe_timeout_milliseconds: 5000,
  probe_interactive: false,
  checks: {
    "metadata-valid": { status: "pass", reason_code: null },
    "credential-source-available": { status: "pass", reason_code: null },
    "identity-token-current": { status: "pass", reason_code: null },
    "harness-trusted": { status: "pass", reason_code: null },
    "provider-principal-verified": { status: "pass", reason_code: null },
    "expected-tenant-verified": { status: "pass", reason_code: null },
    "automation-policy-permits": { status: "pass", reason_code: null },
    "credential-isolation-proven": { status: "pass", reason_code: null },
  },
} as const;

let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function fixture(source: string) {
  directory = mkdtempSync(join(process.cwd(), "node_modules", ".runmill-ctxlane-readiness-"));
  const privateDirectory = directory;
  const executable = join(privateDirectory, "ctxlane-fake");
  const root = join(privateDirectory, "ctxlane-root");
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return { executable, root };
}

function respondingFixture(result: unknown, source = "") {
  return fixture(
    `${source}\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.stdout.write(${JSON.stringify(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n`,
    )}));`,
  );
}

const REQUEST = {
  clientRequestId: "req_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  profileUid: READY.profile_uid,
  profileRef: READY.profile_ref,
  environment: READY.environment,
  role: READY.role,
} as const;

describe("CtxlaneMcpProfileReadinessProbe", () => {
  it("sends the published profile-check params and returns observation only", async () => {
    const paths = fixture(`
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const request = JSON.parse(input);
        if (request.method !== "ctxlane_check_profile" || request.params.client_request_id !== "req_01ARZ3NDEKTSV4RRFFQ69G5FAV" || request.params.profile_ref !== "codex:automation-production" || request.params.profile_uid !== "profile_01ARZ3NDEKTSV4RRFFQ69G5FAV" || request.params.environment !== "production" || request.params.role !== "implementer" || request.params.probe_timeout_milliseconds !== 5000) process.exit(9);
        process.stdout.write(${JSON.stringify(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: READY })}\n`)});
      });
    `);
    const probe = new CtxlaneMcpProfileReadinessProbe({
      executable: paths.executable,
      root: paths.root,
      ...REQUEST,
      timeoutMs: 5000,
    });
    await expect(probe.probe()).resolves.toEqual(READY);

    const envelope = toCtxlaneProfileReadinessObservationEnvelope(
      READY,
      REQUEST,
      new FakeClock("2026-08-25T10:11:12Z"),
    );
    expect(envelope).toMatchObject({
      transport: "ctxlane-mcp-stdio",
      qualification: "authenticated-observation-only",
      observed_at: "2026-08-25T10:11:12.000Z",
      request: {
        profile_uid: REQUEST.profileUid,
        profile_ref: REQUEST.profileRef,
        environment: REQUEST.environment,
        role: REQUEST.role,
      },
      readiness: READY,
    });
  });

  it("rejects malformed, refused, and differently-bound readiness results", async () => {
    const cases: Array<[string, string]> = [
      ["malformed JSON", "not-json\n"],
      ["wrong request id", `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: READY })}\n`],
      ["service error", `${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000 } })}\n`],
      [
        "different profile",
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { ...READY, profile_ref: "codex:other-profile" },
        })}\n`,
      ],
    ];
    for (const [label, output] of cases) {
      const paths = respondingFixture(undefined, `process.stdout.write(${JSON.stringify(output)}); process.exit(0);`);
      const probe = new CtxlaneMcpProfileReadinessProbe({ ...paths, ...REQUEST });
      await expect(probe.probe(), label).rejects.toBeInstanceOf(CtxlaneProfileReadinessProbeError);
    }
  });

  it("fails closed on invalid requests, cancellation, and unsafe paths", async () => {
    expect(() =>
      new CtxlaneMcpProfileReadinessProbe({
        executable: "ctxlane",
        root: "/tmp/runmill-root",
        ...REQUEST,
      }),
    ).not.toThrow();
    const invalid = new CtxlaneMcpProfileReadinessProbe({
      executable: "ctxlane",
      root: "/tmp/runmill-root",
      ...REQUEST,
    });
    await expect(invalid.probe()).rejects.toMatchObject({ reason: "invalid-options" });

    const paths = respondingFixture(READY);
    const controller = new AbortController();
    controller.abort();
    await expect(new CtxlaneMcpProfileReadinessProbe({ ...paths, ...REQUEST }).probe(controller.signal)).rejects.toMatchObject({
      reason: "cancelled",
    });
  });
});
