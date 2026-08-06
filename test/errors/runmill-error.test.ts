import { describe, expect, it } from "vitest";
import { RunmillError, ERROR_CATALOG, renderError } from "../../src/errors/runmill-error.js";
import type { ErrorCatalogEntry } from "../../src/errors/runmill-error.js";

describe("RunmillError", () => {
  it("carries a stable code, cause, fixes, and docs url", () => {
    const err = new RunmillError({
      code: "RM-SANDBOX-001",
      title: "Sandbox isolation unavailable",
      whatHappened: "bwrap --dev-bind / / true\n  -> bwrap: setting up uid map: Permission denied",
      why: "Unprivileged user namespaces are disabled on this host.",
      fixes: [{ description: "enable userns", command: "sudo sysctl -w kernel.unprivileged_userns_clone=1" }],
      recoverable: false,
    });
    expect(err.code).toBe("RM-SANDBOX-001");
    expect(err.docsUrl).toBe("https://runmill.dev/errors/RM-SANDBOX-001");
    expect(err).toBeInstanceOf(Error);
  });

  it("is throwable and catchable as an Error", () => {
    expect(() => {
      throw RunmillError.fromCatalog("RM-SANDBOX-001", { whatHappened: "probe failed" });
    }).toThrow(RunmillError);
  });

  it("serializes to JSON for the events table", () => {
    const err = RunmillError.fromCatalog("RM-SELECT-002", { whatHappened: "no rule matched" });
    const json = err.toJSON();
    expect(json).toMatchObject({
      code: "RM-SELECT-002",
      recoverable: expect.any(Boolean),
      docsUrl: "https://runmill.dev/errors/RM-SELECT-002",
    });
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  it("preserves a resumeFrom checkpoint when the failure is recoverable", () => {
    const err = RunmillError.fromCatalog("RM-CI-002", {
      whatHappened: "e2e never scheduled",
      runId: "run_01J",
      resumeFrom: "CI_WAIT",
    });
    expect(err.recoverable).toBe(true);
    expect(err.resumeFrom).toBe("CI_WAIT");
    expect(err.runId).toBe("run_01J");
  });
});

describe("ERROR_CATALOG", () => {
  it("has no duplicate codes", () => {
    const codes = Object.keys(ERROR_CATALOG);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("uses the RM-<AREA>-<NNN> code shape throughout", () => {
    for (const code of Object.keys(ERROR_CATALOG)) {
      expect(code).toMatch(/^RM-[A-Z]+-\d{3}$/);
    }
  });

  it("gives every entry a title, a why, and at least one fix", () => {
    // FR-23: no failure mode may be silent. An entry with no remedy is a
    // silent failure wearing a code.
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(entry.title, `${code} title`).toBeTruthy();
      expect(entry.why, `${code} why`).toBeTruthy();
      expect(entry.fixes.length, `${code} fixes`).toBeGreaterThan(0);
    }
  });

  it("covers every critical fail-closed path named in the PRD", () => {
    for (const code of [
      "RM-SANDBOX-001", // sandbox unavailable
      "RM-VERIFY-001", // required check missing
      "RM-VERIFY-002", // check ran against a different commit
      "RM-VERIFY-003", // undeclared skip
      "RM-CI-002", // required check never reported
      "RM-LEASE-001", // lease lost / fencing generation stale
      "RM-PROVIDER-001", // unknown provider event shape
      "RM-REVIEW-001", // malformed review output
    ]) {
      expect(ERROR_CATALOG, `catalog missing ${code}`).toHaveProperty(code);
    }
  });
});

describe("renderError", () => {
  it("renders the four-part terminal form with a docs link", () => {
    const out = renderError(
      RunmillError.fromCatalog("RM-SANDBOX-001", { whatHappened: "probe denied" }),
    );
    expect(out).toContain("RM-SANDBOX-001");
    expect(out).toContain("What happened");
    expect(out).toContain("Why");
    expect(out).toContain("Fix");
    expect(out).toContain("https://runmill.dev/errors/RM-SANDBOX-001");
  });

  it("renders every fix as its own actionable line", () => {
    const out = renderError(
      RunmillError.fromCatalog("RM-SANDBOX-001", { whatHappened: "probe denied" }),
    );
    const entry: ErrorCatalogEntry = ERROR_CATALOG["RM-SANDBOX-001"];
    for (const fix of entry.fixes) {
      expect(out).toContain(fix.command ?? fix.description);
    }
  });
});
