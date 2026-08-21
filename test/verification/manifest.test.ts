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
import {
  DEFAULT_CHECKS_MANIFEST,
  starterChecksForRepository,
} from "../../src/review/default-skills.js";
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

  it("scopes declared_skips to the exact report-producing check", () => {
    const m = parseChecksManifest(`
checks:
  - id: unit
    run: npm test
    report:
      path: unit.tap
      format: tap
    declared_skips:
      - test_id: flaky network integration
        cause: needs a live staging endpoint; tracked in ENG-88
  - id: e2e
    run: npm run e2e
`);
    expect(m.checks[0]?.declaredSkips?.[0]?.cause).toContain("ENG-88");
    expect(m.checks[1]?.declaredSkips).toBeUndefined();
  });

  it("infers only npm scripts that actually exist when `runmill init` writes a manifest", () => {
    // init writing a file the loader rejects would be the worst possible
    // first-run experience.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest", deploy: "nope" } }),
    );
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
    const starter = starterChecksForRepository(dir);
    const m = parseChecksManifest(starter.content);
    expect(starter.inferred).toEqual(["typecheck", "test"]);
    expect(m.checks.map((check) => check.id)).toEqual(["typecheck", "test"]);
    expect(validateChecksManifest(m)).toEqual([]);
  });

  it("writes an explicit empty manifest instead of guessing commands for another ecosystem", () => {
    writeFileSync(join(dir, "pyproject.toml"), "[project]\nname='fixture'\n");
    const starter = starterChecksForRepository(dir);
    const m = parseChecksManifest(starter.content);

    expect(starter.inferred).toEqual([]);
    expect(m.checks).toEqual([]);
    expect(starter.content).toMatch(/No safe project check was inferred/i);
    expect(validateChecksManifest(m)).toEqual([]);
  });

  it("does not accept npm's placeholder test script as verification", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
    expect(starterChecksForRepository(dir).inferred).toEqual([]);
  });

  it("keeps the context-free fallback syntactically valid and fail-closed", () => {
    const m = parseChecksManifest(DEFAULT_CHECKS_MANIFEST);
    expect(m.checks).toEqual([]);
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
      parseChecksManifest(
        "checks:\n  - id: a\n    run: x\n    report:\n      path: a.tap\n      format: tap\n    declared_skips:\n      - test_id: t\n",
      ),
    );
    expect(errors.join(" ")).toMatch(/missing cause/);
  });

  it("rejects unscoped top-level skip declarations", () => {
    const errors = validateChecksManifest(
      parseChecksManifest(
        "checks:\n  - id: a\n    run: x\ndeclared_skips:\n  - test_id: t\n    cause: old shape\n",
      ),
    );
    expect(errors.join(" ")).toMatch(/top-level.*unscoped/i);
  });

  it("rejects duplicate and empty test ids within a check", () => {
    const errors = validateChecksManifest(
      parseChecksManifest(`
checks:
  - id: a
    run: x
    report:
      path: a.tap
      format: tap
    declared_skips:
      - test_id: ""
        cause: missing
      - test_id: same
        cause: one
      - test_id: same
        cause: two
`),
    );
    expect(errors.join(" ")).toMatch(/missing test_id/i);
    expect(errors.join(" ")).toMatch(/duplicate test_id/i);
  });

  it("rejects exact skip declarations on a check with no report", () => {
    const errors = validateChecksManifest(
      parseChecksManifest(`
checks:
  - id: a
    run: x
    declared_skips:
      - test_id: A
        cause: tracked
`),
    );
    expect(errors.join(" ")).toMatch(/require a report/i);
  });

  it("reports every problem at once", () => {
    const errors = validateChecksManifest(
      parseChecksManifest("checks:\n  - id: a\n  - id: a\n"),
    );
    expect(errors.length).toBeGreaterThan(1);
  });

  it("rejects report paths that escape the verification checkout", () => {
    const errors = validateChecksManifest(
      parseChecksManifest(
        "checks:\n  - id: a\n    run: x\n    report:\n      path: ../report.json\n      format: json\n",
      ),
    );
    expect(errors.join(" ")).toMatch(/stay inside/i);
  });

  it("rejects report formats the engine cannot parse", () => {
    const errors = validateChecksManifest(
      parseChecksManifest(
        "checks:\n  - id: a\n    run: x\n    report:\n      path: report.txt\n      format: text\n",
      ),
    );
    expect(errors.join(" ")).toMatch(/junit, tap, go-json/);
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

    it("refuses an invalid base ref instead of trusting mutable working-tree policy", () => {
      writeManifest("checks: []\n");
      expect(() =>
        loadChecksManifest({
          repoRoot: dir,
          manifestPath: ".runmill/checks.yaml",
          baseRef: "missing-base",
        }),
      ).toThrow(/RM-VERIFY-004/);
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

  it("preserves the operator definition when repository policy reuses its id", () => {
    // Repository-controlled input may add a requirement but cannot replace an
    // operator-owned command with one that runs under orchestrator authority.
    const operator = spec("a", "config-cmd");
    const merged = mergeCheckSources([spec("a", "repo-cmd")], [operator]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(operator);
  });
});
