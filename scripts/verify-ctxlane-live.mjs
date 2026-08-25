import { execFileSync } from "node:child_process";
import { constants, lstatSync } from "node:fs";
import { arch, platform } from "node:process";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const required = [
  "RUNMILL_CTXLANE_BINARY",
  "RUNMILL_CTXLANE_ROOT",
  "RUNMILL_CTXLANE_CLIENT_REQUEST_ID",
  "RUNMILL_CTXLANE_PROFILE_UID",
  "RUNMILL_CTXLANE_PROFILE_REF",
  "RUNMILL_CTXLANE_ENVIRONMENT",
  "RUNMILL_CTXLANE_ROLE",
];

if (platform !== "linux") {
  throw new Error("ctxlane live qualification requires a protected Linux host");
}

const missing = required.filter((name) => {
  const value = process.env[name];
  return value === undefined || value.length === 0;
});
if (missing.length > 0) {
  throw new Error(`ctxlane live qualification is missing: ${missing.join(", ")}`);
}

const executable = process.env.RUNMILL_CTXLANE_BINARY;
const ctxlaneRoot = process.env.RUNMILL_CTXLANE_ROOT;
if (executable === undefined || ctxlaneRoot === undefined) {
  throw new Error("ctxlane live qualification inputs disappeared during validation");
}

function assertPrivatePath(path, kind) {
  if (!isAbsolute(path) || path !== normalize(path) || path.includes("\0")) {
    throw new Error(`ctxlane live qualification requires an absolute normalized ${kind}`);
  }
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error("symbolic link");
    if (kind === "executable" && (!metadata.isFile() || (metadata.mode & constants.S_IXUSR) === 0)) {
      throw new Error("not an executable regular file");
    }
    if (kind === "root" && !metadata.isDirectory()) throw new Error("not a directory");
    if ((metadata.mode & constants.S_IWGRP) !== 0 || (metadata.mode & constants.S_IWOTH) !== 0) {
      throw new Error("group/world writable");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unavailable";
    throw new Error(`ctxlane live qualification ${kind} is unavailable: ${detail}`);
  }
}

assertPrivatePath(executable, "executable");
assertPrivatePath(ctxlaneRoot, "root");

const artifact = join(
  repositoryRoot,
  "dist-native",
  `linux-${arch}`,
  "ctxlane-seqpacket.node",
);
try {
  const metadata = lstatSync(artifact);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size === 0) {
    throw new Error("not a non-empty regular file");
  }
} catch (error) {
  const detail = error?.code === "ENOENT" ? "missing" : error instanceof Error ? error.message : "unavailable";
  throw new Error(`Linux native ctxlane addon is ${detail}: ${artifact}`);
}

const vitest = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const safeEnvironment = {};
for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"]) {
  const value = process.env[name];
  if (value !== undefined) safeEnvironment[name] = value;
}
for (const name of required) safeEnvironment[name] = process.env[name];

// The live config intentionally includes only test/live/**, so native
// transport coverage must be invoked in a separate Vitest process.
const invocations = [
  ["native transport boundary", ["run", "test/identity/ctxlane-native-transport.test.ts"]],
  [
    "ctxlane observation probes",
    [
      "run",
      "--config",
      "vitest.live.config.ts",
      "test/live/ctxlane-service-health.live.test.ts",
      "test/live/ctxlane-profile-readiness.live.test.ts",
    ],
  ],
];

for (const [description, arguments_] of invocations) {
  process.stdout.write(`ctxlane live qualification: running ${description}\n`);
  execFileSync(process.execPath, [vitest, ...arguments_], {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: safeEnvironment,
  });
}

process.stdout.write(
  "ctxlane live qualification passed: native boundary and authenticated observations only; production remains unqualified\n",
);
