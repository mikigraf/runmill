import { describe, expect, it } from "vitest";
import {
  evaluateChangedPathScope,
  normalizeRepositoryPath,
  pathMatchesPattern,
} from "../../src/workspace/path-scope.js";

describe("repository path normalization", () => {
  it("normalizes platform separators before matching", () => {
    expect(normalizeRepositoryPath("src\\feature\\index.ts")).toBe("src/feature/index.ts");
  });

  it.each(["", "/etc/passwd", "C:/Windows/system.ini", "../outside", "src/../secret"])(
    "rejects a path Git could not have reported safely: %s",
    (path) => expect(() => normalizeRepositoryPath(path)).toThrow(),
  );
});

describe("gitignore-style scope matching", () => {
  it.each([
    ["src/index.ts", "src/**"],
    ["src/nested/index.ts", "src/**"],
    ["src/index.ts", "src/"],
    ["packages/a/package.json", "package.json"],
    ["packages/a/dependency.lock", "*.lock"],
    ["docs/api/v1.md", "docs/**/v?.md"],
  ])("matches %s against %s", (path, pattern) => {
    expect(pathMatchesPattern(path, pattern)).toBe(true);
  });

  it.each([
    ["src", "src/**"],
    ["src", "src/"],
    ["test/index.ts", "src/**"],
    ["src/nested/index.ts", "src/*"],
    ["package.json.bak", "package.json"],
  ])("does not widen %s through %s", (path, pattern) => {
    expect(pathMatchesPattern(path, pattern)).toBe(false);
  });

  it("supports character classes without treating malformed classes as literals", () => {
    expect(pathMatchesPattern("src/a.ts", "src/[ab].ts")).toBe(true);
    expect(() => pathMatchesPattern("src/a.ts", "src/[ab.ts")).toThrow(/unterminated/);
  });
});

describe("candidate diff scope", () => {
  it("accepts only when every changed path is allowed and none is forbidden", () => {
    expect(
      evaluateChangedPathScope(["src/a.ts", "test/a.test.ts"], {
        allowedPaths: ["src/**", "test/**"],
        forbiddenPaths: ["src/generated/**"],
      }),
    ).toEqual({ accepted: true, violations: [] });
  });

  it("forbidden paths override a broad allow", () => {
    const result = evaluateChangedPathScope(["src/a.ts", ".github/workflows/agent.yml"], {
      allowedPaths: ["**"],
      forbiddenPaths: [".github/**"],
    });
    expect(result.accepted).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: ".github/workflows/agent.yml",
        reason: "forbidden-path",
        pattern: ".github/**",
      }),
    );
  });

  it("fails closed on an empty allowlist and malformed policy", () => {
    expect(
      evaluateChangedPathScope(["src/a.ts"], { allowedPaths: [], forbiddenPaths: [] }).violations,
    ).toContainEqual(expect.objectContaining({ reason: "outside-allowed-paths" }));
    expect(
      evaluateChangedPathScope(["src/a.ts"], {
        allowedPaths: ["src/[broken"],
        forbiddenPaths: [],
      }).violations,
    ).toContainEqual(expect.objectContaining({ reason: "invalid-pattern", path: "<policy>" }));
  });
});
