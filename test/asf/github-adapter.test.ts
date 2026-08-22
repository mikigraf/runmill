import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionGitHubEffectsAdapter } from "../../src/asf/github-adapter.js";
import { sha256Digest } from "../../src/asf/canonical-json.js";

const CANDIDATE = "c".repeat(40);
const MARKER = "runmill:v1:work-order=wo_01;run=run_01;attempt=attempt_01";
const HEAD_REF = "refs/heads/runmill/run_01";
const BASE_REF = "refs/heads/main";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    html_url: "https://github.example/acme/payments/pull/42",
    body: `Delivery evidence\n<!-- ${MARKER} -->`,
    state: "open",
    draft: false,
    head: { ref: "runmill/run_01", sha: CANDIDATE },
    base: { ref: "main", sha: "b".repeat(40) },
    ...overrides,
  };
}

describe("ProductionGitHubEffectsAdapter", () => {
  it("returns content-addressed exact branch presence and absence observations", async () => {
    let missing = false;
    await withGitHubServer(
      (_request, response) => {
        if (missing) {
          json(response, 404, { message: "Not Found" });
        } else {
          json(response, 200, {
            ref: HEAD_REF,
            object: { type: "commit", sha: CANDIDATE, url: "https://api.example/commit" },
          });
        }
      },
      async (baseUrl) => {
        const adapter = new ProductionGitHubEffectsAdapter({
          token: "trusted-controller-token",
          baseUrl,
        });
        await expect(
          adapter.observeBranch({ repository: "acme/payments", ref: HEAD_REF }),
        ).resolves.toMatchObject({
          state: "present",
          sha: CANDIDATE,
          evidence_digest: expect.stringMatching(/^sha256:/u),
        });
        missing = true;
        await expect(
          adapter.observeBranch({ repository: "acme/payments", ref: HEAD_REF }),
        ).resolves.toMatchObject({
          state: "absent",
          evidence_digest: expect.stringMatching(/^sha256:/u),
        });
      },
    );
  });

  it("enumerates exact PR markers plus deterministic-head collisions", async () => {
    await withGitHubServer(
      (_request, response) => {
        json(response, 200, [
          pullRequest(),
          pullRequest({
            number: 43,
            html_url: "https://github.example/acme/payments/pull/43",
            body: "unrelated body",
          }),
          pullRequest({
            number: 44,
            html_url: "https://github.example/acme/payments/pull/44",
            body: `<!-- ${MARKER} -->`,
            head: { ref: "other", sha: "d".repeat(40) },
          }),
        ]);
      },
      async (baseUrl) => {
        const adapter = new ProductionGitHubEffectsAdapter({ token: "controller-token", baseUrl });
        const observed = await adapter.observePullRequests({
          repository: "acme/payments",
          headRef: HEAD_REF,
          baseRef: BASE_REF,
          marker: MARKER,
        });
        expect(observed).toMatchObject({
          state: "present",
          pull_requests: [
            { number: 42, marker: MARKER, head_sha: CANDIDATE },
            { number: 43, marker: "<missing>" },
            { number: 44, marker: MARKER, head_ref: "refs/heads/other" },
          ],
        });
      },
    );
  });

  it("returns digest-bound current base and readable protection evidence", async () => {
    const baseSha = "b".repeat(40);
    await withGitHubServer(
      (request, response) => {
        const url = request.url ?? "";
        if (url.includes("/rules/branches/main")) {
          return json(response, 200, [
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "ci/unit" }] },
            },
          ]);
        }
        if (/\/branches\/main(?:\?|$)/u.test(url)) {
          return json(response, 200, {
            name: "main",
            protected: false,
            commit: { sha: baseSha },
          });
        }
        return json(response, 404, { message: "not found" });
      },
      async (baseUrl) => {
        const adapter = new ProductionGitHubEffectsAdapter({ token: "controller-token", baseUrl });
        const observed = await adapter.observeBaseProtection({
          repository: "acme/payments",
          baseRef: BASE_REF,
        });
        expect(observed).toMatchObject({
          state: "present",
          repository: "acme/payments",
          base_ref: BASE_REF,
          base_sha: baseSha,
          protection: {
            required_checks: ["ci/unit"],
            requires_approval: false,
            requires_conversation_resolution: false,
            uses_merge_queue: false,
          },
        });
        if (observed.state !== "present") throw new Error("expected present base protection");
        expect(observed.protection_digest).toBe(
          sha256Digest({
            schema: "runmill.github-base-protection/v1",
            repository: "acme/payments",
            base_ref: BASE_REF,
            protection: observed.protection,
          }),
        );
      },
    );
  });

  it("creates a PR through the trusted host client only when the marker is in its body", async () => {
    let received: unknown;
    await withGitHubServer(
      (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => { body += chunk; });
        request.on("end", () => {
          received = JSON.parse(body) as unknown;
          json(response, 201, pullRequest());
        });
      },
      async (baseUrl) => {
        const adapter = new ProductionGitHubEffectsAdapter({ token: "controller-token", baseUrl });
        await expect(
          adapter.createPullRequest({
            repository: "acme/payments",
            headRef: HEAD_REF,
            baseRef: BASE_REF,
            candidateSha: CANDIDATE,
            marker: MARKER,
            title: "Bounded delivery",
            body: `Evidence\n<!-- ${MARKER} -->`,
            draft: false,
          }),
        ).resolves.toBeUndefined();
        expect(received).toMatchObject({
          head: "runmill/run_01",
          base: "main",
          title: "Bounded delivery",
          draft: false,
        });
        await expect(
          adapter.createPullRequest({
            repository: "acme/payments",
            headRef: HEAD_REF,
            baseRef: BASE_REF,
            candidateSha: CANDIDATE,
            marker: MARKER,
            title: "Missing marker",
            body: "no machine marker",
            draft: false,
          }),
        ).rejects.toThrow(/correlation marker/u);
      },
    );
  });

  it("turns API failure into redacted unknown evidence rather than guessing absence", async () => {
    await withGitHubServer(
      (_request, response) => {
        json(response, 503, { message: "upstream included trusted-controller-token" });
      },
      async (baseUrl) => {
        const adapter = new ProductionGitHubEffectsAdapter({
          token: "trusted-controller-token",
          baseUrl,
        });
        const observed = await adapter.observeBranch({
          repository: "acme/payments",
          ref: HEAD_REF,
        });
        expect(observed).toMatchObject({ state: "unknown", reason: expect.stringContaining("503") });
        expect(JSON.stringify(observed)).not.toContain("trusted-controller-token");
      },
    );
  });

  it("refuses a workspace whose HEAD is not the authorized candidate before network mutation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-github-effect-"));
    directories.push(directory);
    execFileSync("git", ["init", "-q"], { cwd: directory });
    writeFileSync(join(directory, "file.txt"), "content\n");
    execFileSync("git", ["add", "file.txt"], { cwd: directory });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "test"],
      { cwd: directory },
    );
    const adapter = new ProductionGitHubEffectsAdapter({ token: "controller-token" });

    await expect(
      adapter.pushBranch({
        repository: "acme/payments",
        ref: HEAD_REF,
        candidateSha: CANDIDATE,
        expectedRemoteSha: null,
        workspacePath: directory,
      }),
    ).rejects.toThrow(/does not match authorized candidate/u);
  });
});
