import { describe, expect, it } from "vitest";
import {
  AsfGitHubEffectsController,
  type AsfEffectStore,
  type AsfGitHubEffectAdapter,
  type EffectFence,
} from "../../src/asf/github-effects.js";
import { sha256Digest } from "../../src/asf/canonical-json.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import {
  StateStore,
  type AsfEffectObservationRow,
  type AsfEffectRow,
} from "../../src/state/store.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const CANDIDATE = "c".repeat(40);
const OTHER_SHA = "d".repeat(40);
const POLICY = `sha256:${"a".repeat(64)}`;
const EVIDENCE = `sha256:${"b".repeat(64)}`;
const REPOSITORY = "acme/payments";
const HEAD_REF = "refs/heads/runmill/run_01";
const BASE_REF = "refs/heads/main";
const MARKER = "runmill:v1:work-order=wo_01;run=run_01;attempt=attempt_01";
const PROTECTION = {
  required_checks: ["ci/unit"],
  requires_approval: false,
  requires_conversation_resolution: false,
  uses_merge_queue: false,
} as const;
const PROTECTION_DIGEST = sha256Digest({
  schema: "runmill.github-base-protection/v1",
  repository: REPOSITORY,
  base_ref: BASE_REF,
  protection: PROTECTION,
});

const fence: EffectFence = {
  runId: "run_01",
  ownerId: "worker_01",
  generation: 7,
  candidateSha: CANDIDATE,
  policyDigest: POLICY,
};

class FakeEffectStore implements AsfEffectStore {
  readonly effects = new Map<string, AsfEffectRow>();
  readonly observations: AsfEffectObservationRow[] = [];
  begins = 0;

  intendAsfEffect(
    input: Parameters<AsfEffectStore["intendAsfEffect"]>[0],
  ): AsfEffectRow {
    const effectKey = StateStore.asfEffectKey(input);
    const existing = this.effects.get(effectKey);
    if (existing !== undefined) return existing;
    const effect: AsfEffectRow = {
      effectKey,
      runId: input.runId,
      generation: input.generation,
      system: "github",
      operation: input.operation,
      target: input.target,
      correlationMarker: input.correlationMarker,
      candidateSha: input.candidateSha,
      expectedRemoteSha: input.expectedRemoteSha ?? null,
      policyDigest: input.policyDigest,
      intentDigest: sha256Digest({ effect_key: effectKey, marker: input.correlationMarker }),
      status: "intended",
      remoteId: null,
      observationDigest: null,
      retryProhibited: 0,
      intendedAt: "2026-08-21T10:00:00Z",
      updatedAt: "2026-08-21T10:00:00Z",
    };
    this.effects.set(effectKey, effect);
    return effect;
  }

  getAsfEffect(effectKey: string): AsfEffectRow | undefined {
    return this.effects.get(effectKey);
  }

  listPendingAsfEffects(runId?: string): AsfEffectRow[] {
    return [...this.effects.values()].filter(
      (effect) =>
        (runId === undefined || effect.runId === runId) &&
        ["intended", "in_flight", "ambiguous"].includes(effect.status),
    );
  }

  beginAsfEffect(effectKey: string, _ownerId: string, generation: number): AsfEffectRow {
    const effect = this.effects.get(effectKey);
    if (effect === undefined) throw new Error("missing fake effect");
    if (effect.status !== "intended" && effect.status !== "not_applied") {
      throw new Error(`blind retry from ${effect.status}`);
    }
    this.begins += 1;
    const updated: AsfEffectRow = {
      ...effect,
      status: "in_flight",
      generation,
    };
    this.effects.set(effectKey, updated);
    return updated;
  }

  recordAsfEffectObservation(
    input: Parameters<AsfEffectStore["recordAsfEffectObservation"]>[0],
  ): AsfEffectObservationRow {
    const effect = this.effects.get(input.effectKey);
    if (effect === undefined) throw new Error("missing fake effect");
    const observation: AsfEffectObservationRow = {
      effectKey: input.effectKey,
      seq: this.observations.filter((item) => item.effectKey === input.effectKey).length + 1,
      outcome: input.outcome,
      candidateSha: input.candidateSha,
      detailsDigest: input.detailsDigest,
      observer: input.observer,
      observedAt: "2026-08-21T10:00:01Z",
    };
    this.observations.push(observation);
    this.effects.set(input.effectKey, {
      ...effect,
      generation: input.generation,
      status: input.outcome,
      remoteId: input.remoteId ?? effect.remoteId,
      observationDigest: input.detailsDigest,
      retryProhibited: input.outcome === "ambiguous" ? 1 : 0,
    });
    return observation;
  }
}

