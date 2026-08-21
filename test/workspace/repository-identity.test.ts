import { describe, expect, it } from "vitest";
import { parseGitHubRepository } from "../../src/workspace/repository-identity.js";

describe("parseGitHubRepository", () => {
  it.each([
    ["https://github.com/acme/platform.git", "acme/platform"],
    ["ssh://git@github.com/acme/platform.git", "acme/platform"],
    ["git@github.com:acme/platform.git", "acme/platform"],
    ["git+https://github.com/acme/platform.git", "acme/platform"],
  ])("maps %s to %s", (remote, expected) => {
    expect(parseGitHubRepository(remote)).toBe(expected);
  });

  it("rejects local paths, non-GitHub hosts, and ambiguous nested paths", () => {
    expect(parseGitHubRepository("/tmp/origin.git")).toBeUndefined();
    expect(parseGitHubRepository("https://gitlab.com/acme/platform.git")).toBeUndefined();
    expect(parseGitHubRepository("https://github.com/acme/group/platform.git")).toBeUndefined();
  });
});
