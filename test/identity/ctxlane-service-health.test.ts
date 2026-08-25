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
  CtxlaneMcpServiceHealthProbe,
  CtxlaneServiceHealthProbeError,
  toAsfCtxlaneHealthObservation,
  toCtxlaneServiceHealthObservationEnvelope,
} from "../../src/identity/ctxlane-service-health.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const HEALTH = {
  schema: "ctxlane.service-health/v1",
  process_liveness: true,
  store_available: true,
  recovery_complete: true,
  controller_channel_ready: true,
  policy_trust_root_valid: true,
  profile_readiness: false,
  harness_ready: false,
  capacity_available: false,
  audit_export_healthy: false,
  ready: false,
} as const;

let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function fixture(output: string, source = "") {
  directory = mkdtempSync(join(process.cwd(), "node_modules", ".runmill-ctxlane-health-"));
  const privateDirectory = directory;
  const executable = join(privateDirectory, "ctxlane-fake");
  const root = join(privateDirectory, "ctxlane-root");
  // The root must be a private directory, while the fake executable remains a
  // regular executable file so the probe exercises the same path checks as a
  // deployment binary.
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(
    executable,
    `#!/usr/bin/env node\n${source}\nprocess.stdout.write(${JSON.stringify(output)});\n`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
  return { executable, root };
}

describe("CtxlaneMcpServiceHealthProbe", () => {
  it("accepts only the authenticated service-health result and never exposes lease authority", async () => {
    const paths = fixture(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: HEALTH })}\n`,
    );
    const probe = new CtxlaneMcpServiceHealthProbe(paths);
    await expect(probe.probe()).resolves.toEqual(HEALTH);

    const clock = new FakeClock("2026-08-25T10:11:12Z");
    expect(toAsfCtxlaneHealthObservation(HEALTH, clock)).toEqual({
      schema: "asf.health-observation/v1",
      kind: "ctxlane",
      observed_at: "2026-08-25T10:11:12.000Z",
      data: {
        reachable: true,
        mutually_authenticated: true,
        automation_lease_probe_passed: false,
      },
    });
    expect(toCtxlaneServiceHealthObservationEnvelope(HEALTH, clock)).toMatchObject({
      transport: "ctxlane-mcp-stdio",
      qualification: "authenticated-observation-only",
      observed_at: "2026-08-25T10:11:12.000Z",
      health: HEALTH,
    });
  });

  it("rejects malformed, duplicated, contradictory, and error responses", async () => {
    const cases: Array<[string, string]> = [
      ["malformed JSON", "not-json\n"],
      [
        "duplicate response members",
        `{"jsonrpc":"2.0","id":1,"result":${JSON.stringify(HEALTH)},"result":${JSON.stringify(HEALTH)}}\n`,
      ],
      [
        "wrong request id",
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: HEALTH })}\n`,
      ],
      [
        "service error",
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000 } })}\n`,
      ],
      [
        "invalid health",
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ...HEALTH, ready: true } })}\n`,
      ],
    ];
    for (const [label, output] of cases) {
      const paths = fixture(output);
      const probe = new CtxlaneMcpServiceHealthProbe(paths);
      await expect(probe.probe(), label).rejects.toBeInstanceOf(
        CtxlaneServiceHealthProbeError,
      );
    }
  });

  it("fails closed on unsafe paths, command failures, cancellation, and timeout", async () => {
    expect(() =>
      new CtxlaneMcpServiceHealthProbe({
        executable: "ctxlane",
        root: "/tmp/runmill-root",
      }),
    ).toThrowError(expect.objectContaining({ reason: "invalid-options" }));

    const failing = fixture("", "process.exit(7);");
    await expect(new CtxlaneMcpServiceHealthProbe(failing).probe()).rejects.toMatchObject({
      reason: "command-failed",
    });

    const cancelled = fixture(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: HEALTH })}\n`,
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      new CtxlaneMcpServiceHealthProbe(cancelled).probe(controller.signal),
    ).rejects.toMatchObject({ reason: "cancelled" });

    const slow = fixture(
      "",
      "process.stdin.resume(); setTimeout(() => process.exit(0), 200);",
    );
    await expect(
      new CtxlaneMcpServiceHealthProbe({ ...slow, timeoutMs: 20 }).probe(),
    ).rejects.toMatchObject({ reason: "timed-out" });
  });
});
