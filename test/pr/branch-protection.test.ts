/**
 * Reading branch protection.
 *
 * This is the input to the merge gate, so the dangerous answer is not "error"
 * but "nothing is required". GitHub exposes the rules two different ways --
 * modern rulesets and classic branch protection -- and a repository protected
 * the classic way returns an empty *success* from the rulesets endpoint.
 * Reading only rulesets therefore reports an protected branch as unprotected,
 * which is the one answer that silently unlocks a merge.
 *
 * Driven against a real HTTP server rather than a mocked Octokit, because the
 * bug lived in which endpoints were called, and a mock would have been written
 * against the same mistaken assumption.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GitHubForgeAdapter } from "../../src/pr/github.js";

type Route = (url: string) => { status: number; body: unknown } | undefined;

let server: Server;
let baseUrl: string;
let routes: Route[] = [];

beforeEach(async () => {
  routes = [];
  server = createServer((req, res) => {
    const url = req.url ?? "";
    for (const route of routes) {
      const hit = route(url);
      if (hit !== undefined) {
        res.writeHead(hit.status, { "content-type": "application/json" });
        res.end(JSON.stringify(hit.body));
        return;
      }
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function adapter(): GitHubForgeAdapter {
  return new GitHubForgeAdapter({ token: "t", baseUrl });
}

/** No rulesets configured: an empty array, returned as a success. */
function noRulesets(): Route {
  return (url) => (url.includes("/rules/branches/") ? { status: 200, body: [] } : undefined);
}

function branch(isProtected: boolean): Route {
  return (url) =>
    /\/branches\/main$/.test(url) ? { status: 200, body: { protected: isProtected } } : undefined;
}

function classicProtection(status: number, body: unknown): Route {
  return (url) =>
    url.includes("/branches/main/protection") ? { status, body } : undefined;
}

describe("getBranchProtection", () => {
  it("sees a required check configured through classic branch protection", async () => {
    routes = [
      noRulesets(),
      classicProtection(200, {
        required_status_checks: { contexts: ["test"] },
        required_pull_request_reviews: null,
      }),
      branch(true),
    ];

    const protection = await adapter().getBranchProtection({ repo: "o/r", branch: "main" });

    expect(protection.requiredChecks).toContain("test");
    expect(protection.unreadable).toBe(false);
  });

  it("reads the newer checks[] shape as well as the legacy contexts[]", async () => {
    routes = [
      noRulesets(),
      classicProtection(200, {
        required_status_checks: { checks: [{ context: "build" }, { context: "lint" }] },
      }),
      branch(true),
    ];

    const protection = await adapter().getBranchProtection({ repo: "o/r", branch: "main" });

    expect(protection.requiredChecks).toEqual(expect.arrayContaining(["build", "lint"]));
  });

  it("reports a required approval configured the classic way", async () => {
    routes = [
      noRulesets(),
      classicProtection(200, {
        required_status_checks: { contexts: [] },
        required_pull_request_reviews: { required_approving_review_count: 1 },
      }),
      branch(true),
    ];

    const protection = await adapter().getBranchProtection({ repo: "o/r", branch: "main" });

    expect(protection.requiresApproval).toBe(true);
  });

  it("refuses to call a protected branch unprotected when it cannot read the rules", async () => {
    // The token is not an admin. `protected: true` is readable without admin,
    // so runmill knows rules exist even though it cannot enumerate them, and
    // "unknown" must never collapse into "none".
    routes = [noRulesets(), classicProtection(403, { message: "Must have admin rights" }), branch(true)];

    const protection = await adapter().getBranchProtection({ repo: "o/r", branch: "main" });

    expect(protection.unreadable).toBe(true);
  });

  it("treats a branch that is genuinely unprotected as readable and empty", async () => {
    routes = [noRulesets(), branch(false)];

    const protection = await adapter().getBranchProtection({ repo: "o/r", branch: "main" });

    expect(protection.unreadable).toBe(false);
    expect(protection.requiredChecks).toEqual([]);
  });

  it("still reads rulesets when a repository uses them", async () => {
    routes = [
      (url) =>
        url.includes("/rules/branches/")
          ? {
              status: 200,
              body: [
                {
                  type: "required_status_checks",
                  parameters: { required_status_checks: [{ context: "ruleset-check" }] },
                },
              ],
            }
          : undefined,
      branch(false),
    ];

    const protection = await adapter().getBranchProtection({ repo: "o/r", branch: "main" });

    expect(protection.requiredChecks).toContain("ruleset-check");
    expect(protection.unreadable).toBe(false);
  });

  it("combines rules from both systems rather than preferring one", async () => {
    // Both can apply to the same branch at once, and each contributes gates.
    routes = [
      (url) =>
        url.includes("/rules/branches/")
          ? {
              status: 200,
              body: [
                {
                  type: "required_status_checks",
                  parameters: { required_status_checks: [{ context: "from-ruleset" }] },
                },
              ],
            }
          : undefined,
      classicProtection(200, { required_status_checks: { contexts: ["from-classic"] } }),
      branch(true),
    ];

    const protection = await adapter().getBranchProtection({ repo: "o/r", branch: "main" });

    expect(protection.requiredChecks).toEqual(
      expect.arrayContaining(["from-ruleset", "from-classic"]),
    );
  });

  it("fails closed when even the branch itself cannot be read", async () => {
    routes = [noRulesets()];

    const protection = await adapter().getBranchProtection({ repo: "o/r", branch: "main" });

    expect(protection.unreadable).toBe(true);
  });
});

