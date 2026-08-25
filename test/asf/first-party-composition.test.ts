import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ASF_FIRST_PARTY_COMPOSITION_MANIFEST,
  AsfFirstPartyCompositionManifestError,
  AsfFirstPartyCompositionUnavailableError,
  ASF_FIRST_PARTY_COMPOSITION_BLOCKING_REASONS,
  inspectAsfFirstPartyComposition,
  parseAsfFirstPartyCompositionManifest,
  requireAsfFirstPartyComposition,
} from "../../src/asf/first-party-composition.js";

describe("ASF first-party composition manifest", () => {
  it("describes the reference boundary without claiming an executable or qualified deployment", () => {
    const manifest = inspectAsfFirstPartyComposition();
    const packagedCopy = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "examples/asf-worker/first-party-composition-manifest.json"),
        "utf8",
      ),
    ) as unknown;

    expect(manifest).toEqual(ASF_FIRST_PARTY_COMPOSITION_MANIFEST);
    expect(parseAsfFirstPartyCompositionManifest(packagedCopy)).toEqual(manifest);
    expect(manifest.productionQualified).toBe(false);
    expect(manifest.availability).toBe("runtime-module-required");
    expect(manifest.blockingReasons).toEqual(
      ASF_FIRST_PARTY_COMPOSITION_BLOCKING_REASONS,
    );
    expect(manifest.requiredPorts.length).toBeGreaterThan(30);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.requiredPorts)).toBe(true);
  });

  it("rejects altered, incomplete, or extended manifests", () => {
    expect(() =>
      parseAsfFirstPartyCompositionManifest({
        ...ASF_FIRST_PARTY_COMPOSITION_MANIFEST,
        blockingReasons: ASF_FIRST_PARTY_COMPOSITION_MANIFEST.blockingReasons.slice(1),
      }),
    ).toThrow(AsfFirstPartyCompositionManifestError);
    expect(() =>
      parseAsfFirstPartyCompositionManifest({
        ...ASF_FIRST_PARTY_COMPOSITION_MANIFEST,
        requiredPorts: ASF_FIRST_PARTY_COMPOSITION_MANIFEST.requiredPorts.slice(1),
      }),
    ).toThrow(AsfFirstPartyCompositionManifestError);
    expect(() =>
      parseAsfFirstPartyCompositionManifest({
        ...ASF_FIRST_PARTY_COMPOSITION_MANIFEST,
        requiredPorts: [
          ...ASF_FIRST_PARTY_COMPOSITION_MANIFEST.requiredPorts,
          "untrusted-port",
        ],
      }),
    ).toThrow(AsfFirstPartyCompositionManifestError);
    expect(() =>
      parseAsfFirstPartyCompositionManifest({
        ...ASF_FIRST_PARTY_COMPOSITION_MANIFEST,
        unexpected: true,
      }),
    ).toThrow(AsfFirstPartyCompositionManifestError);
  });

  it("refuses to treat the manifest as a first-party executable composition", () => {
    expect(() => requireAsfFirstPartyComposition()).toThrow(
      AsfFirstPartyCompositionUnavailableError,
    );
    try {
      requireAsfFirstPartyComposition();
    } catch (error) {
      expect(error).toMatchObject({
        reason: "first-party-composition-unavailable",
        manifest: {
          productionQualified: false,
          availability: "runtime-module-required",
          blockingReasons: ASF_FIRST_PARTY_COMPOSITION_BLOCKING_REASONS,
        },
        blockingReasons: ASF_FIRST_PARTY_COMPOSITION_BLOCKING_REASONS,
      });
    }
  });
});
