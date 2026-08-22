import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { z } from "zod";
import { RunmillError } from "../errors/runmill-error.js";
import { ALL_CHANGE_SCOPE } from "../workspace/path-scope.js";
import {
  parseChecksManifest,
  validateChecksManifest,
} from "../verification/manifest.js";
import { canonicalJson, sha256Digest } from "./canonical-json.js";
import type { BaseProtectionObservation } from "./github-effects.js";
import type {
  RepositoryAdmissionEvidence,
  RepositoryAdmissionObserver,
  WorkOrderPayload,
} from "./work-order.js";

const MAX_POLICY_BYTES = 1_048_576;
const DEFAULT_POLICY_PATH = ".runmill/checks.yaml";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const repositorySchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/u);
const baseRefSchema = z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/u);

export const gitHubCommitReachabilityObservationSchema = z
  .object({
    schema: z.literal("runmill.github-commit-reachability-observation/v1"),
    state: z.enum(["reachable", "unreachable", "unknown"]),
    repository: repositorySchema,
    base_ref: baseRefSchema,
    requested_base_sha: gitShaSchema,
    observed_base_sha: gitShaSchema,
    comparison_status: z.enum(["ahead", "behind", "diverged", "identical"]).nullable(),
    merge_base_sha: gitShaSchema.nullable(),
    evidence_digest: digestSchema,
    reason: z.string().min(1).max(1_024).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.state === "unknown") !== (value.reason !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "only an unknown reachability observation carries a reason",
      });
    }
    if (
      value.state !== "unknown" &&
      (value.comparison_status === null || value.merge_base_sha === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "a completed comparison must carry its status and merge base",
      });
    }
  });

export type GitHubCommitReachabilityObservation = z.infer<
  typeof gitHubCommitReachabilityObservationSchema
>;

export const gitHubCommitFileObservationSchema = z.discriminatedUnion("state", [
  z
    .object({
      schema: z.literal("runmill.github-commit-file-observation/v1"),
      state: z.literal("present"),
      repository: repositorySchema,
      commit_sha: gitShaSchema,
      path: z.string().min(1).max(4_096),
      blob_sha: gitShaSchema,
      size: z.number().int().nonnegative().max(MAX_POLICY_BYTES),
      bytes_base64: z.string().max(Math.ceil(MAX_POLICY_BYTES / 3) * 4),
      content_digest: digestSchema,
      evidence_digest: digestSchema,
    })
    .strict(),
  z
    .object({
      schema: z.literal("runmill.github-commit-file-observation/v1"),
      state: z.literal("absent"),
      repository: repositorySchema,
      commit_sha: gitShaSchema,
      path: z.string().min(1).max(4_096),
      evidence_digest: digestSchema,
    })
    .strict(),
  z
    .object({
      schema: z.literal("runmill.github-commit-file-observation/v1"),
      state: z.literal("unknown"),
      repository: repositorySchema,
      commit_sha: gitShaSchema,
      path: z.string().min(1).max(4_096),
      evidence_digest: digestSchema,
      reason: z.string().min(1).max(1_024),
    })
    .strict(),
]);

export type GitHubCommitFileObservation = z.infer<typeof gitHubCommitFileObservationSchema>;

