import { describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderSessionHome } from "../../src/agent/provider-home.js";

const codexPaths = (home: string): readonly string[] => [join(home, ".codex")];
const codexAuth = (home: string): readonly string[] => [join(home, ".codex", "auth.json")];

describe("createProviderSessionHome", () => {
  it("copies only allowlisted authentication entries", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "runmill-provider-source-"));
    const sourceConfig = join(sourceHome, ".codex");
    mkdirSync(join(sourceConfig, "sessions"), { recursive: true });
    writeFileSync(join(sourceConfig, "auth.json"), "subscription-token\n");
    writeFileSync(join(sourceConfig, "history.jsonl"), "private conversation\n");
    writeFileSync(join(sourceConfig, "sessions", "prior.json"), "prior session\n");

    const session = createProviderSessionHome(codexPaths, codexAuth, sourceHome);
    try {
      expect(readFileSync(join(session.path, ".codex", "auth.json"), "utf8")).toBe(
        "subscription-token\n",
      );
      expect(existsSync(join(session.path, ".codex", "history.jsonl"))).toBe(false);
      expect(existsSync(join(session.path, ".codex", "sessions"))).toBe(false);
    } finally {
      session.cleanup();
      rmSync(sourceHome, { recursive: true, force: true });
    }
  });

  it("dereferences an allowlisted auth-file symlink without retaining a path to its target", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "runmill-provider-source-"));
    const outside = mkdtempSync(join(tmpdir(), "runmill-provider-auth-store-"));
    const sourceConfig = join(sourceHome, ".codex");
    const authTarget = join(outside, "codex-auth.json");
    mkdirSync(sourceConfig, { recursive: true });
    writeFileSync(authTarget, "subscription-token\n");
    symlinkSync(authTarget, join(sourceConfig, "auth.json"));

    const session = createProviderSessionHome(codexPaths, codexAuth, sourceHome);
    try {
      const copiedAuth = join(session.path, ".codex", "auth.json");
      expect(readFileSync(copiedAuth, "utf8")).toBe("subscription-token\n");
      expect(lstatSync(copiedAuth).isSymbolicLink()).toBe(false);
      writeFileSync(copiedAuth, "sandbox-write\n");
      expect(readFileSync(authTarget, "utf8")).toBe("subscription-token\n");
    } finally {
      session.cleanup();
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("dereferences in-tree symlinks and makes the copied tree private", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "runmill-provider-source-"));
    const sourceConfig = join(sourceHome, ".codex");
    mkdirSync(sourceConfig, { recursive: true });
    writeFileSync(join(sourceConfig, "auth.json"), "subscription-token\n");
    chmodSync(join(sourceConfig, "auth.json"), 0o644);
    symlinkSync("auth.json", join(sourceConfig, "active-auth.json"));

    let session: ReturnType<typeof createProviderSessionHome> | undefined;
    try {
      session = createProviderSessionHome(codexPaths, codexPaths, sourceHome);
      const copiedConfig = join(session.path, ".codex");
      const copiedAuth = join(copiedConfig, "auth.json");
      const copiedLink = join(copiedConfig, "active-auth.json");

      expect(readFileSync(copiedLink, "utf8")).toBe("subscription-token\n");
      expect(lstatSync(copiedLink).isSymbolicLink()).toBe(false);
      expect(statSync(session.path).mode & 0o777).toBe(0o700);
      expect(statSync(copiedConfig).mode & 0o777).toBe(0o700);
      expect(statSync(copiedAuth).mode & 0o777).toBe(0o600);
      expect(statSync(copiedLink).mode & 0o777).toBe(0o600);

      session.cleanup();
      session.cleanup();
      expect(existsSync(session.path)).toBe(false);
    } finally {
      session?.cleanup();
      rmSync(sourceHome, { recursive: true, force: true });
    }
  });

  it("refuses a nested symlink that would import an unrelated credential", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "runmill-provider-source-"));
    const outside = mkdtempSync(join(tmpdir(), "runmill-provider-outside-"));
    const sourceConfig = join(sourceHome, ".codex");
    mkdirSync(sourceConfig, { recursive: true });
    writeFileSync(join(outside, "cloud-token"), "not-provider-state\n");
    symlinkSync(join(outside, "cloud-token"), join(sourceConfig, "borrowed-token"));

    try {
      expect(() => createProviderSessionHome(codexPaths, codexPaths, sourceHome)).toThrow(
        /symlink escapes its source directory/,
      );
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a dialect path outside the disposable HOME and removes the partial copy", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "runmill-provider-source-"));
    try {
      expect(() =>
        createProviderSessionHome(
          (home) => [join(home, "..", "escaped")],
          (home) => [join(home, "..", "escaped", "auth.json")],
          sourceHome,
        ),
      ).toThrow(/must stay inside HOME/);
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
    }
  });
});
