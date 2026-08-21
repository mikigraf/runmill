import { tryGit } from "../platform/git.js";

/** Parse the owner/name identity accepted by the GitHub forge adapter. */
export function parseGitHubRepository(remote: string): string | undefined {
  const trimmed = remote.trim();
  let path: string | undefined;

  const scp = trimmed.match(/^(?:[^@\s]+@)?github\.com:([^\s]+)$/i);
  if (scp?.[1] !== undefined) {
    path = scp[1];
  } else {
    try {
      const url = new URL(trimmed.replace(/^git\+/, ""));
      if (url.hostname.toLowerCase() !== "github.com") return undefined;
      path = url.pathname.replace(/^\//, "");
    } catch {
      return undefined;
    }
  }

  const normalized = path.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/");
  if (segments.length !== 2 || segments.some((segment) => segment === "")) return undefined;
  return normalized;
}

/** Resolve repository identity from the exact local origin a workspace will clone. */
export async function repositoryIdentity(repoRoot: string): Promise<string | undefined> {
  const result = await tryGit(repoRoot, ["remote", "get-url", "origin"]);
  return result.ok ? parseGitHubRepository(result.stdout) : undefined;
}
