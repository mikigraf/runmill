import { z } from "zod";
import type { AsfControlRequest } from "../daemon/control.js";
import { RunmillError } from "../errors/runmill-error.js";
import type { AsfWorkerService } from "./service.js";

export const ASF_CONTROL_ERROR_SCHEMA = "asf.control-error/v1" as const;

const retryDispositionSchema = z.enum([
  "safe",
  "reconcile-first",
  "new-attempt-required",
  "prohibited",
]);
const requiredActorSchema = z.enum([
  "asf",
  "repository-owner",
  "platform-operator",
  "security",
  "provider-administrator",
]);
const fixSchema = z
  .object({
    description: z.string().min(1),
    command: z.string().min(1).optional(),
  })
  .strict();

/** Versioned, public-safe failure details returned only for ASF requests. */
export const asfControlErrorSchema = z
  .object({
    schema: z.literal(ASF_CONTROL_ERROR_SCHEMA),
    code: z.string().min(1),
    title: z.string().min(1),
    what_happened: z.string().min(1),
    why: z.string().min(1),
    fixes: z.array(fixSchema),
    docs_url: z.string().min(1),
    recoverable: z.boolean(),
    run_id: z.string().min(1).nullable(),
    checkpoint: z.string().min(1).nullable(),
    retry_disposition: retryDispositionSchema.nullable(),
    required_actor: requiredActorSchema.nullable(),
    required_action: z.string().min(1).nullable(),
    evidence_refs: z.array(z.string().min(1).max(1_024)),
  })
  .strict();

export type AsfControlError = z.infer<typeof asfControlErrorSchema>;
export type AsfRetryDisposition = z.infer<typeof retryDispositionSchema>;
export type AsfRequiredActor = z.infer<typeof requiredActorSchema>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function metadataValue(
  error: RunmillError,
  camelCase: string,
  snakeCase: string,
): unknown {
  const errorRecord = asRecord(error);
  const direct = errorRecord?.[camelCase] ?? errorRecord?.[snakeCase];
  if (direct !== undefined) return direct;
  const cause = asRecord(error.cause);
  return cause?.[camelCase] ?? cause?.[snakeCase];
}

function optionalMetadata<T>(
  error: RunmillError,
  camelCase: string,
  snakeCase: string,
  schema: z.ZodType<T>,
): T | null {
  const parsed = schema.safeParse(metadataValue(error, camelCase, snakeCase));
  return parsed.success ? parsed.data : null;
}

/**
 * Convert a catalogued error to the stable ASF wire contract.
 *
 * Retry disposition and escalation ownership are deliberately not inferred
 * from a broad `recoverable` boolean. When a failure supplies those stronger
 * fields directly (or on its cause), preserve them; otherwise leave them null.
 */
export function serializeAsfControlError(error: unknown): AsfControlError | undefined {
  if (!(error instanceof RunmillError)) return undefined;

  const requiredAction = optionalMetadata(
    error,
    "requiredAction",
    "required_action",
    z.string().min(1),
  );
  const evidenceRefs = optionalMetadata(
    error,
    "evidenceRefs",
    "evidence_refs",
    z.array(z.string().min(1).max(1_024)),
  );

  return {
    schema: ASF_CONTROL_ERROR_SCHEMA,
    code: error.code,
    title: error.title,
    what_happened: error.whatHappened,
    why: error.why,
    fixes: error.fixes.map((fix) =>
      fix.command === undefined
        ? { description: fix.description }
        : { description: fix.description, command: fix.command },
    ),
    docs_url: error.docsUrl,
    recoverable: error.recoverable,
    run_id: error.runId ?? null,
    checkpoint: error.resumeFrom ?? null,
    retry_disposition: optionalMetadata(
      error,
      "retryDisposition",
      "retry_disposition",
      retryDispositionSchema,
    ),
    required_actor: optionalMetadata(
      error,
      "requiredActor",
      "required_actor",
      requiredActorSchema,
    ),
    required_action: requiredAction ?? error.fixes[0]?.description ?? null,
    evidence_refs: evidenceRefs ?? [],
  };
}

/** A remote ASF failure that remains catchable as the normal RunmillError. */
export class RemoteAsfControlError extends RunmillError {
  readonly retryDisposition: AsfRetryDisposition | null;
  readonly requiredActor: AsfRequiredActor | null;
  readonly requiredAction: string | null;
  readonly evidenceRefs: readonly string[];

  constructor(error: AsfControlError) {
    super({
      code: error.code,
      title: error.title,
      whatHappened: error.what_happened,
      why: error.why,
      fixes: error.fixes,
      recoverable: error.recoverable,
      ...(error.run_id === null ? {} : { runId: error.run_id }),
      ...(error.checkpoint === null ? {} : { resumeFrom: error.checkpoint }),
    });
    this.retryDisposition = error.retry_disposition;
    this.requiredActor = error.required_actor;
    this.requiredAction = error.required_action;
    this.evidenceRefs = error.evidence_refs;
  }
}

/** Validate an untrusted daemon response before recreating its typed error. */
export function deserializeAsfControlError(raw: unknown): RemoteAsfControlError {
  const parsed = asfControlErrorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "invalid ASF control error response: " +
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; "),
    );
  }
  return new RemoteAsfControlError(parsed.data);
}

export type AsfControlService = Pick<
  AsfWorkerService,
  | "submitWorkOrder"
  | "getRun"
  | "listRunEvents"
  | "getEvidence"
  | "requestCancellation"
  | "recordApproval"
  | "requestReconciliation"
  | "acknowledgeOutcome"
  | "health"
>;

/**
 * Bounded private-protocol adapter for the durable worker service.
 *
 * This deliberately has no arbitrary command, shell, provider credential,
 * GitHub request, or merge dispatch. Those remain orchestrator-owned actions.
 */
export async function handleAsfControlRequest(
  service: AsfControlService,
  request: AsfControlRequest,
): Promise<unknown> {
  switch (request.type) {
    case "asf.submit_work_order":
      return service.submitWorkOrder(request.envelope);
    case "asf.get_run":
      return service.getRun(request.runId);
    case "asf.list_run_events":
      return service.listRunEvents(request.runId, request.after ?? 0, request.limit ?? 100);
    case "asf.get_evidence":
      return service.getEvidence(request.runId);
    case "asf.request_cancel":
      return service.requestCancellation(request.request);
    case "asf.record_approval":
      return service.recordApproval(request.envelope);
    case "asf.reconcile_run":
      return service.requestReconciliation(request.request);
    case "asf.acknowledge_outcome":
      return service.acknowledgeOutcome(request.acknowledgement);
    case "asf.health":
      return service.health();
  }
}
