import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { ProductionGitHubEffectsAdapter } from "../../src/asf/github-adapter.js";
import { GitHubRepositoryAdmissionObserver } from "../../src/asf/repository-admission.js";
import type { WorkOrderPayload } from "../../src/asf/work-order.js";
import { RunmillError } from "../../src/errors/runmill-error.js";

const REQUESTED_BASE = "a".repeat(40);
const CURRENT_BASE = "b".repeat(40);
const RACING_BASE = "c".repeat(40);
const POLICY = "checks:\n  - id: integration\n    run: npm run integration\n";

function blobSha(bytes: Buffer): string {
  return createHash("sha1")
    .update(`blob ${String(bytes.length)}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function withGitHubServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  action: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test address");
    return await action(`http://127.0.0.1:${address.port}/api/v3`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

function payload(): WorkOrderPayload {
  return {
    schema: "asf.work-order/v1",
    work_order_id: "wo_01",
    tenant_id: "tenant-acme",
    work_item_id: "ENG-123",
    attempt_id: "attempt_01",
    idempotency_key: "tenant-acme/ENG-123/attempt_01",
    source: {
      system: "linear",
      external_id: "ENG-123",
      snapshot_digest: `sha256:${"1".repeat(64)}`,
    },
    repository: {
      forge: "github",
      repository: "acme/payments",
      base_ref: "refs/heads/main",
      base_sha: REQUESTED_BASE,
    },
    objective: {
      title: "Observe immutable policy",
      description: "Bind admission to the registered base.",
      acceptance_criteria: ["policy is exact"],
      non_goals: [],
    },
    scope: { allowed_paths: ["src/**"], forbidden_paths: [], risk_class: "low" },
    verification: {
      required_local_check_ids: ["integration"],
      required_remote_checks: [],
      policy_snapshot_digest: `sha256:${createHash("sha256").update(POLICY).digest("hex")}`,
    },
    identities: {
      implementer: "codex:asf-production",
      local_reviewer: "claude:asf-review",
      pr_reviewer: "claude:asf-review",
    },
    runtime: {
      sandbox_profile: "linux-production-v1",
      tool_policy: "repo-change-v1",
      network_policy: "provider-only-v1",
    },
    budgets: {
      wall_seconds: 600,
      max_cost_usd: 1,
      max_agent_invocations: 2,
      max_fix_iterations: 0,
    },
    delivery: { closure_target: "pr", draft_pr: true, merge_policy_ref: null },
    policy_digest: `sha256:${"2".repeat(64)}`,
    harness_digest: `sha256:${"3".repeat(64)}`,
  };
}

interface Scenario {
  readonly comparison?: "ahead" | "diverged";
  readonly missingPolicy?: boolean;
  readonly malformedPolicy?: boolean;
  readonly racePolicy?: boolean;
  readonly raceBase?: boolean;
}

async function observeScenario(
  scenario: Scenario = {},
): Promise<{
  readonly evidence: Awaited<ReturnType<GitHubRepositoryAdmissionObserver["observe"]>>;
  readonly urls: readonly string[];
}> {
  const urls: string[] = [];
  let branchReads = 0;
  let policyReads = 0;
  const evidence = await withGitHubServer(
    (request, response) => {
      const url = request.url ?? "";
      urls.push(url);
      if (url.includes("/rules/branches/main")) {
        return json(response, 200, [
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "ci/unit" }] },
          },
        ]);
      }
      if (/\/branches\/main(?:\?|$)/u.test(url)) {
        branchReads += 1;
        return json(response, 200, {
          name: "main",
          protected: false,
          commit: { sha: scenario.raceBase === true && branchReads === 2 ? RACING_BASE : CURRENT_BASE },
        });
      }
      if (url.includes("/compare/")) {
        const comparison = scenario.comparison ?? "ahead";
        return json(response, 200, {
          status: comparison,
          base_commit: { sha: REQUESTED_BASE },
          merge_base_commit: { sha: comparison === "ahead" ? REQUESTED_BASE : RACING_BASE },
        });
      }
      if (decodeURIComponent(url).includes("/contents/.runmill/checks.yaml")) {
        policyReads += 1;
        if (scenario.missingPolicy === true) return json(response, 404, { message: "Not Found" });
        const source =
          scenario.malformedPolicy === true
            ? "not-a-check-manifest\n"
            : scenario.racePolicy === true && policyReads === 2
              ? "checks: []\n"
              : POLICY;
        const bytes = Buffer.from(source, "utf8");
        return json(response, 200, {
          type: "file",
          path: ".runmill/checks.yaml",
          encoding: "base64",
          content: bytes.toString("base64"),
          sha: blobSha(bytes),
          size: bytes.length,
        });
      }
      return json(response, 404, { message: "unexpected endpoint" });
    },
    async (baseUrl) => {
      const adapter = new ProductionGitHubEffectsAdapter({ token: "controller-token", baseUrl });
      const observer = new GitHubRepositoryAdmissionObserver({
        adapter,
        repository: "acme/payments",
        baseRef: "refs/heads/main",
      });
      return observer.observe(payload());
    },
  );
  return { evidence, urls };
}

