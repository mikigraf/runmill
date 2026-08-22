import { z } from "zod";
import { RunmillError } from "../errors/runmill-error.js";
import type { Clock } from "../platform/clock.js";
import type {
  AsfEffectObservationRow,
  AsfEffectRow,
  AsfGitHubEffectOperation,
  StateStore,
} from "../state/store.js";
import { canonicalJson, sha256Digest, type JsonValue } from "./canonical-json.js";

export const ASF_FINAL_PR_DELIVERY_OBSERVATION_SCHEMA =
  "asf.github-final-pr-delivery-observation/v1" as const;

const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const branchRefSchema = z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/u);

const branchObservationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent"), evidence_digest: digestSchema }).strict(),
  z
    .object({
      state: z.literal("present"),
      sha: gitShaSchema,
      evidence_digest: digestSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("unknown"),
      evidence_digest: digestSchema,
      reason: z.string().min(1).max(1_024),
    })
    .strict(),
]);

const pullRequestObservationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent"), evidence_digest: digestSchema }).strict(),
  z
    .object({
      state: z.literal("present"),
      evidence_digest: digestSchema,
      pull_requests: z.array(
        z
          .object({
            repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
            number: z.number().int().positive(),
            url: z.url(),
            head_ref: branchRefSchema,
            base_ref: branchRefSchema,
            head_sha: gitShaSchema,
            marker: z.string().min(1).max(1_024),
            state: z.enum(["open", "closed"]),
            draft: z.boolean(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      state: z.literal("unknown"),
      evidence_digest: digestSchema,
      reason: z.string().min(1).max(1_024),
    })
    .strict(),
]);

const baseProtectionObservationSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("present"),
      evidence_digest: digestSchema,
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
      base_ref: branchRefSchema,
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
    .strict(),
  z
    .object({
      state: z.literal("unknown"),
      evidence_digest: digestSchema,
      reason: z.string().min(1).max(1_024),
    })
    .strict(),
]);

const finalPullRequestDeliveryObservationSchema = z
  .object({
    schema: z.literal(ASF_FINAL_PR_DELIVERY_OBSERVATION_SCHEMA),
    evidence_digest: digestSchema,
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
    pull_request_number: z.number().int().positive(),
    url: z.url(),
    head_ref: branchRefSchema,
    base_ref: branchRefSchema,
    marker: z.string().min(1).max(1_024),
    head_sha: gitShaSchema,
    current_base_sha: gitShaSchema,
    collision_set_digest: digestSchema,
    base_observation_digest: digestSchema,
    protection_digest: digestSchema,
    protection: z
      .object({
        required_checks: z.array(z.string().min(1).max(512)).max(10_000),
        requires_approval: z.boolean(),
        requires_conversation_resolution: z.boolean(),
        uses_merge_queue: z.boolean(),
      })
      .strict(),
    observed_at: z.iso.datetime({ offset: true }),
    state: z.literal("open"),
    draft: z.boolean(),
  })
  .strict();

export type BranchObservation = z.infer<typeof branchObservationSchema>;
export type PullRequestObservation = z.infer<typeof pullRequestObservationSchema>;
export type BaseProtectionObservation = z.infer<typeof baseProtectionObservationSchema>;
export type FinalPullRequestDeliveryObservation = z.infer<
  typeof finalPullRequestDeliveryObservationSchema
>;

export function parseFinalPullRequestDeliveryObservation(
  raw: unknown,
): FinalPullRequestDeliveryObservation {
  return finalPullRequestDeliveryObservationSchema.parse(raw);
}

