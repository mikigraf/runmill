import { RunmillError } from "../errors/runmill-error.js";
import type {
  AsfDurableRunSnapshot,
  AsfEvidenceBundleRecord,
  AsfTerminalEvidenceBundleRecord,
  AsfEventPage,
  StateStore,
} from "../state/store.js";
import type { SignedAsfEvidenceBundle } from "../evidence/asf-bundle.js";
import type { SignedAsfTerminalEvidenceBundle } from "../evidence/asf-terminal.js";
import { isTerminalRunEventPhase, type RunEvent } from "./run-event.js";

export const ASF_EVIDENCE_VIEW_SCHEMA = "asf.evidence-view/v1" as const;

export interface PublicAsfArtifactReference {
  readonly artifactId: string;
  readonly kind: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly retentionClass: "portable" | "protected" | "restricted";
  readonly locationRef: string;
}

export interface AsfEvidenceView {
  readonly schema: typeof ASF_EVIDENCE_VIEW_SCHEMA;
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly phase: string;
  readonly candidateSha: string | null;
  readonly policyDigest: string;
  readonly latestSequence: number;
  readonly status: "current" | "stopped" | "finalizing" | "final";
  readonly complete: boolean;
  readonly bundleDigest: string | null;
  readonly terminalBundleDigest: string | null;
  readonly artifacts: readonly PublicAsfArtifactReference[];
  readonly latestEvent: RunEvent | null;
  readonly signedBundle: SignedAsfEvidenceBundle | null;
  readonly signedTerminalBundle: SignedAsfTerminalEvidenceBundle | null;
}

export type AsfEvidenceReadStore = Pick<
  StateStore,
  | "getAsfRunSnapshot"
  | "getAsfEvidenceBundleRecord"
  | "getAsfEvidenceBundle"
  | "getAsfTerminalEvidenceBundleRecord"
  | "getAsfTerminalEvidenceBundle"
  | "getLatestAsfCheckpoint"
  | "listAsfRunEvents"
>;

function evidenceError(runId: string, whatHappened: string): RunmillError {
  return RunmillError.fromCatalog("RM-EVID-008", { whatHappened, runId });
}

function latestEvent(
  store: AsfEvidenceReadStore,
  snapshot: AsfDurableRunSnapshot,
): RunEvent | null {
  if (snapshot.latestSequence < 1) return null;
  const page: AsfEventPage = store.listAsfRunEvents(
    snapshot.run.runId,
    snapshot.latestSequence - 1,
    1,
  );
  const event = page.events[0];
  if (event === undefined || event.seq !== snapshot.latestSequence) {
    // A compaction boundary may omit detail. The durable snapshot remains
    // useful, but a mismatched event can never be presented as current.
    return null;
  }
  return event;
}

function assertBundleBindings(
  snapshot: AsfDurableRunSnapshot,
  record: AsfEvidenceBundleRecord,
  bundle: SignedAsfEvidenceBundle,
): void {
  const { predicate } = bundle.statement;
  if (
    record.runId !== snapshot.run.runId ||
    record.bundleDigest !== bundle.bundle_digest ||
    record.candidateSha !== snapshot.run.candidateSha ||
    record.policyDigest !== snapshot.admission.effectivePolicyDigest ||
    predicate.run.run_id !== snapshot.run.runId ||
    predicate.run.work_order_id !== snapshot.admission.workOrderId ||
    predicate.run.attempt_id !== snapshot.admission.attemptId ||
    predicate.source.candidate_sha !== snapshot.run.candidateSha ||
    predicate.source.remote_head_sha !== snapshot.run.candidateSha ||
    predicate.policy.effective_policy_digest !== snapshot.admission.effectivePolicyDigest ||
    predicate.work_order.payload_digest !== snapshot.admission.payloadDigest ||
    predicate.work_order.envelope_digest !== snapshot.admission.envelopeDigest
  ) {
    throw evidenceError(
      snapshot.run.runId,
      "stored evidence is missing or contradicts the current Work Order, candidate, policy, or remote head",
    );
  }
}

function assertTerminalBundleBindings(
  snapshot: AsfDurableRunSnapshot,
  record: AsfTerminalEvidenceBundleRecord,
  bundle: SignedAsfTerminalEvidenceBundle,
  event: RunEvent | null,
  checkpoint: ReturnType<AsfEvidenceReadStore["getLatestAsfCheckpoint"]>,
): void {
  const predicate = bundle.statement.predicate;
  const isTerminal = isTerminalRunEventPhase(snapshot.run.state);
  if (
    record.runId !== snapshot.run.runId ||
    record.bundleDigest !== bundle.bundle_digest ||
    record.candidateSha !== snapshot.run.candidateSha ||
    record.policyDigest !== snapshot.admission.effectivePolicyDigest ||
    record.terminalPhase !== predicate.run.terminal_phase ||
    record.terminalEventSeq !== predicate.run.terminal_event_seq ||
    record.cleanupDigest !== predicate.cleanup.observation_digest ||
    record.deliveryBundleDigest !== predicate.evidence.delivery_bundle_digest ||
    predicate.run.run_id !== snapshot.run.runId ||
    predicate.run.work_order_id !== snapshot.admission.workOrderId ||
    predicate.run.attempt_id !== snapshot.admission.attemptId ||
    predicate.admission.work_order_payload_digest !== snapshot.admission.payloadDigest ||
    predicate.admission.work_order_envelope_digest !== snapshot.admission.envelopeDigest ||
    predicate.admission.effective_policy_digest !== snapshot.admission.effectivePolicyDigest ||
    predicate.source.repository !== snapshot.run.repo.toLowerCase() ||
    predicate.source.base_sha !== snapshot.run.baseCommit ||
    predicate.source.candidate_sha !== snapshot.run.candidateSha ||
    predicate.evidence.preceding_event_count + 1 !== record.terminalEventSeq ||
    (isTerminal
      ? record.terminalPhase !== snapshot.run.state ||
        record.terminalEventSeq !== snapshot.latestSequence ||
        event === null ||
        event.seq !== record.terminalEventSeq ||
        event.phase !== record.terminalPhase ||
        event.payload["terminal_evidence_bundle_digest"] !== record.bundleDigest ||
        checkpoint === undefined ||
        checkpoint.checkpoint_kind !== "lease-release-workspace-cleanup" ||
        checkpoint.run_id !== snapshot.run.runId ||
        checkpoint.phase !== snapshot.run.state ||
        checkpoint.event_seq !== snapshot.latestSequence ||
        checkpoint.candidate_sha !== snapshot.run.candidateSha ||
        checkpoint.policy_digest !== snapshot.admission.effectivePolicyDigest
      : record.terminalEventSeq !== snapshot.latestSequence + 1)
  ) {
    throw evidenceError(
      snapshot.run.runId,
      "stored terminal evidence is missing or contradicts the actual terminal event and cleanup checkpoint",
    );
  }
}

