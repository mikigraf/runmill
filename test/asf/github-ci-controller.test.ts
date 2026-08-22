import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { sha256Digest, type JsonValue } from "../../src/asf/canonical-json.js";
import {
  ASF_CI_HEAD_OBSERVATION_SCHEMA,
  ProductionGitHubCiController,
} from "../../src/asf/github-ci-controller.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const CANDIDATE = "c".repeat(40);
const OTHER_SHA = "d".repeat(40);
const DIGEST = `sha256:${"a".repeat(64)}`;
const TOKEN = "trusted-controller-token";
const CLOCK = new FakeClock("2026-08-21T12:05:00.000Z");

type ObservationInput = Parameters<ProductionGitHubCiController["observeExactHead"]>[0];

function observationInput(
  requiredContexts: readonly string[],
  overrides: Partial<ObservationInput> = {},
): ObservationInput {
  const binding = {
    runId: "run_01",
    workOrderId: "wo_01",
    attemptId: "attempt_01",
    policyDigest: DIGEST,
    fencingGeneration: 7,
    candidateSha: CANDIDATE,
  } as const;
  return {
    binding,
    intent: {
      schema: "asf.delivery-stage-intent/v1",
      intent_id: "intent_ci_01",
      intent_digest: DIGEST,
      effect_key: "effect_ci_01",
      stage: "ci",
      run_id: binding.runId,
      work_order_id: binding.workOrderId,
      attempt_id: binding.attemptId,
      policy_digest: binding.policyDigest,
      fencing_generation: binding.fencingGeneration,
      candidate_sha: binding.candidateSha,
      event_seq: 12,
      operation_digest: DIGEST,
      created_at: "2026-08-21T12:00:00.000Z",
    },
    intentMode: "observe-before-apply",
    signal: new AbortController().signal,
    repository: "Acme/Payments",
    pullRequestNumber: 42,
    candidateSha: CANDIDATE,
    requiredContexts,
    ...overrides,
  };
}

function pullRequest(headSha = CANDIDATE) {
  return {
    number: 42,
    state: "open",
    head: { sha: headSha },
    base: { repo: { full_name: "acme/payments" } },
  };
}

function checkRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "ci/check-run",
    head_sha: CANDIDATE,
    status: "completed",
    conclusion: "success",
    started_at: "2026-08-21T12:00:00Z",
    completed_at: "2026-08-21T12:01:00Z",
    app: { id: 99 },
    ...overrides,
  };
}