export interface AsfGitHubEffectAdapter {
  observeBranch(input: {
    readonly repository: string;
    readonly ref: string;
  }): Promise<unknown>;
  pushBranch(input: {
    readonly repository: string;
    readonly ref: string;
    readonly candidateSha: string;
    readonly expectedRemoteSha: string | null;
    readonly workspacePath: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<void>;
  observePullRequests(input: {
    readonly repository: string;
    readonly headRef: string;
    readonly baseRef: string;
    readonly marker: string;
  }): Promise<unknown>;
  /** Read-only current base and branch-protection evidence. Unknown fails closed. */
  observeBaseProtection(input: {
    readonly repository: string;
    readonly baseRef: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<unknown>;
  createPullRequest(input: {
    readonly repository: string;
    readonly headRef: string;
    readonly baseRef: string;
    readonly candidateSha: string;
    readonly marker: string;
    readonly title: string;
    readonly body: string;
    readonly draft: boolean;
    readonly signal?: AbortSignal | undefined;
  }): Promise<void>;
}

export type AsfEffectStore = Pick<
  StateStore,
  | "intendAsfEffect"
  | "getAsfEffect"
  | "listPendingAsfEffects"
  | "beginAsfEffect"
  | "recordAsfEffectObservation"
>;

export interface EffectFence {
  readonly runId: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly candidateSha: string;
  readonly policyDigest: string;
}

export interface ConfirmedBranchEffect {
  readonly effect: AsfEffectRow;
  readonly observation: AsfEffectObservationRow;
  readonly remoteSha: string;
}

export interface ConfirmedPullRequestEffect {
  readonly effect: AsfEffectRow;
  readonly observation: AsfEffectObservationRow;
  readonly pullRequest: z.infer<typeof pullRequestObservationSchema>["state"] extends "present"
    ? never
    : {
        readonly repository: string;
        readonly number: number;
        readonly url: string;
        readonly head_ref: string;
        readonly base_ref: string;
        readonly head_sha: string;
        readonly marker: string;
        readonly state: "open" | "closed";
        readonly draft: boolean;
      };
}

type ObservedPullRequest = Extract<
  PullRequestObservation,
  { readonly state: "present" }
>["pull_requests"][number];

function effectError(
  runId: string,
  effectKey: string,
  whatHappened: string,
  retryDisposition: "safe" | "reconcile-first" | "prohibited" = "reconcile-first",
): RunmillError {
  return RunmillError.fromCatalog("RM-STATE-002", {
    whatHappened,
    runId,
    cause: {
      retryDisposition,
      requiredActor: "platform-operator",
      requiredAction:
        retryDisposition === "safe"
          ? "retry only after the exact not-applied observation"
          : "inspect the named GitHub target and reconcile the recorded effect",
      evidenceRefs: [`effect:${effectKey}`],
    },
  });
}

function parseObservation<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  runId: string,
  effectKey: string,
  label: string,
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw effectError(
      runId,
      effectKey,
      `${label} returned malformed or contradictory observation evidence`,
      "prohibited",
    );
  }
  return parsed.data;
}

function branchTarget(repository: string, ref: string): string {
  return `${repository}#${ref}`;
}

function pullRequestTarget(repository: string, headRef: string, baseRef: string): string {
  return `${repository}#${headRef}->${baseRef}`;
}

function detailsDigest(value: JsonValue): `sha256:${string}` {
  return sha256Digest(value);
}

/**
 * Fenced GitHub mutation controller.
 *
 * Every call observes first. An in-flight or ambiguous prior mutation can
 * become retryable only through an exact `not_applied` observation. A remote
 * mutation response is never treated as confirmation; the controller re-reads
 * GitHub and persists that observation separately.
 */
export class AsfGitHubEffectsController {
  readonly #store: AsfEffectStore;
  readonly #adapter: AsfGitHubEffectAdapter;
  readonly #clock: Clock;

  constructor(options: {
    readonly store: AsfEffectStore;
    readonly adapter: AsfGitHubEffectAdapter;
    readonly clock: Clock;
  }) {
    this.#store = options.store;
    this.#adapter = options.adapter;
    this.#clock = options.clock;
  }

  /**
   * Final, read-only PR delivery gate.
   *
   * The collision set and current base/protection are each read twice. The
   * two complete snapshots must be byte-for-byte equivalent so a change while
   * the final observation is in progress cannot be accepted as one coherent
   * delivery fact. No GitHub mutation or GitHub effect-row write occurs here;
   * the caller owns the durable observation intent and confirmation.
   */
  async observeFinalDelivery(input: {
    readonly runId: string;
    readonly observationKey: string;
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly pullRequestUrl: string;
    readonly headRef: string;
    readonly baseRef: string;
    readonly marker: string;
    readonly candidateSha: string;
    readonly expectedBaseSha: string;
    readonly expectedProtectionDigest: string;
    readonly requiredContexts: readonly string[];
    readonly draft: boolean;
    readonly signal?: AbortSignal | undefined;
  }): Promise<FinalPullRequestDeliveryObservation> {
    const reject = (message: string): never => {
      throw effectError(input.runId, input.observationKey, message, "prohibited");
    };
    const assertActive = (): void => {
      if (input.signal?.aborted !== true) return;
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("final GitHub PR delivery observation was cancelled");
    };
    if (
      !gitShaSchema.safeParse(input.candidateSha).success ||
      !gitShaSchema.safeParse(input.expectedBaseSha).success ||
      !digestSchema.safeParse(input.expectedProtectionDigest).success ||
      !branchRefSchema.safeParse(input.headRef).success ||
      !branchRefSchema.safeParse(input.baseRef).success ||
      !Number.isSafeInteger(input.pullRequestNumber) ||
      input.pullRequestNumber < 1 ||
      !z.url().safeParse(input.pullRequestUrl).success ||
      input.marker.length < 1 ||
      input.marker.length > 1_024 ||
      input.requiredContexts.length > 10_000 ||
      input.requiredContexts.some(
        (context) =>
          context.length < 1 ||
          context.length > 512 ||
          /[\u0000-\u001f\u007f]/u.test(context),
      ) ||
      new Set(input.requiredContexts).size !== input.requiredContexts.length
    ) {
      return reject("final GitHub PR delivery request is malformed or incompletely bound");
    }

    const observePullRequests = async (): Promise<PullRequestObservation> => {
      assertActive();
      let raw: unknown;
      try {
        raw = await this.#adapter.observePullRequests({
          repository: input.repository,
          headRef: input.headRef,
          baseRef: input.baseRef,
          marker: input.marker,
        });
      } catch {
        return reject("final GitHub PR collision set could not be observed");
      }
      const parsed = pullRequestObservationSchema.safeParse(raw);
      if (!parsed.success || parsed.data.state === "unknown") {
        return reject("final GitHub PR collision evidence is missing, unknown, or malformed");
      }
      const rows = parsed.data.state === "present" ? parsed.data.pull_requests : [];
      const computedDigest = sha256Digest({
        schema: "runmill.github-pr-observation/v1",
        repository: input.repository.toLowerCase(),
        head_ref: input.headRef,
        base_ref: input.baseRef,
        marker: input.marker,
        pull_requests: rows,
      });
      if (parsed.data.evidence_digest !== computedDigest) {
        return reject("final GitHub PR collision digest contradicts its complete result set");
      }
      return parsed.data;
    };
    const observeBaseProtection = async (): Promise<
      Extract<BaseProtectionObservation, { readonly state: "present" }>
    > => {
      assertActive();
      let raw: unknown;
      try {
        raw = await this.#adapter.observeBaseProtection({
          repository: input.repository,
          baseRef: input.baseRef,
          signal: input.signal,
        });
      } catch {
        return reject("current GitHub base/protection evidence could not be observed");
      }
      const parsed = baseProtectionObservationSchema.safeParse(raw);
      if (!parsed.success || parsed.data.state !== "present") {
        return reject("current GitHub base/protection evidence is missing, unknown, or malformed");
      }
      const computedProtectionDigest = sha256Digest({
        schema: "runmill.github-base-protection/v1",
        repository: parsed.data.repository.toLowerCase(),
        base_ref: parsed.data.base_ref,
        protection: parsed.data.protection,
      });
      if (parsed.data.protection_digest !== computedProtectionDigest) {
        return reject("GitHub protection digest contradicts its normalized protection body");
      }
      const { evidence_digest: _evidenceDigest, ...unsignedBase } = parsed.data;
      if (
        parsed.data.evidence_digest !==
        sha256Digest({
          schema: "runmill.github-base-protection-observation/v1",
          ...unsignedBase,
        })
      ) {
        return reject("GitHub base observation digest contradicts its normalized body");
      }
      return parsed.data;
    };

    const pullRequestsBefore = await observePullRequests();
    const baseBefore = await observeBaseProtection();
    const pullRequestsAfter = await observePullRequests();
    const baseAfter = await observeBaseProtection();
    assertActive();
    if (
      pullRequestsBefore.evidence_digest !== pullRequestsAfter.evidence_digest ||
      canonicalJson(pullRequestsBefore) !== canonicalJson(pullRequestsAfter) ||
      baseBefore.evidence_digest !== baseAfter.evidence_digest ||
      canonicalJson(baseBefore) !== canonicalJson(baseAfter)
    ) {
      return reject("GitHub PR, base, or protection state changed during final delivery observation");
    }
    if (pullRequestsAfter.state !== "present") {
      return reject("the exact GitHub PR is missing at final delivery");
    }
    if (
      baseAfter.repository.toLowerCase() !== input.repository.toLowerCase() ||
      baseAfter.base_ref !== input.baseRef ||
      baseAfter.base_sha !== input.expectedBaseSha ||
      baseAfter.protection_digest !== input.expectedProtectionDigest
    ) {
      return reject("GitHub base or protection changed after candidate review");
    }
    if (
      baseAfter.protection.required_checks.length !==
        new Set(baseAfter.protection.required_checks).size ||
      !baseAfter.protection.required_checks.every((context) =>
        input.requiredContexts.includes(context),
      )
    ) {
      return reject("GitHub protection evidence widened beyond the effective required contexts");
    }

    const collisions = pullRequestsAfter.pull_requests;
    if (
      collisions.some(
        (pullRequest) =>
          pullRequest.head_ref !== input.headRef && pullRequest.marker !== input.marker,
      )
    ) {
      return reject("final GitHub PR observer returned an incomplete or non-collision result set");
    }
    const exact = collisions.filter(
      (pullRequest) =>
        pullRequest.repository.toLowerCase() === input.repository.toLowerCase() &&
        pullRequest.number === input.pullRequestNumber &&
        pullRequest.url === input.pullRequestUrl &&
        pullRequest.head_ref === input.headRef &&
        pullRequest.base_ref === input.baseRef &&
        pullRequest.marker === input.marker &&
        pullRequest.head_sha === input.candidateSha &&
        pullRequest.state === "open" &&
        pullRequest.draft === input.draft,
    );
    if (collisions.length !== 1 || exact.length !== 1) {
      return reject(
        "final GitHub PR is missing, duplicate, stale, closed, or changed after candidate review",
      );
    }
    const pullRequest = exact[0];
    if (pullRequest === undefined) {
      return reject("final GitHub PR identity could not be resolved exactly once");
    }
    const unsigned = {
      schema: ASF_FINAL_PR_DELIVERY_OBSERVATION_SCHEMA,
      repository: input.repository.toLowerCase(),
      pull_request_number: pullRequest.number,
      url: pullRequest.url,
      head_ref: pullRequest.head_ref,
      base_ref: pullRequest.base_ref,
      marker: pullRequest.marker,
      head_sha: pullRequest.head_sha,
      current_base_sha: baseAfter.base_sha,
      collision_set_digest: pullRequestsAfter.evidence_digest,
      base_observation_digest: baseAfter.evidence_digest,
      protection_digest: baseAfter.protection_digest,
      protection: baseAfter.protection,
      observed_at: this.#clock.now().toISOString(),
      state: "open" as const,
      draft: pullRequest.draft,
    } as const;
    return {
      ...unsigned,
      evidence_digest: sha256Digest(unsigned),
    };
  }

  async ensureBranch(input: EffectFence & {
    readonly repository: string;
    readonly ref: string;
    readonly workspacePath: string;
    readonly marker: string;
    /** Exact prior candidate authorized for a force-with-lease update. */
    readonly expectedRemoteSha: string | null;
    readonly signal?: AbortSignal | undefined;
  }): Promise<ConfirmedBranchEffect> {
    const target = branchTarget(input.repository, input.ref);
    const effect = this.#store.intendAsfEffect({
      ...input,
      operation: "branch.push",
      target,
      correlationMarker: input.marker,
      expectedRemoteSha: input.expectedRemoteSha,
    });
    const before = await this.#observeBranch(effect, input);
    if (before.confirmed !== undefined) return before.confirmed;
    if (
      before.remoteSha !== null &&
      before.remoteSha !== input.expectedRemoteSha
    ) {
      throw effectError(
        input.runId,
        effect.effectKey,
        `GitHub branch ${target} points to unexpected SHA ${before.remoteSha}; refusing overwrite`,
        "prohibited",
      );
    }

    this.#store.beginAsfEffect(effect.effectKey, input.ownerId, input.generation);
    let mutationError: unknown;
    try {
      await this.#adapter.pushBranch({
        repository: input.repository,
        ref: input.ref,
        candidateSha: input.candidateSha,
        expectedRemoteSha: input.expectedRemoteSha,
        workspacePath: input.workspacePath,
        signal: input.signal,
      });
    } catch (error) {
      mutationError = error;
    }
    const after = await this.#observeBranch(effect, input);
    if (after.confirmed !== undefined) return after.confirmed;
    throw effectError(
      input.runId,
      effect.effectKey,
      mutationError === undefined
        ? `GitHub accepted branch push but ${target} did not resolve to the candidate`
        : `branch push response was not definitive and exact observation proves no candidate`,
      mutationError === undefined ? "reconcile-first" : "safe",
    );
  }

  async #observeBranch(
    effect: AsfEffectRow,
    input: EffectFence & {
      readonly repository: string;
      readonly ref: string;
      readonly expectedRemoteSha?: string | null | undefined;
    },
  ): Promise<{
    readonly confirmed?: ConfirmedBranchEffect | undefined;
    readonly remoteSha: string | null;
  }> {
    let raw: unknown;
    try {
      raw = await this.#adapter.observeBranch({
        repository: input.repository,
        ref: input.ref,
      });
    } catch {
      const digest = detailsDigest({
        schema: "runmill.github-branch-observation/v1",
        state: "unknown",
        target: effect.target,
      });
      this.#store.recordAsfEffectObservation({
        effectKey: effect.effectKey,
        ownerId: input.ownerId,
        generation: input.generation,
        outcome: "ambiguous",
        candidateSha: effect.candidateSha,
        detailsDigest: digest,
        observer: "github:branch",
      });
      throw effectError(
        input.runId,
        effect.effectKey,
        `GitHub branch ${effect.target} could not be observed`,
      );
    }
    const observed = parseObservation(
      branchObservationSchema,
      raw,
      input.runId,
      effect.effectKey,
      "GitHub branch observer",
    );
    if (observed.state === "unknown") {
      this.#store.recordAsfEffectObservation({
        effectKey: effect.effectKey,
        ownerId: input.ownerId,
        generation: input.generation,
        outcome: "ambiguous",
        candidateSha: effect.candidateSha,
        detailsDigest: observed.evidence_digest,
        observer: "github:branch",
      });
      throw effectError(
        input.runId,
        effect.effectKey,
        `GitHub branch observation is unknown: ${observed.reason}`,
      );
    }
    if (observed.state === "present" && observed.sha === effect.candidateSha) {
      const observation = this.#store.recordAsfEffectObservation({
        effectKey: effect.effectKey,
        ownerId: input.ownerId,
        generation: input.generation,
        outcome: "confirmed",
        candidateSha: effect.candidateSha,
        detailsDigest: observed.evidence_digest,
        observer: "github:branch",
        remoteId: input.ref,
      });
      return {
        confirmed: {
          effect: this.#store.getAsfEffect(effect.effectKey) ?? effect,
          observation,
          remoteSha: observed.sha,
        },
        remoteSha: observed.sha,
      };
    }
    const outcome =
      observed.state === "absent" ||
      (observed.state === "present" && observed.sha === input.expectedRemoteSha)
        ? "not_applied"
        : "ambiguous";
    this.#store.recordAsfEffectObservation({
      effectKey: effect.effectKey,
      ownerId: input.ownerId,
      generation: input.generation,
      outcome,
      candidateSha: effect.candidateSha,
      detailsDigest: observed.evidence_digest,
      observer: "github:branch",
    });
    return {
      remoteSha: observed.state === "present" ? observed.sha : null,
    };
  }

  async ensurePullRequest(input: EffectFence & {
    readonly repository: string;
    readonly headRef: string;
    readonly baseRef: string;
    readonly marker: string;
    readonly title: string;
    readonly body: string;
    readonly draft: boolean;
    readonly signal?: AbortSignal | undefined;
  }): Promise<ConfirmedPullRequestEffect> {
    const target = pullRequestTarget(input.repository, input.headRef, input.baseRef);
    const effect = this.#store.intendAsfEffect({
      ...input,
      operation: "pull_request.create",
      target,
      correlationMarker: input.marker,
    });
    const before = await this.#observePullRequest(effect, input);
    if (before !== undefined) return before;

    this.#store.beginAsfEffect(effect.effectKey, input.ownerId, input.generation);
    let mutationError: unknown;
    try {
      await this.#adapter.createPullRequest({
        repository: input.repository,
        headRef: input.headRef,
        baseRef: input.baseRef,
        candidateSha: input.candidateSha,
        marker: input.marker,
        title: input.title,
        body: input.body,
        draft: input.draft,
        signal: input.signal,
      });
    } catch (error) {
      mutationError = error;
    }
    const after = await this.#observePullRequest(effect, input);
    if (after !== undefined) return after;
    throw effectError(
      input.runId,
      effect.effectKey,
      mutationError === undefined
        ? `GitHub accepted PR creation but no exactly marked PR was observed for ${target}`
        : `PR creation response was not definitive and exact observation proves no marked PR`,
      mutationError === undefined ? "reconcile-first" : "safe",
    );
  }

  async #observePullRequest(
    effect: AsfEffectRow,
    input: EffectFence & {
      readonly repository: string;
      readonly headRef: string;
      readonly baseRef: string;
      readonly marker: string;
    },
  ): Promise<ConfirmedPullRequestEffect | undefined> {
    let raw: unknown;
    try {
      raw = await this.#adapter.observePullRequests({
        repository: input.repository,
        headRef: input.headRef,
        baseRef: input.baseRef,
        marker: input.marker,
      });
    } catch {
      const digest = detailsDigest({
        schema: "runmill.github-pr-observation/v1",
        state: "unknown",
        target: effect.target,
      });
      this.#store.recordAsfEffectObservation({
        effectKey: effect.effectKey,
        ownerId: input.ownerId,
        generation: input.generation,
        outcome: "ambiguous",
        candidateSha: effect.candidateSha,
        detailsDigest: digest,
        observer: "github:pull-request",
      });
      throw effectError(input.runId, effect.effectKey, "GitHub pull requests could not be observed");
    }
    const observed = parseObservation(
      pullRequestObservationSchema,
      raw,
      input.runId,
      effect.effectKey,
      "GitHub pull-request observer",
    );
    if (observed.state === "unknown") {
      this.#store.recordAsfEffectObservation({
        effectKey: effect.effectKey,
        ownerId: input.ownerId,
        generation: input.generation,
        outcome: "ambiguous",
        candidateSha: effect.candidateSha,
        detailsDigest: observed.evidence_digest,
        observer: "github:pull-request",
      });
      throw effectError(
        input.runId,
        effect.effectKey,
        `GitHub pull-request observation is unknown: ${observed.reason}`,
      );
    }
    if (observed.state === "absent") {
      this.#store.recordAsfEffectObservation({
        effectKey: effect.effectKey,
        ownerId: input.ownerId,
        generation: input.generation,
        outcome: "not_applied",
        candidateSha: effect.candidateSha,
        detailsDigest: observed.evidence_digest,
        observer: "github:pull-request",
      });
      return undefined;
    }

    const exact = observed.pull_requests.filter(
      (pullRequest) =>
        pullRequest.repository.toLowerCase() === input.repository.toLowerCase() &&
        pullRequest.head_ref === input.headRef &&
        pullRequest.base_ref === input.baseRef &&
        pullRequest.marker === input.marker &&
        pullRequest.head_sha === input.candidateSha,
    );
    const conflicts = observed.pull_requests.filter(
      (pullRequest) =>
        pullRequest.head_ref === input.headRef || pullRequest.marker === input.marker,
    );
    if (exact.length !== 1 || conflicts.length !== 1) {
      this.#store.recordAsfEffectObservation({
        effectKey: effect.effectKey,
        ownerId: input.ownerId,
        generation: input.generation,
        outcome: "ambiguous",
        candidateSha: effect.candidateSha,
        detailsDigest: observed.evidence_digest,
        observer: "github:pull-request",
      });
      throw effectError(
        input.runId,
        effect.effectKey,
        "GitHub PR marker/head/base/candidate observation is missing, duplicate, or contradictory",
        "prohibited",
      );
    }
    const pullRequest = exact[0] as ObservedPullRequest;
    const observation = this.#store.recordAsfEffectObservation({
      effectKey: effect.effectKey,
      ownerId: input.ownerId,
      generation: input.generation,
      outcome: "confirmed",
      candidateSha: effect.candidateSha,
      detailsDigest: observed.evidence_digest,
      observer: "github:pull-request",
      remoteId: String(pullRequest.number),
    });
    return {
      effect: this.#store.getAsfEffect(effect.effectKey) ?? effect,
      observation,
      pullRequest,
    };
  }

  /** Startup/periodic reconciliation observes pending effects and never mutates. */
  async reconcilePending(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly generation: number;
  }): Promise<readonly AsfEffectRow[]> {
    const pending = this.#store.listPendingAsfEffects(input.runId);
    for (const effect of pending) {
      if (effect.operation === "branch.push") {
        const separator = effect.target.indexOf("#");
        if (separator < 1) {
          throw effectError(input.runId, effect.effectKey, "stored branch target is malformed");
        }
        await this.#observeBranch(effect, {
          ...input,
          candidateSha: effect.candidateSha,
          policyDigest: effect.policyDigest,
          repository: effect.target.slice(0, separator),
          ref: effect.target.slice(separator + 1),
          expectedRemoteSha: effect.expectedRemoteSha,
        });
      } else if (effect.operation === "pull_request.create") {
        const match = /^(?<repository>[^#]+)#(?<head>refs\/heads\/.+)->(?<base>refs\/heads\/.+)$/u.exec(
          effect.target,
        );
        if (match?.groups === undefined) {
          throw effectError(input.runId, effect.effectKey, "stored pull-request target is malformed");
        }
        await this.#observePullRequest(effect, {
          ...input,
          candidateSha: effect.candidateSha,
          policyDigest: effect.policyDigest,
          repository: match.groups["repository"] ?? "",
          headRef: match.groups["head"] ?? "",
          baseRef: match.groups["base"] ?? "",
          marker: effect.correlationMarker,
        });
      }
    }
    return pending.map((effect) => this.#store.getAsfEffect(effect.effectKey) ?? effect);
  }
}

export const ASF_AUTOMATIC_GITHUB_EFFECTS = [
  "branch.push",
  "pull_request.create",
] as const satisfies readonly AsfGitHubEffectOperation[];
