import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { arch, platform } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The native transport is a Linux deployment artifact.  Source builds on
 * macOS/Windows intentionally do not produce a lookalike module: the
 * TypeScript client will report the transport as unavailable there.
 */
if (platform !== "linux") {
  // Keep npm's `pack --json` stdout machine-readable when prepare runs this
  // script as part of a package smoke check.
  process.stderr.write("ctxlane native transport: skipped (Linux only)\n");
  process.exit(0);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "native", "ctxlane_seqpacket.c");
const outputDirectory = join(root, "dist-native", `linux-${arch}`);
const output = join(outputDirectory, "ctxlane-seqpacket.node");
mkdirSync(outputDirectory, { recursive: true });

const candidates = [process.env.CC, "cc", "gcc", "clang"].filter(
  (candidate) => candidate !== undefined && candidate.length > 0,
);
const nodeIncludeCandidates = [
  process.env.NODE_INCLUDE,
  "/usr/include/node",
  "/usr/local/include/node",
].filter((candidate) => candidate !== undefined && existsSync(candidate));

if (nodeIncludeCandidates.length === 0) {
  throw new Error(
    "ctxlane native transport requires Node headers (set NODE_INCLUDE to their directory)",
  );
}

let lastError = "";
for (const compiler of candidates) {
  try {
    execFileSync(
      compiler,
      [
        "-shared",
        "-fPIC",
        "-O2",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        `-I${nodeIncludeCandidates[0]}`,
        source,
        "-o",
        output,
      ],
      { cwd: root, stdio: "inherit" },
    );
    process.stderr.write(`ctxlane native transport: built ${output}\n`);
    process.exit(0);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
}

throw new Error(`ctxlane native transport compiler unavailable: ${lastError}`);
