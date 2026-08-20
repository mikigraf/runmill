/**
 * The schema that ships beside a generated config.
 *
 * `runmill init` and `runmill config create` both emit a config whose first
 * line is `# yaml-language-server: $schema=./runmill.schema.json`. That header
 * is a promise about a file on disk: if it is not there, every YAML-aware
 * editor opens runmill.yaml on a "cannot load schema" error and none of the
 * completion it advertises works.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPackagedSchema,
  writeSchemaBeside,
  SCHEMA_FILENAME,
} from "../../src/config/schema-asset.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runmill-schema-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readPackagedSchema", () => {
  it("finds the schema the package ships", () => {
    const schema = readPackagedSchema();

    expect(schema).toBeDefined();
    expect(() => JSON.parse(schema as string)).not.toThrow();
  });

  it("returns the schema for runmill.yaml, not some other document", () => {
    const schema = JSON.parse(readPackagedSchema() as string) as {
      properties?: Record<string, unknown>;
    };

    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["version", "autonomy", "providers", "backlog", "github"]),
    );
  });
});

describe("writeSchemaBeside", () => {
  it("puts the schema next to the config that references it", () => {
    const configPath = join(dir, "runmill.yaml");
    writeFileSync(configPath, "version: 1\n");

    expect(writeSchemaBeside(configPath)).toBe(true);
    expect(existsSync(join(dir, SCHEMA_FILENAME))).toBe(true);
  });

  it("uses the exact filename the config header points at", () => {
    const configPath = join(dir, "runmill.yaml");
    writeFileSync(configPath, "version: 1\n");
    writeSchemaBeside(configPath);

    // The header is `$schema=./runmill.schema.json`, relative to the config.
    expect(SCHEMA_FILENAME).toBe("runmill.schema.json");
    expect(existsSync(join(dir, "runmill.schema.json"))).toBe(true);
  });

  it("follows the config when it lives somewhere other than the repo root", () => {
    // `runmill --config path/to/runmill.yaml` is supported, and the header is
    // relative, so the schema belongs beside the config rather than the cwd.
    const nested = join(dir, "config", "runmill.yaml");
    writeSchemaBeside(nested);

    expect(existsSync(join(dir, "config", SCHEMA_FILENAME))).toBe(true);
  });

  it("never clobbers a schema that is already there", () => {
    // Once written it is the operator's file. A pinned or edited copy has to
    // survive re-running init or config create.
    const configPath = join(dir, "runmill.yaml");
    writeFileSync(join(dir, SCHEMA_FILENAME), '{"mine": true}');

    expect(writeSchemaBeside(configPath)).toBe(false);
    expect(readFileSync(join(dir, SCHEMA_FILENAME), "utf8")).toBe('{"mine": true}');
  });
});
