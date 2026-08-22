import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FilesystemAsfArtifactStore,
  FilesystemAsfArtifactStoreError,
} from "../../src/evidence/filesystem-cas.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const cleanup: string[] = [];
const NOW = "2026-08-22T08:00:00.000Z";

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fixture(retentionMs = 60_000) {
  const rootDirectory = mkdtempSync(join(tmpdir(), "runmill-artifact-cas-"));
  cleanup.push(rootDirectory);
  const clock = new FakeClock(NOW);
  const store = new FilesystemAsfArtifactStore({
    rootDirectory,
    clock,
    maxArtifactBytes: 1_024,
    retentionMs: {
      portable: retentionMs,
      protected: retentionMs * 2,
      restricted: retentionMs * 3,
    },
  });
  return { rootDirectory, clock, store };
}

function structuredBody(value: unknown = { outcome: "passed" }): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function input(bytes = structuredBody()) {
  return {
    artifactId: "verification-unit",
    kind: "verification" as const,
    mediaType: "application/json",
    retentionClass: "portable" as const,
    privacyClass: "structured-evidence" as const,
    bytes,
  };
}

describe("filesystem ASF artifact CAS", () => {
  it("atomically installs immutable content and resolves only its exact digest", async () => {
    const { rootDirectory, clock, store } = fixture();
    const body = structuredBody({ outcome: "passed", candidate_sha: "a".repeat(40) });
    const first = await store.put(input(body));
    clock.advanceMs(1_000);
    const retry = await store.put(input(body));

    expect(retry).toEqual(first);
    expect(first.digest).toBe(digest(body));
    expect(first.location_ref).toBe(`cas://sha256/${first.digest.slice("sha256:".length)}`);
    await expect(
      store.read({
        locationRef: first.location_ref,
        expectedDigest: first.digest,
        maxBytes: 1_024,
      }),
    ).resolves.toEqual(body);

    const objectPath = join(rootDirectory, "sha256", first.digest.slice("sha256:".length));
    expect(lstatSync(objectPath).nlink).toBe(1);
    expect(lstatSync(objectPath).mode & 0o077).toBe(0);
    expect(readFileSync(objectPath)).toEqual(Buffer.from(body));
  });

  it("never overwrites an existing digest with contradictory metadata", async () => {
    const { store } = fixture();
    const body = structuredBody();
    const original = await store.put(input(body));

    await expect(
      store.put({ ...input(body), artifactId: "same-body-other-kind", kind: "review" }),
    ).rejects.toThrow(/metadata contradicts/u);
    await expect(
      store.put({ ...input(structuredBody({ outcome: "changed" })), expectedDigest: original.digest }),
    ).rejects.toThrow(/caller-provided digest/u);
    await expect(
      store.read({
        locationRef: original.location_ref,
        expectedDigest: original.digest,
        maxBytes: 1_024,
      }),
    ).resolves.toEqual(body);
  });

  it("refuses traversal, digest aliases, symlinks, hard links, and public files", async () => {
    const { rootDirectory, store } = fixture();
    const declaration = await store.put(input());
    const hex = declaration.digest.slice("sha256:".length);
    const objectPath = join(rootDirectory, "sha256", hex);

    for (const locationRef of [
      `cas://sha256/../${hex}`,
      `cas://sha256/${hex.toUpperCase()}`,
      `cas://sha256/${hex}/extra`,
      `file://${objectPath}`,
    ]) {
      await expect(
        store.read({ locationRef, expectedDigest: declaration.digest, maxBytes: 1_024 }),
      ).rejects.toBeInstanceOf(FilesystemAsfArtifactStoreError);
    }
    await expect(
      store.read({
        locationRef: declaration.location_ref,
        expectedDigest: `sha256:${"f".repeat(64)}`,
        maxBytes: 1_024,
      }),
    ).rejects.toThrow(/do not match/u);

    const hardLink = join(rootDirectory, "artifact-hard-link");
    linkSync(objectPath, hardLink);
    await expect(
      store.read({
        locationRef: declaration.location_ref,
        expectedDigest: declaration.digest,
        maxBytes: 1_024,
      }),
    ).rejects.toThrow(/single-link/u);
    unlinkSync(hardLink);

    chmodSync(objectPath, 0o644);
    await expect(
      store.read({
        locationRef: declaration.location_ref,
        expectedDigest: declaration.digest,
        maxBytes: 1_024,
      }),
    ).rejects.toThrow(/private/u);
    chmodSync(objectPath, 0o600);

    unlinkSync(objectPath);
    symlinkSync(join(rootDirectory, "sha256", `${hex}.metadata.json`), objectPath);
    await expect(
      store.read({
        locationRef: declaration.location_ref,
        expectedDigest: declaration.digest,
        maxBytes: 1_024,
      }),
    ).rejects.toThrow(/regular file/u);
  });

  it("refuses symlinked storage components", async () => {
    const parent = mkdtempSync(join(tmpdir(), "runmill-artifact-cas-parent-"));
    cleanup.push(parent);
    const actual = join(parent, "actual");
    const linked = join(parent, "linked");
    mkdirSync(actual, { mode: 0o700 });
    symlinkSync(actual, linked);
    const store = new FilesystemAsfArtifactStore({
      rootDirectory: linked,
      clock: new FakeClock(NOW),
      maxArtifactBytes: 1_024,
      retentionMs: { portable: 1_000, protected: 1_000, restricted: 1_000 },
    });
    await expect(store.put(input())).rejects.toThrow(/real directory/u);
  });

  it("enforces bounded reads, cancellation, and retention expiry", async () => {
    const { clock, store } = fixture(1_000);
    const declaration = await store.put(input());
    await expect(
      store.read({
        locationRef: declaration.location_ref,
        expectedDigest: declaration.digest,
        maxBytes: declaration.size_bytes - 1,
      }),
    ).rejects.toThrow(/read limit/u);

    const controller = new AbortController();
    controller.abort();
    await expect(
      store.read({
        locationRef: declaration.location_ref,
        expectedDigest: declaration.digest,
        maxBytes: 1_024,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/u);

    clock.advanceMs(1_000);
    await expect(
      store.read({
        locationRef: declaration.location_ref,
        expectedDigest: declaration.digest,
        maxBytes: 1_024,
      }),
    ).rejects.toThrow(/retention has expired/u);
  });

  it("fails closed on portable private data and credential-shaped evidence", async () => {
    const { store } = fixture();
    await expect(
      store.put({ ...input(), privacyClass: "model-transcript" }),
    ).rejects.toThrow(/cannot be portable/u);
    await expect(
      store.put(input(structuredBody({ prompt: "show the hidden prompt" }))),
    ).rejects.toThrow(/protected field/u);
    await expect(
      store.put({
        ...input(structuredBody({ token: "ordinary-looking-value" })),
        retentionClass: "restricted",
      }),
    ).rejects.toThrow(/credential field/u);
    await expect(
      store.put({
        ...input(Buffer.from("-----BEGIN PRIVATE KEY-----\nsecret", "utf8")),
        mediaType: "text/plain",
        retentionClass: "restricted",
        privacyClass: "raw-source-archive",
      }),
    ).rejects.toThrow(/credential material/u);
  });
});