/** Read-only forge boundary used by repository admission. */
export interface GitHubRepositoryAdmissionAdapter {
  observeBaseProtection(input: {
    readonly repository: string;
    readonly baseRef: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<unknown>;
  observeCommitReachability(input: {
    readonly repository: string;
    readonly baseRef: string;
    readonly requestedBaseSha: string;
    readonly observedBaseSha: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<unknown>;
  observeFileAtCommit(input: {
    readonly repository: string;
    readonly commitSha: string;
    readonly path: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<unknown>;
}

function admissionError(whatHappened: string, cause?: unknown): RunmillError {
  return RunmillError.fromCatalog("RM-WO-004", {
    whatHappened,
    ...(cause === undefined ? {} : { cause }),
  });
}

function normalizePolicyPath(path: string): string {
  if (
    path === "" ||
    path.length > 4_096 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new Error(`repository policy path must be normalized and repository-relative: ${JSON.stringify(path)}`);
  }
  return path;
}

function rawDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalBase64(value: string, expectedSize: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("file content is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.toString("base64") !== value ||
    bytes.length !== expectedSize ||
    bytes.length > MAX_POLICY_BYTES
  ) {
    throw new Error("file byte count or canonical base64 encoding is contradictory");
  }
  return bytes;
}

function assertBaseProtection(
  raw: unknown,
): Extract<BaseProtectionObservation, { readonly state: "present" }> {
  const parsed = z
    .object({
      state: z.literal("present"),
      evidence_digest: digestSchema,
      repository: repositorySchema,
      base_ref: baseRefSchema,
      base_sha: gitShaSchema,
      protection_digest: digestSchema,
      protection: z
        .object({
          required_checks: z.array(z.string().min(1).max(512)).max(10_000),
          requires_approval: z.boolean(),
          requires_conversation_resolution: z.boolean(),
          uses_merge_queue: z.boolean(),
        })
        .strict(),
    })
    .strict()
    .safeParse(raw);
  if (!parsed.success) {
    const unknown = raw as { readonly state?: unknown; readonly reason?: unknown };
    const reason =
      unknown.state === "unknown" && typeof unknown.reason === "string"
        ? `: ${unknown.reason}`
        : "";
    throw admissionError(`current GitHub base/protection evidence is missing or malformed${reason}`);
  }
  const value = parsed.data;
  const expectedProtectionDigest = sha256Digest({
    schema: "runmill.github-base-protection/v1",
    repository: value.repository.toLowerCase(),
    base_ref: value.base_ref,
    protection: value.protection,
  });
  const expectedEvidenceDigest = sha256Digest({
    schema: "runmill.github-base-protection-observation/v1",
    state: "present",
    repository: value.repository.toLowerCase(),
    base_ref: value.base_ref,
    base_sha: value.base_sha,
    protection_digest: value.protection_digest,
    protection: value.protection,
  });
  if (
    value.protection_digest !== expectedProtectionDigest ||
    value.evidence_digest !== expectedEvidenceDigest
  ) {
    throw admissionError("current GitHub protection digests do not bind their observations");
  }
  return value;
}

function assertReachability(raw: unknown): GitHubCommitReachabilityObservation {
  const parsed = gitHubCommitReachabilityObservationSchema.safeParse(raw);
  if (!parsed.success) {
    throw admissionError("GitHub commit-reachability evidence is missing or malformed");
  }
  const value = parsed.data;
  const unsigned =
    value.state === "unknown"
      ? {
          schema: value.schema,
          state: value.state,
          repository: value.repository,
          base_ref: value.base_ref,
          requested_base_sha: value.requested_base_sha,
          observed_base_sha: value.observed_base_sha,
          comparison_status: value.comparison_status,
          merge_base_sha: value.merge_base_sha,
          reason: value.reason ?? "unknown observation omitted its reason",
        }
      : {
          schema: value.schema,
          state: value.state,
          repository: value.repository,
          base_ref: value.base_ref,
          requested_base_sha: value.requested_base_sha,
          observed_base_sha: value.observed_base_sha,
          comparison_status: value.comparison_status,
          merge_base_sha: value.merge_base_sha,
        };
  if (sha256Digest(unsigned) !== value.evidence_digest) {
    throw admissionError("GitHub commit-reachability digest does not bind its observation");
  }
  return value;
}

function assertFile(raw: unknown): GitHubCommitFileObservation {
  const parsed = gitHubCommitFileObservationSchema.safeParse(raw);
  if (!parsed.success) {
    throw admissionError("base-commit repository-policy evidence is missing or malformed");
  }
  const { evidence_digest: _digest, ...unsigned } = parsed.data;
  if (sha256Digest(unsigned) !== parsed.data.evidence_digest) {
    throw admissionError("base-commit repository-policy observation digest is contradictory");
  }
  if (parsed.data.state === "present") {
    const bytes = canonicalBase64(parsed.data.bytes_base64, parsed.data.size);
    if (rawDigest(bytes) !== parsed.data.content_digest) {
      throw admissionError("base-commit repository-policy digest does not bind its bytes");
    }
    const gitBlobSha = createHash("sha1")
      .update(`blob ${String(bytes.length)}\0`, "utf8")
      .update(bytes)
      .digest("hex");
    if (gitBlobSha !== parsed.data.blob_sha) {
      throw admissionError("base-commit repository-policy bytes do not match the Git blob id");
    }
  }
  return parsed.data;
}

function parseBasePolicy(bytes: Buffer): {
  readonly definedLocalCheckIds: readonly string[];
  readonly requiredLocalCheckIds: readonly string[];
} {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw admissionError("base-commit repository policy is not valid UTF-8", cause);
  }

  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join("; "));
    }
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Array.isArray((value as Record<string, unknown>)["checks"])
    ) {
      throw new Error("top-level checks array is required");
    }
    const manifest = parseChecksManifest(source);
    const errors = validateChecksManifest(manifest);
    if (errors.length > 0) throw new Error(errors.join("; "));
    return {
      definedLocalCheckIds: [...new Set(manifest.checks.map((check) => check.id))].sort(),
      requiredLocalCheckIds: [
        ...new Set(manifest.checks.filter((check) => check.required).map((check) => check.id)),
      ].sort(),
    };
  } catch (cause) {
    throw admissionError("base-commit repository policy is malformed", cause);
  }
}

/**
 * Production GitHub admission observer.
 *
 * Repository identity, base ref and policy path are fixed by local operator
 * configuration. Every remote read is read-only. Mutable base/protection state
 * is read twice and must be byte-for-byte equivalent; immutable policy is read
 * twice from the requested commit and must also agree.
 */
export class GitHubRepositoryAdmissionObserver implements RepositoryAdmissionObserver {
  readonly #adapter: GitHubRepositoryAdmissionAdapter;
  readonly #repository: string;
  readonly #baseRef: string;
  readonly #policyPath: string;

