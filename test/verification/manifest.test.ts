import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseChecksManifest,
  validateChecksManifest,
  loadChecksManifest,
  mergeCheckSources,
} from "../../src/verification/manifest.js";
import { DEFAULT_CHECKS_MANIFEST } from "../../src/review/default-skills.js";
import type { CheckSpec } from "../../src/verification/engine.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runmill-manifest-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeManifest(body: string, path = ".runmill/checks.yaml"): void {
  mkdirSync(join(dir, ".runmill"), { recursive: true });
  writeFileSync(join(dir, path), body);
}

describe("parseChecksManifest", () => {
  it("parses checks with their commands and reports", () => {
    const m = parseChecksManifest(`
checks:
  - id: typecheck
    run: npm run typecheck
  - id: test
    run: npm test
    report:
      path: junit.xml
      format: junit
`);
    expect(m.checks.map((c) => c.id)).toEqual(["typecheck", "test"]);
    expect(m.checks[1]?.report).toEqual({ path: "junit.xml", format: "junit" });
  });

  it("marks every repository-declared check required by default", () => {
    // An optional check is a check nobody has to fix.
    const m = parseChecksManifest("checks:\n  - id: a\n    run: x\n");
    expect(m.checks[0]?.required).toBe(true);
    expect(m.checks[0]?.source).toBe("repository-policy");
  });

  it("applies top-level declared_skips to every check", () => {
    // A skip is a statement about a test. The same test does not become
    // acceptable to lose because a different command happened to run it.
    const m = parseChecksManifest(`
checks:
  - id: unit
    run: npm test
  - id: e2e
    run: npm run e2e
declared_skips:
  - test_id: flaky network integration
    cause: needs a live staging endpoint; tracked in ENG-88
`);
    expect(m.declaredSkips).toHaveLength(1);
    for (const check of m.checks) {
      expect(check.declaredSkips?.[0]?.cause).toContain("ENG-88");
    }
  });

  it("parses the manifest that `runmill init` writes", () => {
    // init writing a file the loader rejects would be the worst possible
    // first-run experience.
    const m = parseChecksManifest(DEFAULT_CHECKS_MANIFEST);
    expect(m.checks.length).toBeGreaterThan(0);
    expect(validateChecksManifest(m)).toEqual([]);
  });
});

describe("validateChecksManifest", () => {
  it("rejects a check with no command", () => {
    const errors = validateChecksManifest(parseChecksManifest("checks:\n  - id: a\n"));
    expect(errors.join(" ")).toMatch(/missing run command/);
  });

  it("rejects duplicate ids rather than letting the later one win silently", () => {
    const errors = validateChecksManifest(
      parseChecksManifest("checks:\n  - id: a\n    run: x\n  - id: a\n    run: y\n"),
    );
    expect(errors.join(" ")).toMatch(/duplicate id/);
  });

  it("rejects a declared skip with no cause", () => {
    // A skip with no stated cause is exactly the undocumented skip this file
    // exists to prevent.
    const errors = validateChecksManifest(
      parseChecksManifest("checks:\n  - id: a\n    run: x\ndeclared_skips:\n  - test_id: t\n"),
    );
    expect(errors.join(" ")).toMatch(/missing cause/);
  });

  it("reports every problem at once", () => {
    const errors = validateChecksManifest(
      parseChecksManifest("checks:\n  - id: a\n  - id: a\n"),
    );
    expect(errors.length).toBeGreaterThan(1);
  });
});

describe("loadChecksManifest", () => {
  it("returns undefined when no manifest exists", () => {
    // Declaring checks entirely in runmill.yaml is legitimate.
    expect(
      loadChecksManifest({ repoRoot: dir, manifestPath: ".runmill/checks.yaml" }),
    ).toBeUndefined();
  });

  it("loads from the working tree when no base ref is given", () => {
    writeManifest("checks:\n  - id: unit\n    run: npm test\n");
    const loaded = loadChecksManifest({ repoRoot: dir, manifestPath: ".runmill/checks.yaml" });
    expect(loaded?.checks[0]?.id).toBe("unit");
    expect(loaded?.readFrom).toBe("working-tree");
  });

  it("fails loudly on an invalid manifest instead of proceeding with no checks", () => {
    // "Unreadable" must never quietly become "no checks required" — that turns
    // a broken file into an unguarded merge.
    writeManifest("checks:\n  - id: a\n");
    expect(() =>
      loadChecksManifest({ repoRoot: dir, manifestPath: ".runmill/checks.yaml" }),
    ).toThrow(/RM-VERIFY-004|missing run command/);
  });

  describe("reading from the base ref", () => {
    function git(...args: string[]): void {
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    }

    beforeEach(() => {
      git("init", "-q", ".");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      git("checkout", "-q", "-b", "main");
      writeManifest("checks:\n  - id: unit\n    run: npm test\n");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
    });

    it("reads the base version, not the working tree", () => {
      // The security property: a pull request that weakens the manifest must
      // not be judged by its own weakened rules.
      writeManifest("checks: []\n");
      const loaded = loadChecksManifest({
        repoRoot: dir,
        manifestPath: ".runmill/checks.yaml",
        baseRef: "main",
      });
      expect(loaded?.readFrom).toBe("base-ref");
      expect(loaded?.checks.map((c) => c.id)).toEqual(["unit"]);
    });

    it("falls back to the working tree when the manifest is new in this change", () => {
      const loaded = loadChecksManifest({
        repoRoot: dir,
        manifestPath: ".runmill/other.yaml",
        baseRef: "main",
      });
      // Absent at base and absent in the tree: nothing to load.
      expect(loaded).toBeUndefined();

      writeFileSync(join(dir, ".runmill", "other.yaml"), "checks:\n  - id: new\n    run: x\n");
      const added = loadChecksManifest({
        repoRoot: dir,
        manifestPath: ".runmill/other.yaml",
        baseRef: "main",
      });
      // Adding checks is always safe: resolveManifest's union is monotonic.
      expect(added?.readFrom).toBe("working-tree");
      expect(added?.checks[0]?.id).toBe("new");
    });
  });
});

describe("mergeCheckSources", () => {
  const spec = (id: string, run: string): CheckSpec => ({
    id,
    run,
    required: true,
    source: "repository-policy",
  });

  it("unions both sources", () => {
    const merged = mergeCheckSources([spec("a", "x")], [spec("b", "y")]);
    expect(merged.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("lets the repository win a conflict", () => {
    // The repository is the thing that knows how to build itself.
    const merged = mergeCheckSources([spec("a", "repo-cmd")], [spec("a", "config-cmd")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.run).toBe("repo-cmd");
  });
});