/** Public-safe read model for current progress or the immutable final bundle. */
export class AsfEvidenceReadService {
  readonly #store: AsfEvidenceReadStore;

  constructor(store: AsfEvidenceReadStore) {
    this.#store = store;
  }

  getEvidence(runId: string): AsfEvidenceView {
    const snapshot = this.#store.getAsfRunSnapshot(runId);
    if (snapshot === undefined) {
      throw evidenceError(runId, `ASF run ${JSON.stringify(runId)} does not exist`);
    }
    const record = this.#store.getAsfEvidenceBundleRecord(runId);
    const terminalRecord = this.#store.getAsfTerminalEvidenceBundleRecord(runId);
    const actualLatestEvent = latestEvent(this.#store, snapshot);
    const terminal = isTerminalRunEventPhase(snapshot.run.state);
    const legacyDeliveryFinalizing = snapshot.run.state === "EVIDENCE_FINALIZED";
    const legacyCompleted = snapshot.run.state === "COMPLETED" && terminalRecord === undefined;
    if (record === undefined) {
      if (snapshot.run.state === "EVIDENCE_FINALIZED" || snapshot.run.state === "COMPLETED") {
        throw evidenceError(
          runId,
          `run ${runId} claims ${snapshot.run.state} without immutable signed evidence`,
        );
      }
      if (terminal && terminalRecord === undefined) {
        throw evidenceError(
          runId,
          `terminal run ${runId} has no immutable signed post-cleanup evidence`,
        );
      }
    }

    const bundle = record === undefined ? undefined : this.#store.getAsfEvidenceBundle(runId);
    if (record !== undefined && bundle === undefined) {
      throw evidenceError(runId, `evidence record ${record.bundleDigest} has no signed bundle`);
    }
    if (record !== undefined && bundle !== undefined) {
      assertBundleBindings(snapshot, record, bundle);
    }

    const terminalBundle =
      terminalRecord === undefined
        ? undefined
        : this.#store.getAsfTerminalEvidenceBundle(runId);
    if (terminalRecord !== undefined && terminalBundle === undefined) {
      throw evidenceError(
        runId,
        `terminal evidence record ${terminalRecord.bundleDigest} has no signed bundle`,
      );
    }
    if (terminalRecord !== undefined && terminalBundle !== undefined) {
      assertTerminalBundleBindings(
        snapshot,
        terminalRecord,
        terminalBundle,
        actualLatestEvent,
        this.#store.getLatestAsfCheckpoint(runId),
      );
    }

    if (legacyCompleted) {
      const checkpoint = this.#store.getLatestAsfCheckpoint(runId);
      if (
        actualLatestEvent === null ||
        checkpoint === undefined ||
        checkpoint.checkpoint_kind !== "lease-release-workspace-cleanup" ||
        checkpoint.phase !== "COMPLETED" ||
        checkpoint.event_seq !== snapshot.latestSequence
      ) {
        throw evidenceError(
          runId,
          "legacy completed evidence has no matching terminal event and cleanup checkpoint",
        );
      }
    }

    const complete = terminal && (terminalRecord !== undefined || legacyCompleted);
    const status: AsfEvidenceView["status"] = terminal
      ? snapshot.run.state === "COMPLETED"
        ? "final"
        : "stopped"
      : record !== undefined || terminalRecord !== undefined || legacyDeliveryFinalizing
        ? "finalizing"
        : "current";
    return {
        schema: ASF_EVIDENCE_VIEW_SCHEMA,
        runId,
        workOrderId: snapshot.admission.workOrderId,
        attemptId: snapshot.admission.attemptId,
        phase: snapshot.run.state,
        candidateSha: snapshot.run.candidateSha,
        policyDigest: snapshot.admission.effectivePolicyDigest,
        latestSequence: snapshot.latestSequence,
        status,
        complete,
        bundleDigest: record?.bundleDigest ?? null,
        terminalBundleDigest: terminalRecord?.bundleDigest ?? null,
        artifacts: (bundle?.statement.predicate.artifacts ?? []).map((artifact) => ({
        artifactId: artifact.artifact_id,
        kind: artifact.kind,
        digest: artifact.digest,
        sizeBytes: artifact.size_bytes,
        mediaType: artifact.media_type,
        retentionClass: artifact.retention_class,
        locationRef: artifact.location_ref,
      })),
        latestEvent: actualLatestEvent,
        signedBundle: bundle ?? null,
        signedTerminalBundle: terminalBundle ?? null,
    };
  }
}
