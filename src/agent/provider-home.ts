import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ProviderSessionHome {
  /** The disposable HOME handed to the provider and every tool it launches. */
  readonly path: string;
  /** Idempotently removes the copied credentials and all provider-written state. */
  cleanup(): void;
}

type ConfigPaths = (home: string) => readonly string[];

/** True when `candidate` is `root` or a descendant of it. */
function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Copy a provider config tree without carrying links back to the operator's home.
 *
 * Symlinks are resolved before copying and become ordinary private files or
 * directories in the destination. A nested link that escapes the resolved
 * config root is rejected: following it could silently copy an unrelated SSH
 * key, cloud profile, device, or an unbounded part of the filesystem into the
 * agent-visible home. The exact allowlisted authentication file may be an
 * outside symlink (as with a dotfiles manager), but is copied as a regular
 * private file. Sockets and other special files are omitted.
 */
function copyPrivateTree(
  source: string,
  destination: string,
  boundary: string,
  ancestors: ReadonlySet<string> = new Set(),
  allowExternalFile = false,
): void {
  const resolvedSource = realpathSync(source);
  const sourceStat = statSync(resolvedSource);
  if (!isWithin(boundary, resolvedSource) && !(allowExternalFile && sourceStat.isFile())) {
    throw new Error(`Provider config symlink escapes its source directory: ${source}`);
  }

  if (sourceStat.isDirectory()) {
    if (ancestors.has(resolvedSource)) {
      throw new Error(`Provider config contains a symlink cycle: ${source}`);
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(resolvedSource);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    chmodSync(destination, 0o700);
    for (const entry of readdirSync(resolvedSource)) {
      copyPrivateTree(
        join(resolvedSource, entry),
        join(destination, entry),
        boundary,
        nextAncestors,
        false,
      );
    }
    return;
  }

  if (!sourceStat.isFile()) return;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(resolvedSource, destination);
  // Provider config can contain access and refresh tokens. Do not preserve a
  // permissive source mode in the disposable copy.
  chmodSync(destination, 0o600);
}

/** Restore owner access without following links a tool may have created. */
function makeRemovable(path: string): void {
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(path);
  } catch {
    return;
  }
  if (entry.isSymbolicLink()) return;
  if (!entry.isDirectory()) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // rmSync below reports an unrecoverable filesystem error if needed.
    }
    return;
  }

  try {
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) makeRemovable(join(path, child));
  } catch {
    // rmSync below remains the single authoritative cleanup operation.
  }
}

/**
 * Build a private, disposable HOME for one provider invocation.
 *
 * Only the dialect's allowlisted authentication entries are copied into its
 * declared config directories. The real directories are never mounted into
 * the sandbox, so provider and tool writes die with this home instead of
 * changing later unsandboxed CLI sessions.
 */
export function createProviderSessionHome(
  configPaths: ConfigPaths,
  copiedEntries: ConfigPaths,
  sourceHome: string | undefined = process.env["HOME"],
): ProviderSessionHome {
  const sessionHome = realpathSync(mkdtempSync(join(tmpdir(), "runmill-provider-home-")));
  chmodSync(sessionHome, 0o700);
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    makeRemovable(sessionHome);
    rmSync(sessionHome, { recursive: true, force: true });
  };

  try {
    const destinationDirectories = configPaths(sessionHome);
    for (const destination of destinationDirectories) {
      const resolvedDestination = resolve(destination);
      if (!isWithin(sessionHome, resolvedDestination) || resolvedDestination === sessionHome) {
        throw new Error(`Provider config path must stay inside HOME: ${destination}`);
      }
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      chmodSync(destination, 0o700);
    }

    if (sourceHome === undefined || sourceHome === "") return { path: sessionHome, cleanup };

    const sourceDirectories = configPaths(sourceHome).map((path) => resolve(path));
    const sources = copiedEntries(sourceHome);
    const destinations = copiedEntries(sessionHome);
    if (sources.length !== destinations.length) {
      throw new Error("Provider copied-entry mapping changed between source and session HOME");
    }

    for (const [index, destination] of destinations.entries()) {
      const source = sources[index];
      if (source === undefined) continue;
      const sourcePath = resolve(source);
      const destinationPath = resolve(destination);
      if (!isWithin(sessionHome, destinationPath) || destinationPath === sessionHome) {
        throw new Error(`Provider copied entry must stay inside HOME: ${destination}`);
      }
      const sourceRoot = sourceDirectories.find((root) => isWithin(root, sourcePath));
      if (sourceRoot === undefined) {
        throw new Error(`Provider copied entry is outside its config directory: ${source}`);
      }
      if (!existsSync(source)) continue;
      lstatSync(source);
      const boundary = realpathSync(sourceRoot);
      // The exact allowlisted auth file may itself be managed as a symlink by
      // a dotfiles tool. Dereference that one file into the private copy. A
      // directory entry still cannot drag an outside tree into the sandbox.
      copyPrivateTree(source, destination, boundary, new Set(), true);
    }

    return { path: sessionHome, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