  constructor(options: {
    readonly adapter: GitHubRepositoryAdmissionAdapter;
    readonly repository: string;
    readonly baseRef: string;
    readonly policyPath?: string | undefined;
  }) {
    if (!repositorySchema.safeParse(options.repository).success) {
      throw new Error(`GitHub repository must be owner/name, got ${JSON.stringify(options.repository)}`);
    }
    if (!baseRefSchema.safeParse(options.baseRef).success) {
      throw new Error(`GitHub base ref must be fully qualified, got ${JSON.stringify(options.baseRef)}`);
    }
    this.#adapter = options.adapter;
    this.#repository = options.repository;
    this.#baseRef = options.baseRef;
    this.#policyPath = normalizePolicyPath(options.policyPath ?? DEFAULT_POLICY_PATH);
  }

  async observe(payload: WorkOrderPayload): Promise<RepositoryAdmissionEvidence> {
    const requested = payload.repository;
    if (
      requested.forge !== "github" ||
      requested.repository.toLowerCase() !== this.#repository.toLowerCase() ||
      requested.base_ref !== this.#baseRef
    ) {
      throw admissionError("repository observation was requested outside its local GitHub registration");
    }

    const before = assertBaseProtection(
      await this.#adapter.observeBaseProtection({
        repository: this.#repository,
        baseRef: this.#baseRef,
      }),
    );
    const reachability = assertReachability(
      await this.#adapter.observeCommitReachability({
        repository: this.#repository,
        baseRef: this.#baseRef,
        requestedBaseSha: requested.base_sha.toLowerCase(),
        observedBaseSha: before.base_sha,
      }),
    );
    const firstPolicy = assertFile(
      await this.#adapter.observeFileAtCommit({
        repository: this.#repository,
        commitSha: requested.base_sha.toLowerCase(),
        path: this.#policyPath,
      }),
    );
    const secondPolicy = assertFile(
      await this.#adapter.observeFileAtCommit({
        repository: this.#repository,
        commitSha: requested.base_sha.toLowerCase(),
        path: this.#policyPath,
      }),
    );
    const after = assertBaseProtection(
      await this.#adapter.observeBaseProtection({
        repository: this.#repository,
        baseRef: this.#baseRef,
      }),
    );

    const expectedRepository = this.#repository.toLowerCase();
    if (
      before.repository.toLowerCase() !== expectedRepository ||
      before.base_ref !== this.#baseRef ||
      reachability.repository.toLowerCase() !== expectedRepository ||
      reachability.base_ref !== this.#baseRef ||
      reachability.requested_base_sha !== requested.base_sha.toLowerCase() ||
      reachability.observed_base_sha !== before.base_sha
    ) {
      throw admissionError("GitHub observations contradict the registered repository, base ref, or exact commits");
    }
    if (
      reachability.state !== "reachable" ||
      reachability.merge_base_sha !== requested.base_sha.toLowerCase() ||
      (reachability.comparison_status !== "ahead" && reachability.comparison_status !== "identical")
    ) {
      throw admissionError(
        `requested base ${requested.base_sha.toLowerCase()} is not proven reachable from ${this.#baseRef}`,
      );
    }
    if (
      firstPolicy.state !== "present" ||
      secondPolicy.state !== "present" ||
      firstPolicy.repository.toLowerCase() !== expectedRepository ||
      firstPolicy.commit_sha !== requested.base_sha.toLowerCase() ||
      firstPolicy.path !== this.#policyPath
    ) {
      throw admissionError(
        `repository policy ${this.#policyPath} is missing at exact base ${requested.base_sha.toLowerCase()}`,
      );
    }
    if (canonicalJson(firstPolicy) !== canonicalJson(secondPolicy)) {
      throw admissionError("repeated exact-base repository-policy observations contradicted each other");
    }
    if (canonicalJson(before) !== canonicalJson(after)) {
      throw admissionError("the configured GitHub base or its protection changed during admission");
    }

    const policyBytes = canonicalBase64(firstPolicy.bytes_base64, firstPolicy.size);
    const policy = parseBasePolicy(policyBytes);
    const protectionBytes = Buffer.from(
      canonicalJson({
        schema: "runmill.github-base-protection/v1",
        repository: before.repository.toLowerCase(),
        base_ref: before.base_ref,
        protection: before.protection,
      }),
      "utf8",
    );

    return {
      forge: "github",
      repository: this.#repository,
      baseRef: this.#baseRef,
      observedBaseSha: before.base_sha,
      requestedBaseShaReachable: true,
      repositoryPolicyDigest: firstPolicy.content_digest,
      repositoryPolicyBaseSha: firstPolicy.commit_sha,
      repositoryPolicyPath: firstPolicy.path,
      repositoryPolicyBytesBase64: firstPolicy.bytes_base64,
      forgeProtectionDigest: before.protection_digest,
      forgeProtectionBaseRef: before.base_ref,
      forgeProtectionBytesBase64: protectionBytes.toString("base64"),
      constraints: {
        pathScope: ALL_CHANGE_SCOPE,
        definedLocalCheckIds: policy.definedLocalCheckIds,
        requiredLocalCheckIds: policy.requiredLocalCheckIds,
        requiredRemoteChecks: [],
      },
      forgeProtection: {
        pullRequestsAllowed: true,
        requiredRemoteChecks: before.protection.required_checks,
      },
    };
  }
}
