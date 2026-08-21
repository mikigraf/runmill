import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { defaultConfigPath, defaultDataDir, findRepositoryRoot } from "../../src/platform/paths.js";

describe("operator-owned paths", () => {
  it("keeps authority-bearing policy outside the repository", () => {
    const repo = "/work/acme/platform";
    const path = defaultConfigPath(repo, { XDG_CONFIG_HOME: "/config" }, "/home/dev");
    expect(path).toMatch(/^\/config\/runmill\/projects\/platform-[a-f0-9]{10}\/policy\.yaml$/);
    expect(path.startsWith(repo)).toBe(false);
  });

  it("keeps Linux state under XDG_STATE_HOME", () => {
    const path = defaultDataDir(
      "/work/acme/platform",
      { XDG_STATE_HOME: "/state" },
      "/home/dev",
      "linux",
    );
    expect(path).toMatch(/^\/state\/runmill\/projects\/platform-[a-f0-9]{10}$/);
  });

  it("uses Application Support for state on macOS", () => {
    const path = defaultDataDir("/work/acme/platform", {}, "/Users/dev", "darwin");
    expect(path).toContain(join("/Users/dev", "Library", "Application Support", "runmill"));
  });

  it("honours an explicit state override", () => {
    expect(
      defaultDataDir("/work/repo", { RUNMILL_DATA_DIR: "/tmp/custom" }, "/home/dev", "linux"),
    ).toBe("/tmp/custom");
  });

  it("uses one project id from every subdirectory in a repository", () => {
    const root = mkdtempSync(join(tmpdir(), "runmill-paths-"));
    try {
      writeFileSync(join(root, ".git"), "gitdir: elsewhere\n");
      const nested = join(root, "packages", "api");
      mkdirSync(nested, { recursive: true });
      expect(findRepositoryRoot(nested)).toBe(realpathSync(root));
      expect(defaultConfigPath(nested, { XDG_CONFIG_HOME: "/config" }, "/home/dev")).toBe(
        defaultConfigPath(root, { XDG_CONFIG_HOME: "/config" }, "/home/dev"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the same project id through a symlink to the repository", () => {
    const parent = mkdtempSync(join(tmpdir(), "runmill-paths-link-"));
    const root = join(parent, "real-repo");
    const linked = join(parent, "linked-repo");
    try {
      mkdirSync(root);
      writeFileSync(join(root, ".git"), "gitdir: elsewhere\n");
      symlinkSync(root, linked, "dir");
      expect(defaultConfigPath(linked, { XDG_CONFIG_HOME: "/config" }, "/home/dev")).toBe(
        defaultConfigPath(root, { XDG_CONFIG_HOME: "/config" }, "/home/dev"),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
