import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/platform/process.js";
import { parseProductionModeConfig } from "../../src/asf/production-readiness.js";
import { ASF_FIRST_PARTY_COMPOSITION_MANIFEST } from "../../src/asf/first-party-composition.js";

const CLI = resolve(process.cwd(), "src/cli/main.ts");
const TSX = resolve(process.cwd(), "node_modules/.bin/tsx");

let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("runmill service doctor", () => {
  it("ships a schema-valid credential-free ASF configuration sample", () => {
    const path = resolve(process.cwd(), "examples/asf-worker/production-mode.json");
    const source = readFileSync(path, "utf8");
    const config = parseProductionModeConfig(JSON.parse(source) as unknown);
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { files?: unknown };

    expect(config.mode).toBe("asf-worker");
    expect(packageJson.files).toContain("examples/asf-worker");
    expect(source).not.toMatch(/BEGIN (?:OPENSSH|[A-Z ]+) PRIVATE KEY/u);
    expect(source).not.toMatch(/(?:token|secret|password|credential)\s*:/iu);
    expect(source).toContain("replace-with-work-order-key");
    expect(source).toContain("replace-with-controller-id");
  });

  it("evaluates a standalone document without opening ASF state or sockets", async () => {
    directory = mkdtempSync(join(tmpdir(), "runmill-service-doctor-"));
    const config = join(directory, "standalone.json");
    writeFileSync(
      config,
      JSON.stringify({ schema: "runmill.production-mode/v1", mode: "standalone" }),
      { mode: 0o600 },
    );

    const result = await run(TSX, [CLI, "--json", "service", "doctor", "--config", config], {
      cwd: directory,
      env: { ...process.env, RUNMILL_DATA_DIR: join(directory, "unopened-state") },
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "standalone",
      decision: "ready",
      readyToStart: true,
      asfProductionReady: false,
      observationPath: null,
      observationAttestation: null,
    });
  });

  it("surfaces the first-party composition gap report for asf-worker mode", async () => {
    const config = resolve(process.cwd(), "examples/asf-worker/production-mode.json");

    const result = await run(TSX, [CLI, "--json", "service", "doctor", "--config", config], {
      cwd: process.cwd(),
      env: process.env,
    });

    const parsed = JSON.parse(result.stdout) as {
      firstPartyComposition?: { productionQualified?: unknown };
    };
    expect(parsed).toMatchObject({
      mode: "asf-worker",
      firstPartyComposition: ASF_FIRST_PARTY_COMPOSITION_MANIFEST,
    });
    expect(parsed.firstPartyComposition?.productionQualified).toBe(false);
  });

  it("omits the first-party composition gap report for standalone mode", async () => {
    directory = mkdtempSync(join(tmpdir(), "runmill-service-doctor-standalone-"));
    const config = join(directory, "standalone.json");
    writeFileSync(
      config,
      JSON.stringify({ schema: "runmill.production-mode/v1", mode: "standalone" }),
      { mode: 0o600 },
    );

    const result = await run(TSX, [CLI, "--json", "service", "doctor", "--config", config], {
      cwd: directory,
      env: { ...process.env, RUNMILL_DATA_DIR: join(directory, "unopened-state") },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "standalone",
      firstPartyComposition: null,
    });
  });

  it("fails closed on invalid configuration documents", async () => {
    directory = mkdtempSync(join(tmpdir(), "runmill-service-doctor-invalid-"));
    const config = join(directory, "invalid.json");
    writeFileSync(config, "{\"mode\":\"asf-worker\"}", { mode: 0o600 });

    const result = await run(TSX, [CLI, "--json", "service", "doctor", "--config", config], {
      cwd: directory,
      env: process.env,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Production mode configuration is invalid");
  });

  it("does not evaluate an unsigned readiness observation", async () => {
    directory = mkdtempSync(join(tmpdir(), "runmill-service-doctor-unsigned-"));
    const config = resolve(process.cwd(), "examples/asf-worker/production-mode.json");
    const observation = join(directory, "observation.json");
    writeFileSync(
      observation,
      JSON.stringify({ schema: "asf.production-readiness-observation/v1" }),
      { mode: 0o600 },
    );

    const result = await run(
      TSX,
      [
        CLI,
        "--json",
        "service",
        "doctor",
        "--config",
        config,
        "--observation",
        observation,
      ],
      { cwd: process.cwd(), env: process.env },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "requires --observation-key and --observation-key-id",
    );
  });
});
