#!/usr/bin/env bun
import { resolve } from "node:path";
import { runTui } from "./app.js";

const registryIndex = process.argv.indexOf("--registry");
const registry = registryIndex < 0 ? undefined : process.argv[registryIndex + 1];

try {
  await runTui({
    ...(registry === undefined ? {} : { registryPath: resolve(registry) }),
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