describe("canWriteBranchProtection", () => {
  /**
   * The gate that unlocks guarded-merge asked whether the caller has the admin
   * ROLE. On a repository you own that is always true, whatever the token can
   * actually do, so a fine-grained PAT with Administration=No access -- the
   * documented way to satisfy this gate -- reported "can bypass" and merge
   * modes could never unlock. Verified against real GitHub: that token gets
   * 403 writing protection while permissions.admin is true.
   *
   * The question is a capability, so it is answered by attempting the write.
   * Adding an empty set of required contexts changes nothing and returns 403
   * for a token that may not write.
   */
  function probe(status: number): Route {
    return (url) =>
      url.includes("/required_status_checks/contexts") ? { status, body: [] } : undefined;
  }

  it("reports false when the credential cannot write protection", async () => {
    routes = [probe(403)];

    expect(await adapter().canWriteBranchProtection({ repo: "o/r", branch: "main" })).toBe(false);
  });

  it("reports true when the credential can write protection", async () => {
    routes = [probe(200)];

    expect(await adapter().canWriteBranchProtection({ repo: "o/r", branch: "main" })).toBe(true);
  });

  it("does not believe the admin role over the actual capability", async () => {
    // The exact shape that broke it: admin true, write refused.
    routes = [
      probe(403),
      (url) => (/\/repos\/o\/r$/.test(url) ? { status: 200, body: { permissions: { admin: true } } } : undefined),
    ];

    expect(await adapter().canWriteBranchProtection({ repo: "o/r", branch: "main" })).toBe(false);
  });

  it("falls back to the role and fails closed when the probe is inconclusive", async () => {
    // Neither 200 nor 403: no protection configured, a moved repository, an
    // outage. Unknown must not unlock a merge.
    routes = [
      probe(404),
      (url) => (/\/repos\/o\/r$/.test(url) ? { status: 200, body: { permissions: { admin: true } } } : undefined),
    ];

    expect(await adapter().canWriteBranchProtection({ repo: "o/r", branch: "main" })).toBe(true);
  });

  it("fails closed when nothing can be determined at all", async () => {
    routes = [probe(500)];

    expect(await adapter().canWriteBranchProtection({ repo: "o/r", branch: "main" })).toBe(true);
  });
});