function commitStatus(overrides: Record<string, unknown> = {}) {
  return {
    id: 500,
    context: "ci/status",
    sha: CANDIDATE,
    state: "success",
    updated_at: "2026-08-21T12:01:00Z",
    creator: { id: 101 },
    ...overrides,
  };
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
    server.listen(0, "127.0.0.1", resolve);
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

describe("ProductionGitHubCiController", () => {
  it("re-reads the PR, completely paginates both APIs, and binds normalized checks", async () => {
    const calls = { pull: 0, checkPages: [] as number[], statusPages: [] as number[] };
    await withGitHubServer(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const page = Number(url.searchParams.get("page") ?? "1");
        if (url.pathname.endsWith("/pulls/42")) {
          calls.pull += 1;
          return json(response, 200, pullRequest());
        }
        if (url.pathname.endsWith(`/commits/${CANDIDATE}/check-runs`)) {
          calls.checkPages.push(page);
          return json(response, 200, {
            total_count: 2,
            check_runs:
              page === 1
                ? [checkRun({ id: 1, name: "unrequired/check" })]
                : [checkRun({ id: 2 })],
          });
        }
        if (url.pathname.endsWith(`/commits/${CANDIDATE}/statuses`)) {
          calls.statusPages.push(page);
          return json(
            response,
            200,
            page === 1
              ? Array.from({ length: 100 }, (_, index) =>
                  commitStatus({ id: 1_000 + index, context: `unrequired/status-${index}` }),
                )
              : [commitStatus()],
          );
        }
        return json(response, 404, { message: "not found" });
      },
      async (baseUrl) => {
        const controller = new ProductionGitHubCiController({ token: TOKEN, baseUrl, clock: CLOCK });
        const observed = await controller.observeExactHead(
          observationInput(["ci/status", "ci/check-run"]),
        );
        expect(calls).toEqual({ pull: 2, checkPages: [1, 2], statusPages: [1, 2] });
        expect(observed).toMatchObject({
          schema: ASF_CI_HEAD_OBSERVATION_SCHEMA,
          binding: {
            run_id: "run_01",
            work_order_id: "wo_01",
            attempt_id: "attempt_01",
            policy_digest: DIGEST,
            fencing_generation: 7,
            candidate_sha: CANDIDATE,
          },
          repository: "acme/payments",
          pull_request_number: 42,
          candidate_sha: CANDIDATE,
          observed_head_sha: CANDIDATE,
          observed_at: CLOCK.now().toISOString(),
          checks: [
            {
              context: "ci/check-run",
              outcome: "passed",
              evidence_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
            },
            {
              context: "ci/status",
              outcome: "passed",
              evidence_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
            },
          ],
        });
        const { evidence_digest: evidenceDigest, ...unsigned } = observed;
        expect(evidenceDigest).toBe(sha256Digest(unsigned as unknown as JsonValue));
      },
    );
  });

  it("emits one fail-closed outcome per required context while allowing a newer rerun", async () => {
    const at = "2026-08-21T12:01:00Z";
    const runs = [
      checkRun({ id: 1, name: "ci/skipped", conclusion: "skipped" }),
      checkRun({ id: 2, name: "ci/neutral", conclusion: "neutral" }),
      checkRun({ id: 3, name: "ci/cancelled", conclusion: "cancelled" }),
      checkRun({ id: 4, name: "ci/stale", conclusion: "stale" }),
      checkRun({ id: 5, name: "ci/unknown", conclusion: "future_conclusion" }),
      checkRun({ id: 6, name: "ci/contradictory", conclusion: "success", completed_at: at }),
      checkRun({ id: 7, name: "ci/contradictory", conclusion: "failure", completed_at: at }),
      checkRun({
        id: 8,
        name: "ci/pending",
        status: "in_progress",
        conclusion: null,
        started_at: at,
        completed_at: null,
      }),
      checkRun({
        id: 9,
        name: "ci/rerun",
        conclusion: "failure",
        completed_at: "2026-08-21T11:00:00Z",
      }),
      checkRun({ id: 10, name: "ci/rerun", conclusion: "success", completed_at: at }),
      checkRun({ id: 11, name: "ci/passed", conclusion: "success" }),
      checkRun({
        id: 12,
        name: "ci/provider-conflict",
        conclusion: "failure",
        completed_at: "2026-08-21T11:00:00Z",
        app: { id: 99 },
      }),
      checkRun({
        id: 13,
        name: "ci/provider-conflict",
        conclusion: "success",
        completed_at: "2026-08-21T12:02:00Z",
        app: { id: 100 },
      }),
      checkRun({ id: 14, name: "ci/unattributed", conclusion: "success", app: null }),
      checkRun({
        id: 15,
        name: "ci/cross-source",
        conclusion: "failure",
        completed_at: "2026-08-21T11:00:00Z",
      }),
    ];
    const required = [
      "ci/missing",
      "ci/skipped",
      "ci/neutral",
      "ci/cancelled",
      "ci/stale",
      "ci/unknown",
      "ci/contradictory",
      "ci/pending",
      "ci/rerun",
      "ci/passed",
      "ci/provider-conflict",
      "ci/unattributed",
      "ci/cross-source",
    ];
    await withGitHubServer(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname.endsWith("/pulls/42")) return json(response, 200, pullRequest());
        if (url.pathname.endsWith("/check-runs")) {
          return json(response, 200, { total_count: runs.length, check_runs: runs });
        }
        if (url.pathname.endsWith("/statuses")) {
          return json(response, 200, [
            commitStatus({
              context: "ci/cross-source",
              updated_at: "2026-08-21T12:02:00Z",
            }),
          ]);
        }
        return json(response, 404, { message: "not found" });
      },
      async (baseUrl) => {
        const controller = new ProductionGitHubCiController({ token: TOKEN, baseUrl, clock: CLOCK });
        const observed = await controller.observeExactHead(observationInput(required));
        expect(Object.fromEntries(observed.checks.map((check) => [check.context, check.outcome])))
          .toEqual({
            "ci/cancelled": "failed",
            "ci/contradictory": "failed",
            "ci/cross-source": "failed",
            "ci/missing": "not-scheduled",
            "ci/neutral": "failed",
            "ci/passed": "passed",
            "ci/pending": "pending",
            "ci/provider-conflict": "failed",
            "ci/rerun": "passed",
            "ci/skipped": "failed",
            "ci/stale": "failed",
            "ci/unattributed": "failed",
            "ci/unknown": "failed",
          });
        expect(observed.checks).toHaveLength(required.length);
      },
    );
  });

  it("refuses a stale named PR before trusting any CI response", async () => {
    let ciReads = 0;
    await withGitHubServer(
      (request, response) => {
        if ((request.url ?? "").includes("/pulls/42")) {
          return json(response, 200, pullRequest(OTHER_SHA));
        }
        ciReads += 1;
        return json(response, 200, []);
      },
      async (baseUrl) => {
        const controller = new ProductionGitHubCiController({ token: TOKEN, baseUrl, clock: CLOCK });
        await expect(
          controller.observeExactHead(observationInput(["ci/check-run"])),
        ).rejects.toThrow(/stale.*exact repository and candidate head/u);
        expect(ciReads).toBe(0);
      },
    );
  });

  it("refuses when the PR head changes during the paginated observation", async () => {
    let pullReads = 0;
    await withGitHubServer(
      (request, response) => {
        const url = request.url ?? "";
        if (url.includes("/pulls/42")) {
          pullReads += 1;
          return json(response, 200, pullRequest(pullReads === 1 ? CANDIDATE : OTHER_SHA));
        }
        if (url.includes("/check-runs")) {
          return json(response, 200, { total_count: 1, check_runs: [checkRun()] });
        }
        if (url.includes("/statuses")) return json(response, 200, []);
        return json(response, 404, { message: "not found" });
      },
      async (baseUrl) => {
        const controller = new ProductionGitHubCiController({ token: TOKEN, baseUrl, clock: CLOCK });
        await expect(
          controller.observeExactHead(observationInput(["ci/check-run"])),
        ).rejects.toThrow(/stale.*exact repository and candidate head/u);
        expect(pullReads).toBe(2);
      },
    );
  });

  it("rejects stale-SHA observations and bounded-result overflow", async () => {
    for (const responseBody of [
      { total_count: 1, check_runs: [checkRun({ head_sha: OTHER_SHA })] },
      { total_count: 10_001, check_runs: [] },
    ]) {
      await withGitHubServer(
        (request, response) => {
          const url = request.url ?? "";
          if (url.includes("/pulls/42")) return json(response, 200, pullRequest());
          if (url.includes("/check-runs")) return json(response, 200, responseBody);
          if (url.includes("/statuses")) return json(response, 200, []);
          return json(response, 404, { message: "not found" });
        },
        async (baseUrl) => {
          const controller = new ProductionGitHubCiController({ token: TOKEN, baseUrl, clock: CLOCK });
          await expect(
            controller.observeExactHead(observationInput(["ci/check-run"])),
          ).rejects.toThrow(/stale candidate evidence|protected observation bound/u);
        },
      );
    }
  });

  it("honors in-flight cancellation and never leaks provider response text or token", async () => {
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    await withGitHubServer(
      (_request, response) => {
        requestStarted?.();
        setTimeout(() => {
          if (!response.destroyed) {
            json(response, 503, { message: `upstream echoed ${TOKEN}` });
          }
        }, 100);
      },
      async (baseUrl) => {
        const abort = new AbortController();
        const controller = new ProductionGitHubCiController({ token: TOKEN, baseUrl, clock: CLOCK });
        const pending = controller.observeExactHead(
          observationInput(["ci/check-run"], { signal: abort.signal }),
        );
        await started;
        abort.abort(new Error(`cancel ${TOKEN}`));
        const error = await pending.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/cancelled/u);
        expect((error as Error).message).not.toContain(TOKEN);
      },
    );

    await withGitHubServer(
      (_request, response) => {
        json(response, 503, { message: `upstream echoed ${TOKEN}` });
      },
      async (baseUrl) => {
        const controller = new ProductionGitHubCiController({ token: TOKEN, baseUrl, clock: CLOCK });
        const error = await controller
          .observeExactHead(observationInput(["ci/check-run"]))
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("GitHub CI observation failed with status 503");
        expect((error as Error).message).not.toContain(TOKEN);
      },
    );
  });
});
