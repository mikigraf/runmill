import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const MAX_PACKED_BYTES = 1_000_000;
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "runmill-package-"));

try {
  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryDirectory],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const [packed] = JSON.parse(packOutput);
  if (packed === undefined) throw new Error("npm pack returned no package");

  if (packed.size > MAX_PACKED_BYTES) {
    throw new Error(
      `packed package is ${packed.size.toLocaleString()} bytes; budget is ${MAX_PACKED_BYTES.toLocaleString()} bytes`,
    );
  }

  const paths = packed.files.map((file) => file.path);
  const binTarget = packageJson.bin.runmill.replace(/^\.\//, "");
  if (!paths.includes(binTarget)) throw new Error(`package is missing binary target ${binTarget}`);
  if (paths.some((path) => path.startsWith("assets/"))) {
    throw new Error("package contains marketing assets; keep them in the repository, not the CLI tarball");
  }

  const tarball = join(temporaryDirectory, packed.filename);
  const prefix = join(temporaryDirectory, "install");
  const npmEnvironment = {
    ...process.env,
    npm_config_cache: join(temporaryDirectory, "npm-cache"),
    npm_config_update_notifier: "false",
  };
  execFileSync(
    "npm",
    ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarball],
    { stdio: "inherit", env: npmEnvironment },
  );

  const executable = process.platform === "win32"
    ? join(prefix, "runmill.cmd")
    : join(prefix, "bin", "runmill");
  const version = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    env: { ...npmEnvironment, PATH: `${join(prefix, "bin")}${delimiter}${process.env.PATH ?? ""}` },
  }).trim();
  if (version !== packageJson.version) {
    throw new Error(`installed CLI reported ${version}; package.json declares ${packageJson.version}`);
  }

  const demoDirectory = join(temporaryDirectory, "demo-cwd");
  mkdirSync(demoDirectory);
  const demoOutput = execFileSync(executable, ["--json", "demo"], {
    cwd: demoDirectory,
    encoding: "utf8",
    env: {
      ...npmEnvironment,
      PATH: `${join(prefix, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      LINEAR_API_KEY: "",
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    },
  });
  const demo = JSON.parse(demoOutput);
  if (demo.temporary !== true || demo.outcome?.finalState !== "PR_DELIVERED") {
    throw new Error("installed CLI demo did not complete the temporary delivery loop");
  }

  process.stdout.write(
    `Package smoke passed: ${packed.filename}, ${packed.size.toLocaleString()} bytes, ` +
      `runmill ${version}, demo ${demo.outcome.finalState}.\n`,
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
