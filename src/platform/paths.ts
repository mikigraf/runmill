import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function findRepositoryRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      try {
        return realpathSync(current);
      } catch {
        return current;
      }
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function projectId(repoRoot: string): string {
  const canonical = findRepositoryRoot(repoRoot);
  const slug = basename(canonical)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "project";
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 10);
  return `${slug}-${digest}`;
}

/** Operator policy lives outside the repository an agent may edit. */
export function defaultConfigPath(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): string {
  const configRoot = env["XDG_CONFIG_HOME"] || join(userHome, ".config");
  return join(configRoot, "runmill", "projects", projectId(repoRoot), "policy.yaml");
}

/** Machine state is user-local and never dirties the source repository. */
export function defaultDataDir(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
  os: NodeJS.Platform = platform(),
): string {
  const explicit = env["RUNMILL_DATA_DIR"];
  if (explicit !== undefined && explicit !== "") return resolve(explicit);

  const stateRoot = env["XDG_STATE_HOME"] ||
    (os === "darwin"
      ? join(userHome, "Library", "Application Support")
      : join(userHome, ".local", "state"));
  return join(stateRoot, "runmill", "projects", projectId(repoRoot));
}