class FakeGitHubEffects implements AsfGitHubEffectAdapter {
  readonly branchObservations: unknown[] = [];
  readonly pullRequestObservations: unknown[] = [];
  readonly baseProtectionObservations: unknown[] = [];
  pushes = 0;
  creates = 0;
  throwAfterPush = false;
  throwAfterCreate = false;

  async observeBranch(): Promise<unknown> {
    const next = this.branchObservations.shift();
    if (next instanceof Error) throw next;
    return next;
  }

  async pushBranch(): Promise<void> {
    this.pushes += 1;
    if (this.throwAfterPush) throw new Error("response lost after push");
  }

  async observePullRequests(): Promise<unknown> {
    const next = this.pullRequestObservations.shift();
    if (next instanceof Error) throw next;
    return next;
  }

  async observeBaseProtection(): Promise<unknown> {
    const next = this.baseProtectionObservations.shift();
    if (next instanceof Error) throw next;
    return next;
  }

  async createPullRequest(): Promise<void> {
    this.creates += 1;
    if (this.throwAfterCreate) throw new Error("response lost after PR create");
  }
}

function absentBranch() {
  return { state: "absent", evidence_digest: EVIDENCE } as const;
}

function presentBranch(sha = CANDIDATE) {
  return { state: "present", sha, evidence_digest: EVIDENCE } as const;
}

function unknownBranch() {
  return { state: "unknown", reason: "GitHub unavailable", evidence_digest: EVIDENCE } as const;
}

function absentPullRequest() {
  return { state: "absent", evidence_digest: EVIDENCE } as const;
}

function presentPullRequests(
  overrides: Partial<{
    repository: string;
    number: number;
    url: string;
    head_ref: string;
    base_ref: string;
    head_sha: string;
    marker: string;
    state: "open" | "closed";
    draft: boolean;
  }> = {},
) {
  const pullRequests = [
    {
      repository: REPOSITORY,
      number: 42,
      url: "https://github.example/acme/payments/pull/42",
      head_ref: HEAD_REF,
      base_ref: BASE_REF,
      head_sha: CANDIDATE,
      marker: MARKER,
      state: "open" as const,
      draft: false,
      ...overrides,
    },
  ];
  return {
    state: "present",
    evidence_digest: sha256Digest({
      schema: "runmill.github-pr-observation/v1",
      repository: REPOSITORY,
      head_ref: HEAD_REF,
      base_ref: BASE_REF,
      marker: MARKER,
      pull_requests: pullRequests,
    }),
    pull_requests: pullRequests,
  } as const;
}

function presentBaseProtection(
  overrides: Partial<{
    repository: string;
    base_ref: string;
    base_sha: string;
    protection_digest: string;
    protection: {
      required_checks: string[];
      requires_approval: boolean;
      requires_conversation_resolution: boolean;
      uses_merge_queue: boolean;
    };
  }> = {},
) {
  const protection = overrides.protection ?? {
    required_checks: [...PROTECTION.required_checks],
    requires_approval: PROTECTION.requires_approval,
    requires_conversation_resolution: PROTECTION.requires_conversation_resolution,
    uses_merge_queue: PROTECTION.uses_merge_queue,
  };
  const unsigned = {
    state: "present" as const,
    repository: overrides.repository ?? REPOSITORY,
    base_ref: overrides.base_ref ?? BASE_REF,
    base_sha: overrides.base_sha ?? OTHER_SHA,
    protection_digest: overrides.protection_digest ?? PROTECTION_DIGEST,
    protection,
  };
  return {
    ...unsigned,
    evidence_digest: sha256Digest({
      schema: "runmill.github-base-protection-observation/v1",
      ...unsigned,
    }),
  };
}

function branchInput() {
  return {
    ...fence,
    repository: REPOSITORY,
    ref: HEAD_REF,
    workspacePath: "/protected/workspace",
    marker: MARKER,
    expectedRemoteSha: null,
  } as const;
}

function pullRequestInput() {
  return {
    ...fence,
    repository: REPOSITORY,
    headRef: HEAD_REF,
    baseRef: BASE_REF,
    marker: MARKER,
    title: "Bounded change",
    body: `Machine marker: ${MARKER}`,
    draft: false,
  } as const;
}

