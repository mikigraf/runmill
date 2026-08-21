import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The filename generated policy files reference in their yaml-language-server header. */
export const SCHEMA_FILENAME = "runmill.schema.json";

/**
 * The JSON Schema shipped with the package.
 *
 * Every generated operator policy opens with
 * `# yaml-language-server: $schema=./runmill.schema.json`, which is only worth
 * anything if the file is actually beside it. It is listed in package.json
 * `files`, so this resolves from an installed package as well as from a clone.
 *
 * Returns undefined rather than throwing: a config without editor completion
 * is a worse config, not a failed command.
 */
export function readPackagedSchema(): string | undefined {
  // src/config/ and dist/config/ are both two levels below the package root.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    return readFileSync(join(root, SCHEMA_FILENAME), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Put the schema next to a config that references it.
 *
 * Never overwrites: the schema is the operator's file once it lands, and a
 * pinned or edited copy must survive a re-run. Returns whether it wrote one.
 */
export function writeSchemaBeside(configPath: string): boolean {
  const schema = readPackagedSchema();
  if (schema === undefined) return false;

  const target = join(dirname(configPath), SCHEMA_FILENAME);
  if (existsSync(target)) return false;

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, schema);
  return true;
}
