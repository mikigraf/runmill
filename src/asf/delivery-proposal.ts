import { canonicalJson, sha256Digest, type JsonValue } from "./canonical-json.js";
import type {
  AsfDeliveryBinding,
  AsfDeliveryProposalController,
} from "./delivery-runner.js";

export const ASF_PULL_REQUEST_DELIVERY_PROPOSAL_SCHEMA =
  "asf.pull-request-delivery-proposal/v1" as const;
export const ASF_PULL_REQUEST_MARKER_SCHEMA = "runmill.asf-pull-request-marker/v1" as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const POLICY_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/u;
const BRANCH_REF = /^refs\/heads\/[A-Za-z0-9._/-]+$/u;

function refuse(detail: string): never {
  throw new Error(`ASF delivery proposal refused: ${detail}`);
}

function assertBinding(binding: AsfDeliveryBinding): void {
  if (
    !IDENTIFIER.test(binding.runId) ||
    !IDENTIFIER.test(binding.workOrderId) ||
    !IDENTIFIER.test(binding.attemptId) ||
    !POLICY_DIGEST.test(binding.policyDigest) ||
    !Number.isSafeInteger(binding.fencingGeneration) ||
    binding.fencingGeneration < 1 ||
    binding.candidateSha === null ||
    !GIT_SHA.test(binding.candidateSha)
  ) {
    refuse("the exact run, attempt, policy, candidate, or fence binding is malformed");
  }
}

function publicBinding(binding: AsfDeliveryBinding) {
  return Object.freeze({
    run_id: binding.runId,
    work_order_id: binding.workOrderId,
    attempt_id: binding.attemptId,
    policy_digest: binding.policyDigest,
    fencing_generation: binding.fencingGeneration,
    candidate_sha: binding.candidateSha,
  });
}

/**
 * Deterministic, side-effect-free PR proposal authority.
 *
 * The branch and correlation marker deliberately exclude the ownership
 * generation and candidate SHA: a takeover or fixer candidate must reconcile
 * the same run-scoped branch and PR. The signed proposal itself remains bound
 * to the current candidate, policy, and generation.
 */
export class DeterministicAsfDeliveryProposalController
  implements AsfDeliveryProposalController
{
  async propose(input: Parameters<AsfDeliveryProposalController["propose"]>[0]) {
    if (input.signal.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("ASF delivery proposal was cancelled");
    }
    assertBinding(input.binding);
    if (!REPOSITORY.test(input.repository) || !BRANCH_REF.test(input.baseRef)) {
      return refuse("the repository or base ref is malformed");
    }

    const stableIdentity = {
      schema: ASF_PULL_REQUEST_MARKER_SCHEMA,
      run_id: input.binding.runId,
      work_order_id: input.binding.workOrderId,
      attempt_id: input.binding.attemptId,
      repository: input.repository.toLowerCase(),
      base_ref: input.baseRef,
    } as const;
    const stableDigest = sha256Digest(stableIdentity);
    const suffix = stableDigest.slice("sha256:".length, "sha256:".length + 32);
    const marker = `runmill-asf-${suffix}`;
    const headRef = `refs/heads/runmill/asf/${suffix}`;
    const markerBody = {
      ...stableIdentity,
      marker,
      policy_digest: input.binding.policyDigest,
      candidate_sha: input.binding.candidateSha,
    } as const;
    const body =
      "Automated candidate delivery by Runmill ASF.\n\n" +
      `<!-- runmill-asf:${canonicalJson(markerBody)} -->`;
    const unsigned = {
      schema: ASF_PULL_REQUEST_DELIVERY_PROPOSAL_SCHEMA,
      binding: publicBinding(input.binding),
      repository: input.repository.toLowerCase(),
      head_ref: headRef,
      base_ref: input.baseRef,
      marker,
      title: `Runmill ASF delivery ${input.binding.workOrderId}`,
      body,
      draft: input.draft,
    } as const;
    if (input.signal.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("ASF delivery proposal was cancelled");
    }
    return Object.freeze({
      ...unsigned,
      proposal_digest: sha256Digest(unsigned as unknown as JsonValue),
    });
  }
}