describe("GitHubRepositoryAdmissionObserver", () => {
  it("binds reachability, exact base-policy bytes, and double-read forge protection", async () => {
    const { evidence, urls } = await observeScenario();
    expect(evidence).toMatchObject({
      forge: "github",
      repository: "acme/payments",
      baseRef: "refs/heads/main",
      observedBaseSha: CURRENT_BASE,
      requestedBaseShaReachable: true,
      repositoryPolicyBaseSha: REQUESTED_BASE,
      repositoryPolicyPath: ".runmill/checks.yaml",
      constraints: {
        definedLocalCheckIds: ["integration"],
        requiredLocalCheckIds: ["integration"],
        requiredRemoteChecks: [],
      },
      forgeProtection: {
        pullRequestsAllowed: true,
        requiredRemoteChecks: ["ci/unit"],
      },
    });
    expect(Buffer.from(evidence.repositoryPolicyBytesBase64, "base64").toString("utf8")).toBe(POLICY);
    expect(urls.filter((url) => url.includes("/contents/"))).toHaveLength(2);
    expect(urls.filter((url) => /\/repos\/acme\/payments\/branches\/main(?:\?|$)/u.test(url))).toHaveLength(2);
    for (const url of urls.filter((candidate) => candidate.includes("/contents/"))) {
      expect(new URL(url, "https://github.example").searchParams.get("ref")).toBe(REQUESTED_BASE);
    }
  });

  it.each([
    [{ comparison: "diverged" } satisfies Scenario, /not proven reachable/u],
    [{ missingPolicy: true } satisfies Scenario, /missing at exact base/u],
    [{ malformedPolicy: true } satisfies Scenario, /policy is malformed/u],
    [{ racePolicy: true } satisfies Scenario, /observations contradicted/u],
    [{ raceBase: true } satisfies Scenario, /changed during admission/u],
  ])("fails closed on unreachable, missing, malformed, or racy evidence: %j", async (scenario, message) => {
    try {
      await observeScenario(scenario);
      expect.unreachable("expected repository admission refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(RunmillError);
      expect((error as RunmillError).code).toBe("RM-WO-004");
      expect((error as RunmillError).whatHappened).toMatch(message);
    }
  });

  it("refuses an unregistered repository before making a forge request", async () => {
    let calls = 0;
    const observer = new GitHubRepositoryAdmissionObserver({
      repository: "acme/payments",
      baseRef: "refs/heads/main",
      adapter: {
        observeBaseProtection: async () => { calls += 1; return {}; },
        observeCommitReachability: async () => { calls += 1; return {}; },
        observeFileAtCommit: async () => { calls += 1; return {}; },
      },
    });
    const request = payload();
    request.repository.repository = "attacker/fork";
    await expect(observer.observe(request)).rejects.toMatchObject({ code: "RM-WO-004" });
    expect(calls).toBe(0);
  });
});