function controller(store: FakeEffectStore, adapter: FakeGitHubEffects) {
  return new AsfGitHubEffectsController({
    store,
    adapter,
    clock: new FakeClock("2026-08-21T10:00:02.000Z"),
  });
}

function finalDeliveryInput() {
  return {
    runId: fence.runId,
    observationKey: "delivery-final-observation-01",
    repository: REPOSITORY,
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.example/acme/payments/pull/42",
    headRef: HEAD_REF,
    baseRef: BASE_REF,
    marker: MARKER,
    candidateSha: CANDIDATE,
    expectedBaseSha: OTHER_SHA,
    expectedProtectionDigest: PROTECTION_DIGEST,
    requiredContexts: ["ci/unit"],
    draft: false,
  } as const;
}

describe("AsfGitHubEffectsController", () => {
  it("writes intent, observes absence, mutates once, and confirms the exact branch SHA", async () => {
    const store = new FakeEffectStore();
    const adapter = new FakeGitHubEffects();
    adapter.branchObservations.push(absentBranch(), presentBranch());

    const result = await controller(store, adapter).ensureBranch(branchInput());

    expect(adapter.pushes).toBe(1);
    expect(store.begins).toBe(1);
    expect(result.remoteSha).toBe(CANDIDATE);
    expect(result.effect.status).toBe("confirmed");
    expect(store.observations.map((item) => item.outcome)).toEqual([
      "not_applied",
      "confirmed",
    ]);
  });

  it("reconciles a crash-after-push without blindly issuing a duplicate push", async () => {
    const store = new FakeEffectStore();
    const adapter = new FakeGitHubEffects();
    const seeded = store.intendAsfEffect({
      ...fence,
      operation: "branch.push",
      target: `${REPOSITORY}#${HEAD_REF}`,
      correlationMarker: MARKER,
    });
    store.effects.set(seeded.effectKey, { ...seeded, status: "in_flight" });
    adapter.branchObservations.push(presentBranch());

    await controller(store, adapter).ensureBranch(branchInput());

    expect(adapter.pushes).toBe(0);
    expect(store.begins).toBe(0);
    expect(store.getAsfEffect(seeded.effectKey)?.status).toBe("confirmed");
  });

  it("retries only after exact absence proves an in-flight push did not land", async () => {
    const store = new FakeEffectStore();
    const adapter = new FakeGitHubEffects();
    const seeded = store.intendAsfEffect({
      ...fence,
      operation: "branch.push",
      target: `${REPOSITORY}#${HEAD_REF}`,
      correlationMarker: MARKER,
    });
    store.effects.set(seeded.effectKey, { ...seeded, status: "in_flight" });
    adapter.branchObservations.push(absentBranch(), presentBranch());

    await controller(store, adapter).ensureBranch(branchInput());

    expect(adapter.pushes).toBe(1);
    expect(store.begins).toBe(1);
  });

  it("keeps unknown or conflicting branch state ambiguous and never overwrites", async () => {
    for (const observation of [unknownBranch(), presentBranch(OTHER_SHA)]) {
      const store = new FakeEffectStore();
      const adapter = new FakeGitHubEffects();
      adapter.branchObservations.push(observation);

      await expect(controller(store, adapter).ensureBranch(branchInput())).rejects.toBeInstanceOf(
        RunmillError,
      );
      expect(adapter.pushes).toBe(0);
      expect([...store.effects.values()][0]?.status).toBe("ambiguous");
    }
  });

  it("updates a branch only from the exact authorized predecessor using force-with-lease", async () => {
    const store = new FakeEffectStore();
    const adapter = new FakeGitHubEffects();
    adapter.branchObservations.push(presentBranch(OTHER_SHA), presentBranch());

    await controller(store, adapter).ensureBranch({
      ...branchInput(),
      expectedRemoteSha: OTHER_SHA,
    });

    expect(adapter.pushes).toBe(1);
    expect(store.observations.map((item) => item.outcome)).toEqual([
      "not_applied",
      "confirmed",
    ]);
  });

  it("reconciles an applied PR after its creation response is lost", async () => {
    const store = new FakeEffectStore();
    const adapter = new FakeGitHubEffects();
    adapter.throwAfterCreate = true;
    adapter.pullRequestObservations.push(absentPullRequest(), presentPullRequests());

    const result = await controller(store, adapter).ensurePullRequest(pullRequestInput());

    expect(adapter.creates).toBe(1);
    expect(result.pullRequest).toMatchObject({ number: 42, head_sha: CANDIDATE });
    expect(result.effect.status).toBe("confirmed");
  });

  it("adopts exactly one marked existing PR without creating another", async () => {
    const store = new FakeEffectStore();
    const adapter = new FakeGitHubEffects();
    adapter.pullRequestObservations.push(presentPullRequests());

    await controller(store, adapter).ensurePullRequest(pullRequestInput());

    expect(adapter.creates).toBe(0);
    expect(store.begins).toBe(0);
  });

  it("refuses a stale candidate, mismatched marker, or duplicate PR observation", async () => {
    const observations = [
      presentPullRequests({ head_sha: OTHER_SHA }),
      presentPullRequests({ marker: "runmill:v1:other-run" }),
      {
        ...presentPullRequests(),
        pull_requests: [
          ...presentPullRequests().pull_requests,
          { ...presentPullRequests().pull_requests[0], number: 43 },
        ],
      },
    ];
    for (const observation of observations) {
      const store = new FakeEffectStore();
      const adapter = new FakeGitHubEffects();
      adapter.pullRequestObservations.push(observation);
      await expect(
        controller(store, adapter).ensurePullRequest(pullRequestInput()),
      ).rejects.toBeInstanceOf(RunmillError);
      expect(adapter.creates).toBe(0);
      expect([...store.effects.values()][0]?.status).toBe("ambiguous");
    }
  });

  it("double-reads and binds the exact final PR collision, base, and protection state", async () => {
    const store = new FakeEffectStore();
    const adapter = new FakeGitHubEffects();
    adapter.pullRequestObservations.push(presentPullRequests(), presentPullRequests());
    adapter.baseProtectionObservations.push(
      presentBaseProtection(),
      presentBaseProtection(),
    );

    const observed = await controller(store, adapter).observeFinalDelivery(finalDeliveryInput());

    expect(observed).toMatchObject({
      repository: REPOSITORY,
      pull_request_number: 42,
      head_ref: HEAD_REF,
      base_ref: BASE_REF,
      marker: MARKER,
      head_sha: CANDIDATE,
      current_base_sha: OTHER_SHA,
      protection_digest: PROTECTION_DIGEST,
      observed_at: "2026-08-21T10:00:02.000Z",
    });
    expect(store.effects.size).toBe(0);
  });

  it("refuses a protection digest/body contradiction and protection changing across reads", async () => {
    const contradictory = presentBaseProtection({
      protection: {
        ...PROTECTION,
        required_checks: ["ci/other"],
      },
      protection_digest: PROTECTION_DIGEST,
    });
    const changedProtection = {
      ...PROTECTION,
      requires_approval: true,
    };
    const changedDigest = sha256Digest({
      schema: "runmill.github-base-protection/v1",
      repository: REPOSITORY,
      base_ref: BASE_REF,
      protection: changedProtection,
    });
    for (const baseObservations of [
      [contradictory, contradictory],
      [
        presentBaseProtection(),
        presentBaseProtection({
          protection: { ...changedProtection, required_checks: ["ci/unit"] },
          protection_digest: changedDigest,
        }),
      ],
    ]) {
      const store = new FakeEffectStore();
      const adapter = new FakeGitHubEffects();
      adapter.pullRequestObservations.push(presentPullRequests(), presentPullRequests());
      adapter.baseProtectionObservations.push(...baseObservations);

      await expect(
        controller(store, adapter).observeFinalDelivery(finalDeliveryInput()),
      ).rejects.toBeInstanceOf(RunmillError);
    }
  });

  it("startup reconciliation observes pending effects without issuing mutations", async () => {
    const store = new FakeEffectStore();
    const adapter = new FakeGitHubEffects();
    store.intendAsfEffect({
      ...fence,
      operation: "branch.push",
      target: `${REPOSITORY}#${HEAD_REF}`,
      correlationMarker: MARKER,
    });
    adapter.branchObservations.push(presentBranch());

    const reconciled = await controller(store, adapter).reconcilePending({
      runId: fence.runId,
      ownerId: fence.ownerId,
      generation: fence.generation,
    });

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.status).toBe("confirmed");
    expect(adapter.pushes).toBe(0);
    expect(adapter.creates).toBe(0);
  });
});
