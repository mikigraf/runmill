import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeDependencies,
  prepareDependencies,
  validateInstalledDependencies,
} from "../../src/workspace/dependencies.js";

let root: string;
let trusted: string;
let source: string;
let cache: string;

function makeRemovable(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, stat.mode | 0o700);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) makeRemovable(join(path, name));
  }
}

function writeProject(project: string): void {
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({ name: "fixture", dependencies: { tiny: "1.0.0" } }, null, 2)}\n`,
  );
  writeFileSync(
    join(project, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        lockfileVersion: 3,
        packages: {
          "": { name: "fixture", dependencies: { tiny: "1.0.0" } },
          "node_modules/tiny": {
            version: "1.0.0",
            resolved: "https://registry.example.invalid/tiny-1.0.0.tgz",
            integrity: "sha512-fixture",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function installSourceTree(): void {
  const modules = join(source, "node_modules");
  const tiny = join(modules, "tiny");
  mkdirSync(tiny, { recursive: true });
  writeFileSync(join(tiny, "package.json"), '{"name":"tiny","version":"1.0.0"}\n');
  writeFileSync(join(tiny, "index.js"), "export const tiny = true;\n");
  writeFileSync(
    join(modules, ".package-lock.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        lockfileVersion: 3,
        packages: {
          "node_modules/tiny": {
            version: "1.0.0",
            resolved: "https://registry.example.invalid/tiny-1.0.0.tgz",
            integrity: "sha512-fixture",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runmill-dependencies-"));
  trusted = join(root, "trusted");
  source = join(root, "source");
  cache = join(root, "cache");
  writeProject(trusted);
  writeProject(source);
  installSourceTree();
});

afterEach(() => {
  makeRemovable(root);
  rmSync(root, { recursive: true, force: true });
});

describe("npm verification dependency cache", () => {
  it("proves the installed tree without creating or warming a cache", () => {
    const validated = validateInstalledDependencies({
      trustedCheckout: trusted,
      installedSource: source,
    });

    expect(validated?.manager).toBe("npm");
    expect(validated?.identity).toMatch(/^[a-f0-9]{64}$/u);
    expect(existsSync(cache)).toBe(false);
  });

  it("imports once, reuses by exact lock identity, and materializes the same bytes", () => {
    const first = prepareDependencies({
      trustedCheckout: trusted,
      installedSource: source,
      cacheRoot: cache,
    });
    expect(first?.manager).toBe("npm");

    // Reuse is independent of the mutable source tree once the receipt and
    // every cached byte have been validated.
    rmSync(join(source, "node_modules"), { recursive: true, force: true });
    const reused = prepareDependencies({
      trustedCheckout: trusted,
      installedSource: source,
      cacheRoot: cache,
    });
    expect(reused).toEqual(first);

    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    const target = materializeDependencies(reused!, checkout);
    expect(readFileSync(join(target, "tiny/index.js"), "utf8")).toContain("tiny = true");
    expect(lstatSync(join(target, "tiny/index.js")).mode & 0o222).toBe(0);
    expect(statSync(join(target, "tiny/index.js")).ino).toBe(
      statSync(join(reused!.cachePath, "node_modules/tiny/index.js")).ino,
    );
  });

  it("refuses a source install whose lockfile differs from the exact commit", () => {
    writeFileSync(join(source, "package-lock.json"), "{}\n");

    expect(() =>
      prepareDependencies({
        trustedCheckout: trusted,
        installedSource: source,
        cacheRoot: cache,
      }),
    ).toThrow(/RM-VERIFY-005|differ from the exact base commit/i);
    expect(existsSync(cache)).toBe(false);
  });

  it("refuses missing installed dependencies instead of invoking npm or a registry", () => {
    rmSync(join(source, "node_modules"), { recursive: true, force: true });

    expect(() =>
      prepareDependencies({
        trustedCheckout: trusted,
        installedSource: source,
        cacheRoot: cache,
      }),
    ).toThrow(/RM-VERIFY-005|run npm ci/i);
    expect(existsSync(cache)).toBe(false);
  });

  it("refuses a dependency symlink that escapes the imported tree", () => {
    const outside = join(root, "outside.js");
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(source, "node_modules/tiny/escape.js"));

    expect(() =>
      prepareDependencies({
        trustedCheckout: trusted,
        installedSource: source,
        cacheRoot: cache,
      }),
    ).toThrow(/RM-VERIFY-005|escapes node_modules/i);
  });

  it("detects any mutation of a prepared cache before reuse", () => {
    const prepared = prepareDependencies({
      trustedCheckout: trusted,
      installedSource: source,
      cacheRoot: cache,
    });
    const cachedFile = join(prepared!.cachePath, "node_modules/tiny/index.js");
    chmodSync(cachedFile, 0o600);
    writeFileSync(cachedFile, "tampered\n");

    expect(() =>
      prepareDependencies({
        trustedCheckout: trusted,
        installedSource: source,
        cacheRoot: cache,
      }),
    ).toThrow(/RM-VERIFY-005|cache bytes changed/i);
  });
});
