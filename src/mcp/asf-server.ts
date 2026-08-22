import type { Readable, Writable } from "node:stream";
import { once } from "node:events";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { serializeAsfControlError } from "../asf/control.js";
import {
  isTerminalRunEventPhase,
  parseRunEvent,
  runEventPhaseSchema,
  runEventSchema,
} from "../asf/run-event.js";
import { workOrderEnvelopeSchema } from "../asf/work-order.js";
import { cancellationRequestSchema } from "../asf/cancellation.js";
import { approvalEnvelopeSchema } from "../asf/approval.js";
import { outcomeAcknowledgementSchema } from "../asf/outcome.js";
import { reconciliationRequestSchema } from "../asf/reconciliation.js";
import { asfHealthReportSchema } from "../asf/health.js";
import { signedAsfEvidenceBundleSchema } from "../evidence/asf-bundle.js";
import { signedAsfTerminalEvidenceBundleSchema } from "../evidence/asf-terminal.js";
import { sha256Digest } from "../asf/canonical-json.js";
import type { AsfControlAuthenticationProvider } from "../asf/control-auth.js";
import { ERROR_CATALOG } from "../errors/runmill-error.js";
import {
  asfDaemonRuntimePaths,
  requestDaemon,
  type AsfControlRequest,
} from "../daemon/control.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25" as const;
export const RUNMILL_MCP_ERROR_SCHEMA = "runmill.mcp-tool-error/v1" as const;
export const MAX_MCP_MESSAGE_BYTES = 2 * 1024 * 1024;
export const ASF_MCP_CONTROL_TIMEOUT_MS = 5_000;
const MAX_PUBLIC_VALIDATION_ISSUES = 32;

export type AsfDaemonControlClient = (request: AsfControlRequest) => Promise<unknown>;

export interface AsfMcpServerOptions {
  readonly controlClient?: AsfDaemonControlClient | undefined;
  readonly controlAuthentication?: AsfControlAuthenticationProvider | undefined;
  /** Defaults to the ASF-only registry, never the standalone daemon registry. */
  readonly registryPath?: string | undefined;
}

export interface McpNdjsonTransport {
  readonly incoming: AsyncIterable<string | Uint8Array>;
  send(line: string): Promise<void> | void;
}

type JsonRpcId = string | number;

export interface JsonRpcSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

interface McpToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly structuredContent: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
}

const identifierSchema = z.string().min(1).max(1_024);
const digestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, "must be a tagged lower-case SHA-256 digest");
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const catalogErrorCodeSchema = z
  .string()
  .max(64)
  .regex(/^RM-[A-Z0-9]+-[0-9]{3}$/u);
const publicMcpErrorCodeSchema = z.union([
  catalogErrorCodeSchema,
  z.enum(["invalid_service_response", "service_request_failed", "invalid_tool_arguments"]),
]);

const asfRunRowSchema = z
  .object({
    runId: identifierSchema,
    issueId: identifierSchema,
    repo: identifierSchema,
    provider: identifierSchema,
    state: runEventPhaseSchema,
    stateVersion: z.number().int().positive(),
    attempt: z.number().int().positive(),
    baseCommit: gitShaSchema,
    candidateSha: gitShaSchema.nullable(),
    branch: z.string().min(1).nullable(),
    mode: z.literal("asf-worker"),
    workOrderId: identifierSchema,
    attemptId: identifierSchema,
    generation: z.number().int().nonnegative(),
    ownerId: z.string().min(1).nullable(),
    heartbeatAt: timestampSchema.nullable(),
  })
  .strict();

const safeAdmissionSchema = z
  .object({
    idempotencyKey: identifierSchema,
    workOrderId: identifierSchema,
    attemptId: identifierSchema,
    tenantId: identifierSchema,
    payloadDigest: digestSchema,
    envelopeDigest: digestSchema,
    effectivePolicyDigest: digestSchema,
    signatureKeyId: identifierSchema,
    signatureAlgorithm: z.literal("EdDSA"),
    acceptedAt: timestampSchema,
  })
  .strict();

const submitDaemonResultSchema = z
  .object({
    runId: identifierSchema,
    disposition: z.enum(["accepted", "existing"]),
    payloadDigest: digestSchema,
  })
  .strict();

const getRunDaemonResultSchema = z
  .object({
    run: asfRunRowSchema,
    admission: safeAdmissionSchema,
    latestSequence: z.number().int().nonnegative(),
  })
  .strict();

const eventPageDaemonResultSchema = z
  .object({
    events: z.array(runEventSchema).max(1_000),
    nextCursor: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    gap: z.boolean(),
    compactedThrough: z.number().int().nonnegative().nullable(),
    snapshot: z
      .object({
        run: asfRunRowSchema,
        latestSequence: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const submitArgumentsSchema = z
  .object({ envelope: workOrderEnvelopeSchema })
  .strict();
const getRunArgumentsSchema = z.object({ run_id: identifierSchema }).strict();
const listRunEventsArgumentsSchema = z
  .object({
    run_id: identifierSchema,
    cursor: z.string().min(1).max(4_096).optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();
const getEvidenceArgumentsSchema = getRunArgumentsSchema;
const requestCancelArgumentsSchema = z
  .object({ request: cancellationRequestSchema })
  .strict();
const recordApprovalArgumentsSchema = z
  .object({ envelope: approvalEnvelopeSchema })
  .strict();
const reconcileRunArgumentsSchema = z
  .object({ request: reconciliationRequestSchema })
  .strict();
const acknowledgeOutcomeArgumentsSchema = z
  .object({ acknowledgement: outcomeAcknowledgementSchema })
  .strict();
const healthArgumentsSchema = z.object({}).strict();

const publicSubmitResultSchema = z
  .object({
    run_id: identifierSchema,
    disposition: z.enum(["accepted", "existing"]),
    payload_digest: digestSchema,
  })
  .strict();

const outcomeSchema = z
  .enum(["completed", "cancelled", "failed", "refused", "quarantined", "budget_exhausted"])
  .nullable();

const publicRunCursorSnapshotSchema = z
  .object({
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    repository: identifierSchema,
    state: runEventPhaseSchema,
    outcome: outcomeSchema,
    state_version: z.number().int().positive(),
    generation: z.number().int().nonnegative(),
    base_commit: gitShaSchema,
    candidate_sha: gitShaSchema.nullable(),
    branch: z.string().min(1).nullable(),
    latest_sequence: z.number().int().nonnegative(),
  })
  .strict();

const publicAdmissionSchema = z
  .object({
    idempotency_key: identifierSchema,
    tenant_id: identifierSchema,
    payload_digest: digestSchema,
    envelope_digest: digestSchema,
    effective_policy_digest: digestSchema,
    signature_key_id: identifierSchema,
    signature_algorithm: z.literal("EdDSA"),
    accepted_at: timestampSchema,
  })
  .strict();

const publicGetRunResultSchema = publicRunCursorSnapshotSchema
  .extend({ admission: publicAdmissionSchema })
  .strict();

const publicEventPageResultSchema = z
  .object({
    events: z.array(runEventSchema),
    next_cursor: z.string().min(1),
    has_more: z.boolean(),
    gap: z.boolean(),
    compacted_through_cursor: z.string().min(1).nullable(),
    snapshot: publicRunCursorSnapshotSchema,
  })
  .strict();

const daemonArtifactReferenceSchema = z
  .object({
    artifactId: identifierSchema,
    kind: identifierSchema,
    digest: digestSchema,
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.string().min(3).max(256),
    retentionClass: z.enum(["portable", "protected", "restricted"]),
    locationRef: z.string().regex(/^cas:\/\/sha256\/[a-f0-9]{64}$/u),
  })
  .strict();

const evidenceDaemonResultSchema = z
  .object({
    schema: z.literal("asf.evidence-view/v1"),
    runId: identifierSchema,
    workOrderId: identifierSchema,
    attemptId: identifierSchema,
    phase: runEventPhaseSchema,
    candidateSha: gitShaSchema.nullable(),
    policyDigest: digestSchema,
    latestSequence: z.number().int().positive(),
    status: z.enum(["current", "stopped", "finalizing", "final"]),
    complete: z.boolean(),
    bundleDigest: digestSchema.nullable(),
    terminalBundleDigest: digestSchema.nullable(),
    artifacts: z.array(daemonArtifactReferenceSchema).max(2_048),
    latestEvent: runEventSchema.nullable(),
    signedBundle: signedAsfEvidenceBundleSchema.nullable(),
    signedTerminalBundle: signedAsfTerminalEvidenceBundleSchema.nullable(),
  })
  .strict();

const publicEvidenceResultSchema = z
  .object({
    schema: z.literal("asf.evidence-view/v1"),
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    phase: runEventPhaseSchema,
    candidate_sha: gitShaSchema.nullable(),
    policy_digest: digestSchema,
    latest_sequence: z.number().int().positive(),
    status: z.enum(["current", "stopped", "finalizing", "final"]),
    complete: z.boolean(),
    bundle_digest: digestSchema.nullable(),
    terminal_bundle_digest: digestSchema.nullable(),
    artifacts: z
      .array(
        z
          .object({
            artifact_id: identifierSchema,
            kind: identifierSchema,
            digest: digestSchema,
            size_bytes: z.number().int().nonnegative(),
            media_type: z.string().min(3).max(256),
            retention_class: z.enum(["portable", "protected", "restricted"]),
            location_ref: z.string().regex(/^cas:\/\/sha256\/[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .max(2_048),
    latest_event: runEventSchema.nullable(),
    signed_bundle: signedAsfEvidenceBundleSchema.nullable(),
    signed_terminal_bundle: signedAsfTerminalEvidenceBundleSchema.nullable(),
  })
  .strict();

const cancellationDaemonResultSchema = z
  .object({
    requestId: identifierSchema,
    runId: identifierSchema,
    disposition: z.enum(["requested", "existing", "already-terminal"]),
    state: runEventPhaseSchema,
    generation: z.number().int().nonnegative(),
    requestDigest: digestSchema,
    reconciliationRequired: z.boolean(),
  })
  .strict();

const publicCancellationResultSchema = z
  .object({
    request_id: identifierSchema,
    run_id: identifierSchema,
    disposition: z.enum(["requested", "existing", "already-terminal"]),
    state: runEventPhaseSchema,
    generation: z.number().int().nonnegative(),
    request_digest: digestSchema,
    reconciliation_required: z.boolean(),
  })
  .strict();

const approvalDaemonResultSchema = z
  .object({
    approvalId: identifierSchema,
    runId: identifierSchema,
    decision: z.enum(["approved", "denied"]),
    disposition: z.enum(["recorded", "existing"]),
    envelopeDigest: digestSchema,
    resumed: z.boolean().optional(),
    resumePhase: runEventPhaseSchema.nullable().optional(),
  })
  .strict();

const publicApprovalResultSchema = z
  .object({
    approval_id: identifierSchema,
    run_id: identifierSchema,
    decision: z.enum(["approved", "denied"]),
    disposition: z.enum(["recorded", "existing"]),
    envelope_digest: digestSchema,
  })
  .strict();

const reconciliationDaemonResultSchema = z
  .object({
    operationId: identifierSchema,
    runId: identifierSchema,
    disposition: z.enum(["queued", "existing", "nothing-to-reconcile"]),
    status: z.enum(["queued", "running", "completed", "blocked"]),
    requestDigest: digestSchema,
    requestedAt: timestampSchema,
  })
  .strict();

const publicReconciliationResultSchema = z
  .object({
    operation_id: identifierSchema,
    run_id: identifierSchema,
    disposition: z.enum(["queued", "existing", "nothing-to-reconcile"]),
    status: z.enum(["queued", "running", "completed", "blocked"]),
    request_digest: digestSchema,
    requested_at: timestampSchema,
  })
  .strict();

const acknowledgementDaemonResultSchema = z
  .object({
    acknowledgementId: identifierSchema,
    runId: identifierSchema,
    bundleDigest: digestSchema,
    disposition: z.enum(["recorded", "existing"]),
    acknowledgedAt: timestampSchema,
  })
  .strict();

const publicAcknowledgementResultSchema = z
  .object({
    acknowledgement_id: identifierSchema,
    run_id: identifierSchema,
    bundle_digest: digestSchema,
    disposition: z.enum(["recorded", "existing"]),
    acknowledged_at: timestampSchema,
  })
  .strict();

const publicMcpToolErrorSchema = z
  .object({
    schema: z.literal(RUNMILL_MCP_ERROR_SCHEMA),
    code: publicMcpErrorCodeSchema,
    message: z.string().min(1),
    recoverable: z.boolean().optional(),
    run_id: identifierSchema.nullable().optional(),
    checkpoint: runEventPhaseSchema.nullable().optional(),
    retry_disposition: z
      .enum(["safe", "reconcile-first", "new-attempt-required", "prohibited"])
      .nullable()
      .optional(),
    required_actor: z
      .enum([
        "asf",
        "repository-owner",
        "platform-operator",
        "security",
        "provider-administrator",
      ])
      .nullable()
      .optional(),
    details: z
      .object({
        issues: z.array(
          z
            .object({
              path: z.string().min(1).max(512),
              code: z.string().min(1).max(64),
            })
            .strict(),
        ).max(MAX_PUBLIC_VALIDATION_ISSUES),
      })
      .strict()
      .optional(),
  })
  .strict();

interface McpToolDefinition {
  readonly name:
    | "runmill_submit_work_order"
    | "runmill_get_run"
    | "runmill_list_run_events"
    | "runmill_get_evidence"
    | "runmill_request_cancel"
    | "runmill_record_approval"
    | "runmill_reconcile_run"
    | "runmill_acknowledge_outcome"
    | "runmill_health";
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

function jsonSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  return z.toJSONSchema(schema);
}

function toolOutputJsonSchema(successSchema: z.ZodType): Readonly<Record<string, unknown>> {
  const success = { ...z.toJSONSchema(successSchema) };
  const error = { ...z.toJSONSchema(publicMcpToolErrorSchema) };
  const schema = success["$schema"] ?? error["$schema"];
  delete success["$schema"];
  delete error["$schema"];
  return {
    ...(schema === undefined ? {} : { $schema: schema }),
    type: "object",
    oneOf: [success, error],
  };
}

export const ASF_MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  {
    name: "runmill_submit_work_order",
    description:
      "Durably submit one signed ASF Work Order and return its run ID without waiting for execution.",
    inputSchema: jsonSchema(submitArgumentsSchema),
    outputSchema: toolOutputJsonSchema(publicSubmitResultSchema),
  },
  {
    name: "runmill_get_run",
    description: "Get the current safe snapshot and outcome of one durable ASF run.",
    inputSchema: jsonSchema(getRunArgumentsSchema),
    outputSchema: toolOutputJsonSchema(publicGetRunResultSchema),
  },
  {
    name: "runmill_list_run_events",
    description: "List durable public run events after an opaque run-bound cursor.",
    inputSchema: jsonSchema(listRunEventsArgumentsSchema),
    outputSchema: toolOutputJsonSchema(publicEventPageResultSchema),
  },
  {
    name: "runmill_get_evidence",
    description:
      "Return a public current evidence manifest or the exact immutable signed final bundle.",
    inputSchema: jsonSchema(getEvidenceArgumentsSchema),
    outputSchema: toolOutputJsonSchema(publicEvidenceResultSchema),
  },
  {
    name: "runmill_request_cancel",
    description: "Durably record and fence an idempotent authorized cancellation request.",
    inputSchema: jsonSchema(requestCancelArgumentsSchema),
    outputSchema: toolOutputJsonSchema(publicCancellationResultSchema),
  },
  {
    name: "runmill_record_approval",
    description: "Validate and durably record one signed candidate- and policy-bound decision.",
    inputSchema: jsonSchema(recordApprovalArgumentsSchema),
    outputSchema: toolOutputJsonSchema(publicApprovalResultSchema),
  },
  {
    name: "runmill_reconcile_run",
    description:
      "Queue bounded deterministic observation of recorded effects; never issue a blind retry.",
    inputSchema: jsonSchema(reconcileRunArgumentsSchema),
    outputSchema: toolOutputJsonSchema(publicReconciliationResultSchema),
  },
  {
    name: "runmill_acknowledge_outcome",
    description: "Record ASF receipt of one terminal run's exact immutable evidence bundle.",
    inputSchema: jsonSchema(acknowledgeOutcomeArgumentsSchema),
    outputSchema: toolOutputJsonSchema(publicAcknowledgementResultSchema),
  },
  {
    name: "runmill_health",
    description:
      "Report bounded fail-closed ASF service, database, worker, sandbox, identity, forge, MCP, and backlog readiness.",
    inputSchema: jsonSchema(healthArgumentsSchema),
    outputSchema: toolOutputJsonSchema(asfHealthReportSchema),
  },
]);

const jsonRpcMessageSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number().finite()]).optional(),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

const metaSchema = z.record(z.string(), z.unknown());
const implementationIconSchema = z
  .object({
    src: z.string().min(1),
    mimeType: z.string().min(1).optional(),
    sizes: z.array(z.string().min(1)).optional(),
    theme: z.enum(["light", "dark"]).optional(),
  })
  .strict();
const initializeParamsSchema = z
  .object({
    protocolVersion: z.string().min(1),
    capabilities: z.record(z.string(), z.unknown()),
    clientInfo: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        title: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        websiteUrl: z.string().min(1).optional(),
        icons: z.array(implementationIconSchema).optional(),
      })
      .strict(),
    _meta: metaSchema.optional(),
  })
  .strict();
const listToolsParamsSchema = z.object({ _meta: metaSchema.optional() }).strict();
const callToolParamsSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
    _meta: metaSchema.optional(),
  })
  .strict();
const initializedNotificationParamsSchema = z
  .object({ _meta: metaSchema.optional() })
  .strict();

const cursorPayloadSchema = z
  .object({
    v: z.literal(1),
    run_id: identifierSchema,
    after: z.number().int().nonnegative(),
  })
  .strict();
const CURSOR_PREFIX = "runmill-event-v1.";

function encodeCursor(runId: string, after: number): string {
  const payload = JSON.stringify({ v: 1, run_id: runId, after });
  return `${CURSOR_PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}`;
}

function decodeCursor(cursor: string, runId: string): number {
  if (!cursor.startsWith(CURSOR_PREFIX)) throw new Error("unsupported cursor version");
  const encoded = cursor.slice(CURSOR_PREFIX.length);
  if (encoded === "" || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error("malformed cursor encoding");
  }
  let raw: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error("non-canonical cursor");
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("malformed cursor payload");
  }
  const parsed = cursorPayloadSchema.safeParse(raw);
  if (!parsed.success) throw new Error("malformed cursor payload");
  if (parsed.data.run_id !== runId) throw new Error("cursor belongs to a different run");
  return parsed.data.after;
}

function issueData(error: z.ZodError): Readonly<Record<string, unknown>> {
  return {
    issues: error.issues.slice(0, MAX_PUBLIC_VALIDATION_ISSUES).map((issue) => ({
      path: (issue.path.join(".") || "<root>").slice(0, 512),
      code: issue.code,
    })),
  };
}

function success(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

function protocolError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function toolSuccess(value: Readonly<Record<string, unknown>>): McpToolResult {
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

class InvalidDaemonResultError extends Error {
  constructor(readonly issues: Readonly<Record<string, unknown>>) {
    super("the Runmill service returned an invalid response");
    this.name = "InvalidDaemonResultError";
  }
}

function parseDaemonResult<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new InvalidDaemonResultError(issueData(parsed.error));
  return parsed.data;
}

function parseDaemonRunEvent(raw: unknown, path: string) {
  try {
    return parseRunEvent(raw);
  } catch {
    throw new InvalidDaemonResultError({
      issues: [{ path, code: "invalid_run_event" }],
    });
  }
}

function toolFailure(error: unknown, expectedRunId?: string): McpToolResult {
  const asfError = serializeAsfControlError(error);
  const catalogCode = catalogErrorCodeSchema.safeParse(asfError?.code);
  if (
    asfError !== undefined &&
    catalogCode.success &&
    Object.hasOwn(ERROR_CATALOG, catalogCode.data)
  ) {
    const checkpoint = runEventPhaseSchema.safeParse(asfError.checkpoint);
    const structuredContent = publicMcpToolErrorSchema.parse({
      schema: RUNMILL_MCP_ERROR_SCHEMA,
      code: catalogCode.data,
      message: "Runmill service rejected the request.",
      recoverable: asfError.recoverable,
      run_id:
        expectedRunId !== undefined && asfError.run_id === expectedRunId
          ? expectedRunId
          : null,
      checkpoint: checkpoint.success ? checkpoint.data : null,
      retry_disposition: asfError.retry_disposition,
      required_actor: asfError.required_actor,
    });
    return {
      isError: true,
      content: [{ type: "text", text: `${asfError.code}: Runmill service rejected the request.` }],
      structuredContent,
    };
  }
  if (error instanceof InvalidDaemonResultError) {
    return {
      isError: true,
      content: [{ type: "text", text: "Runmill service returned an invalid response." }],
      structuredContent: publicMcpToolErrorSchema.parse({
        schema: RUNMILL_MCP_ERROR_SCHEMA,
        code: "invalid_service_response",
        message: "Runmill service returned an invalid response.",
        details: error.issues,
      }),
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: "Runmill service request failed." }],
    structuredContent: publicMcpToolErrorSchema.parse({
      schema: RUNMILL_MCP_ERROR_SCHEMA,
      code: "service_request_failed",
      message: "Runmill service request failed.",
    }),
  };
}

function invalidToolArguments(error?: z.ZodError): McpToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: "Invalid tool arguments." }],
    structuredContent: publicMcpToolErrorSchema.parse({
      schema: RUNMILL_MCP_ERROR_SCHEMA,
      code: "invalid_tool_arguments",
      message: "Invalid tool arguments.",
      ...(error === undefined ? {} : { details: issueData(error) }),
    }),
  };
}

type ParsedRunRow = z.infer<typeof asfRunRowSchema>;

function outcomeFor(state: z.infer<typeof runEventPhaseSchema>): z.infer<typeof outcomeSchema> {
  if (!isTerminalRunEventPhase(state)) return null;
  return state.toLowerCase() as z.infer<typeof outcomeSchema>;
}

function publicRunSnapshot(
  run: ParsedRunRow,
  latestSequence: number,
): z.infer<typeof publicRunCursorSnapshotSchema> {
  return publicRunCursorSnapshotSchema.parse({
    run_id: run.runId,
    work_order_id: run.workOrderId,
    attempt_id: run.attemptId,
    repository: run.repo,
    state: run.state,
    outcome: outcomeFor(run.state),
    state_version: run.stateVersion,
    generation: run.generation,
    base_commit: run.baseCommit,
    candidate_sha: run.candidateSha,
    branch: run.branch,
    latest_sequence: latestSequence,
  });
}

function assertRunBindings(
  requestedRunId: string,
  run: ParsedRunRow,
  workOrderId?: string,
  attemptId?: string,
): void {
  if (
    run.runId !== requestedRunId ||
    (workOrderId !== undefined && run.workOrderId !== workOrderId) ||
    (attemptId !== undefined && run.attemptId !== attemptId)
  ) {
    throw new InvalidDaemonResultError({ issues: [{ path: "run", code: "binding_mismatch" }] });
  }
}

function digestLocation(digest: string): string {
  return `cas://sha256/${digest.slice("sha256:".length)}`;
}

type ParsedEvidenceResult = z.infer<typeof evidenceDaemonResultSchema>;

function assertEvidenceBindings(requestedRunId: string, result: ParsedEvidenceResult): void {
  const hasBundle = result.signedBundle !== null;
  const hasTerminalBundle = result.signedTerminalBundle !== null;
  const terminalPhase = isTerminalRunEventPhase(result.phase);
  const legacyCompleted =
    result.phase === "COMPLETED" && hasBundle && !hasTerminalBundle;
  const expectedStatus = terminalPhase
    ? result.phase === "COMPLETED"
      ? "final"
      : "stopped"
    : hasBundle || hasTerminalBundle || result.phase === "EVIDENCE_FINALIZED"
      ? "finalizing"
      : "current";
  const expectedComplete =
    terminalPhase && (hasTerminalBundle || legacyCompleted);
  const duplicateArtifact =
    new Set(result.artifacts.map((artifact) => artifact.artifactId)).size !==
    result.artifacts.length;
  const malformedArtifactLocation = result.artifacts.some(
    (artifact) => artifact.locationRef !== digestLocation(artifact.digest),
  );
  if (
    result.runId !== requestedRunId ||
    result.status !== expectedStatus ||
    result.complete !== expectedComplete ||
    hasBundle !== (result.bundleDigest !== null) ||
    hasTerminalBundle !== (result.terminalBundleDigest !== null) ||
    (result.phase === "EVIDENCE_FINALIZED" && !hasBundle) ||
    (terminalPhase && result.latestEvent === null) ||
    (terminalPhase && !hasTerminalBundle && !legacyCompleted) ||
    (!hasBundle && result.artifacts.length !== 0) ||
    duplicateArtifact ||
    malformedArtifactLocation
  ) {
    throw new InvalidDaemonResultError({
      issues: [{ path: "evidence", code: "binding_or_status_mismatch" }],
    });
  }

  if (result.latestEvent !== null) {
    const latest = parseDaemonRunEvent(result.latestEvent, "latestEvent");
    if (
      latest.run_id !== result.runId ||
      latest.work_order_id !== result.workOrderId ||
      latest.attempt_id !== result.attemptId ||
      latest.seq !== result.latestSequence ||
      latest.phase !== result.phase ||
      latest.policy_digest !== result.policyDigest
    ) {
      throw new InvalidDaemonResultError({
        issues: [{ path: "latestEvent", code: "binding_mismatch" }],
      });
    }
  }

  if (result.signedBundle !== null) {
    const statement = result.signedBundle.statement;
    const predicate = statement.predicate;
    const candidateSha = result.candidateSha;
    const candidateBindings = [
      statement.subject[0]?.digest.sha1,
      predicate.source.candidate_sha,
      predicate.source.remote_head_sha,
      predicate.delivery.pull_request.head_sha,
      ...predicate.role_outcomes.map((outcome) => outcome.candidate_sha),
      ...predicate.verification.local_checks.map((check) => check.candidate_sha),
      ...predicate.verification.ci_contexts.map((check) => check.candidate_sha),
      ...predicate.reviews.map((review) => review.candidate_sha),
      ...predicate.side_effects.map((effect) => effect.candidate_sha),
      ...predicate.approvals.map((approval) => approval.candidate_sha),
    ];
    const policyBindings = [
      predicate.policy.effective_policy_digest,
      ...predicate.reviews.map((review) => review.policy_digest),
      ...predicate.approvals.map((approval) => approval.policy_digest),
    ];
    const artifactBindingsValid =
      result.artifacts.length === predicate.artifacts.length &&
      result.artifacts.every((artifact, index) => {
        const signedArtifact = predicate.artifacts[index];
        return (
          signedArtifact !== undefined &&
          artifact.artifactId === signedArtifact.artifact_id &&
          artifact.kind === signedArtifact.kind &&
          artifact.digest === signedArtifact.digest &&
          artifact.sizeBytes === signedArtifact.size_bytes &&
          artifact.mediaType === signedArtifact.media_type &&
          artifact.retentionClass === signedArtifact.retention_class &&
          artifact.locationRef === signedArtifact.location_ref &&
          signedArtifact.location_ref === digestLocation(signedArtifact.digest)
        );
      });
    if (
      result.bundleDigest !== result.signedBundle.bundle_digest ||
      result.signedBundle.bundle_digest !== sha256Digest(statement) ||
      predicate.run.run_id !== result.runId ||
      predicate.run.work_order_id !== result.workOrderId ||
      predicate.run.attempt_id !== result.attemptId ||
      candidateSha === null ||
      candidateBindings.some((binding) => binding !== candidateSha) ||
      policyBindings.some((binding) => binding !== result.policyDigest) ||
      !artifactBindingsValid
    ) {
      throw new InvalidDaemonResultError({
        issues: [{ path: "signedBundle", code: "binding_mismatch" }],
      });
    }
  }

  if (result.signedTerminalBundle !== null) {
    const terminalStatement = result.signedTerminalBundle.statement;
    const terminalPredicate = terminalStatement.predicate;
    const actualEvent = result.latestEvent;
    const observations = terminalPredicate.evidence.observations;
    if (
      result.terminalBundleDigest !== result.signedTerminalBundle.bundle_digest ||
      result.signedTerminalBundle.bundle_digest !== sha256Digest(terminalStatement) ||
      terminalPredicate.run.run_id !== result.runId ||
      terminalPredicate.run.work_order_id !== result.workOrderId ||
      terminalPredicate.run.attempt_id !== result.attemptId ||
      terminalPredicate.admission.effective_policy_digest !== result.policyDigest ||
      terminalPredicate.source.candidate_sha !== result.candidateSha ||
      terminalStatement.subject[0]?.name !== `asf-run:${result.runId}` ||
      terminalStatement.subject[0]?.digest.sha1 !== terminalPredicate.source.subject_sha ||
      terminalPredicate.evidence.delivery_bundle_digest !== result.bundleDigest ||
      observations.length !== terminalPredicate.evidence.preceding_event_count ||
      observations.some((observation, index) => observation.event_seq !== index + 1) ||
      (terminalPhase
        ? terminalPredicate.run.terminal_phase !== result.phase ||
          terminalPredicate.run.terminal_event_seq !== result.latestSequence ||
          actualEvent === null ||
          actualEvent.payload["terminal_evidence_bundle_digest"] !==
            result.terminalBundleDigest
        : terminalPredicate.run.terminal_event_seq !== result.latestSequence + 1)
    ) {
      throw new InvalidDaemonResultError({
        issues: [{ path: "signedTerminalBundle", code: "binding_mismatch" }],
      });
    }
  }
}

/**
 * One stateless MCP connection facade over the durable private daemon client.
 * The only connection state is the MCP initialization handshake. It never
 * starts, owns, cancels, or awaits the lifetime of a submitted run.
 */
export class AsfMcpServer {
  readonly #controlClient: AsfDaemonControlClient;
  #initializeResponded = false;
  #ready = false;

  constructor(options: AsfMcpServerOptions = {}) {
    this.#controlClient =
      options.controlClient ??
      ((request) =>
        requestDaemon<unknown>(
          request,
          options.registryPath ?? asfDaemonRuntimePaths().registry,
          ASF_MCP_CONTROL_TIMEOUT_MS,
          {
            ...(options.controlAuthentication === undefined
              ? {}
              : { controlAuthentication: options.controlAuthentication }),
          },
        ));
  }

  #requestControl(request: AsfControlRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Runmill service request timed out")),
        ASF_MCP_CONTROL_TIMEOUT_MS,
      );
      void Promise.resolve()
        .then(() => this.#controlClient(request))
        .then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error("Runmill service request failed"));
          },
        );
    });
  }

  async handleMessage(raw: unknown): Promise<JsonRpcResponse | undefined> {
    const parsed = jsonRpcMessageSchema.safeParse(raw);
    if (!parsed.success) return protocolError(null, -32600, "Invalid Request");
    const message = parsed.data;
    if (message.id === undefined) {
      if (message.method === "notifications/initialized" && this.#initializeResponded) {
        const params = initializedNotificationParamsSchema.safeParse(message.params ?? {});
        if (params.success) this.#ready = true;
      }
      return undefined;
    }

    const id = message.id;
    try {
      switch (message.method) {
        case "initialize":
          return this.#initialize(id, message.params);
        case "tools/list":
          return this.#listTools(id, message.params);
        case "tools/call":
          return await this.#callTool(id, message.params);
        default:
          return protocolError(id, -32601, "Method not found");
      }
    } catch {
      return protocolError(id, -32603, "Internal error");
    }
  }

  #initialize(id: JsonRpcId, rawParams: unknown): JsonRpcResponse {
    if (this.#initializeResponded) {
      return protocolError(id, -32600, "Server already initialized");
    }
    const params = initializeParamsSchema.safeParse(rawParams);
    if (!params.success) {
      return protocolError(id, -32602, "Invalid params", issueData(params.error));
    }
    this.#initializeResponded = true;
    return success(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "runmill-asf", version: "0.1.0" },
      instructions:
        "Submissions are durable daemon jobs. Closing this MCP connection does not stop a run.",
    });
  }

  #listTools(id: JsonRpcId, rawParams: unknown): JsonRpcResponse {
    if (!this.#ready) return protocolError(id, -32002, "Server not initialized");
    const params = listToolsParamsSchema.safeParse(rawParams ?? {});
    if (!params.success) {
      return protocolError(id, -32602, "Invalid params", issueData(params.error));
    }
    return success(id, { tools: ASF_MCP_TOOLS });
  }

  async #callTool(id: JsonRpcId, rawParams: unknown): Promise<JsonRpcResponse> {
    if (!this.#ready) return protocolError(id, -32002, "Server not initialized");
    const params = callToolParamsSchema.safeParse(rawParams);
    if (!params.success) {
      return protocolError(id, -32602, "Invalid params", issueData(params.error));
    }
    const args = params.data.arguments ?? {};
    switch (params.data.name) {
      case "runmill_submit_work_order": {
        const input = submitArgumentsSchema.safeParse(args);
        if (!input.success) {
          return success(id, invalidToolArguments(input.error));
        }
        try {
          const raw = await this.#requestControl({
            type: "asf.submit_work_order",
            envelope: input.data.envelope,
          });
          const result = parseDaemonResult(submitDaemonResultSchema, raw);
          if (result.payloadDigest !== sha256Digest(input.data.envelope.payload)) {
            throw new InvalidDaemonResultError({
              issues: [{ path: "payloadDigest", code: "binding_mismatch" }],
            });
          }
          const output = publicSubmitResultSchema.parse({
            run_id: result.runId,
            disposition: result.disposition,
            payload_digest: result.payloadDigest,
          });
          return success(id, toolSuccess(output));
        } catch (error) {
          return success(id, toolFailure(error));
        }
      }
      case "runmill_get_run": {
        const input = getRunArgumentsSchema.safeParse(args);
        if (!input.success) {
          return success(id, invalidToolArguments(input.error));
        }
        try {
          const raw = await this.#requestControl({
            type: "asf.get_run",
            runId: input.data.run_id,
          });
          const result = parseDaemonResult(getRunDaemonResultSchema, raw);
          assertRunBindings(
            input.data.run_id,
            result.run,
            result.admission.workOrderId,
            result.admission.attemptId,
          );
          if (result.run.stateVersion !== result.latestSequence) {
            throw new InvalidDaemonResultError({
              issues: [{ path: "latestSequence", code: "state_version_mismatch" }],
            });
          }
          const output = publicGetRunResultSchema.parse({
            ...publicRunSnapshot(result.run, result.latestSequence),
            admission: {
              idempotency_key: result.admission.idempotencyKey,
              tenant_id: result.admission.tenantId,
              payload_digest: result.admission.payloadDigest,
              envelope_digest: result.admission.envelopeDigest,
              effective_policy_digest: result.admission.effectivePolicyDigest,
              signature_key_id: result.admission.signatureKeyId,
              signature_algorithm: result.admission.signatureAlgorithm,
              accepted_at: result.admission.acceptedAt,
            },
          });
          return success(id, toolSuccess(output));
        } catch (error) {
          return success(id, toolFailure(error, input.data.run_id));
        }
      }
      case "runmill_list_run_events": {
        const input = listRunEventsArgumentsSchema.safeParse(args);
        if (!input.success) {
          return success(id, invalidToolArguments(input.error));
        }
        let after: number | undefined;
        if (input.data.cursor !== undefined) {
          try {
            after = decodeCursor(input.data.cursor, input.data.run_id);
          } catch {
            return success(id, invalidToolArguments());
          }
        }
        try {
          const request: AsfControlRequest = {
            type: "asf.list_run_events",
            runId: input.data.run_id,
            ...(after === undefined ? {} : { after }),
            ...(input.data.limit === undefined ? {} : { limit: input.data.limit }),
          };
          const raw = await this.#requestControl(request);
          const result = parseDaemonResult(eventPageDaemonResultSchema, raw);
          assertRunBindings(input.data.run_id, result.snapshot.run);
          if (result.snapshot.run.stateVersion !== result.snapshot.latestSequence) {
            throw new InvalidDaemonResultError({
              issues: [{ path: "snapshot.latestSequence", code: "state_version_mismatch" }],
            });
          }
          const requestedAfter = after ?? 0;
          const pageLimit = input.data.limit ?? 100;
          const gapMetadataValid =
            result.gap === (result.compactedThrough !== null) &&
            (result.compactedThrough === null ||
              (result.compactedThrough > requestedAfter &&
                result.compactedThrough <= result.snapshot.latestSequence));
          if (!gapMetadataValid) {
            throw new InvalidDaemonResultError({
              issues: [{ path: "compactedThrough", code: "gap_metadata_mismatch" }],
            });
          }
          let previous = result.compactedThrough ?? requestedAfter;
          const events = result.events.map((event) => {
            const validated = parseDaemonRunEvent(event, "events");
            if (
              validated.run_id !== input.data.run_id ||
              validated.work_order_id !== result.snapshot.run.workOrderId ||
              validated.attempt_id !== result.snapshot.run.attemptId ||
              validated.seq !== previous + 1
            ) {
              throw new InvalidDaemonResultError({
                issues: [{ path: "events", code: "binding_or_sequence_mismatch" }],
              });
            }
            previous = validated.seq;
            return validated;
          });
          if (
            events.some(
              (current, index) =>
                index > 0 && current.policy_digest !== events[index - 1]?.policy_digest,
            ) ||
            (events.length > 0 &&
              result.nextCursor === result.snapshot.latestSequence &&
              events.at(-1)?.phase !== result.snapshot.run.state)
          ) {
            throw new InvalidDaemonResultError({
              issues: [{ path: "events", code: "policy_or_phase_mismatch" }],
            });
          }
          const expectedNextCursor =
            events.length > 0
              ? previous
              : Math.max(requestedAfter, result.compactedThrough ?? 0);
          const moreMetadataValid = result.hasMore
            ? events.length === pageLimit && result.nextCursor < result.snapshot.latestSequence
            : result.nextCursor === result.snapshot.latestSequence;
          if (
            events.length > pageLimit ||
            result.nextCursor !== expectedNextCursor ||
            !moreMetadataValid
          ) {
            throw new InvalidDaemonResultError({
              issues: [{ path: "nextCursor", code: "cursor_mismatch" }],
            });
          }
          const output = publicEventPageResultSchema.parse({
            events,
            next_cursor: encodeCursor(input.data.run_id, result.nextCursor),
            has_more: result.hasMore,
            gap: result.gap,
            compacted_through_cursor:
              result.compactedThrough === null
                ? null
                : encodeCursor(input.data.run_id, result.compactedThrough),
            snapshot: publicRunSnapshot(result.snapshot.run, result.snapshot.latestSequence),
          });
          return success(id, toolSuccess(output));
        } catch (error) {
          return success(id, toolFailure(error, input.data.run_id));
        }
      }
      case "runmill_get_evidence": {
        const input = getEvidenceArgumentsSchema.safeParse(args);
        if (!input.success) return success(id, invalidToolArguments(input.error));
        try {
          const raw = await this.#requestControl({
            type: "asf.get_evidence",
            runId: input.data.run_id,
          });
          const result = parseDaemonResult(evidenceDaemonResultSchema, raw);
          assertEvidenceBindings(input.data.run_id, result);
          const output = publicEvidenceResultSchema.parse({
            schema: result.schema,
            run_id: result.runId,
            work_order_id: result.workOrderId,
            attempt_id: result.attemptId,
            phase: result.phase,
            candidate_sha: result.candidateSha,
            policy_digest: result.policyDigest,
            latest_sequence: result.latestSequence,
            status: result.status,
            complete: result.complete,
            bundle_digest: result.bundleDigest,
            terminal_bundle_digest: result.terminalBundleDigest,
            artifacts: result.artifacts.map((artifact) => ({
              artifact_id: artifact.artifactId,
              kind: artifact.kind,
              digest: artifact.digest,
              size_bytes: artifact.sizeBytes,
              media_type: artifact.mediaType,
              retention_class: artifact.retentionClass,
              location_ref: artifact.locationRef,
            })),
            latest_event: result.latestEvent,
            signed_bundle: result.signedBundle,
            signed_terminal_bundle: result.signedTerminalBundle,
          });
          return success(id, toolSuccess(output));
        } catch (error) {
          return success(id, toolFailure(error, input.data.run_id));
        }
      }
      case "runmill_request_cancel": {
        const input = requestCancelArgumentsSchema.safeParse(args);
        if (!input.success) return success(id, invalidToolArguments(input.error));
        try {
          const raw = await this.#requestControl({
            type: "asf.request_cancel",
            request: input.data.request,
          });
          const result = parseDaemonResult(cancellationDaemonResultSchema, raw);
          const stateMatchesDisposition =
            result.disposition === "requested"
              ? result.state === "CANCEL_REQUESTED"
              : result.disposition === "already-terminal"
                ? isTerminalRunEventPhase(result.state)
                : !isTerminalRunEventPhase(result.state);
          if (
            result.requestId !== input.data.request.request_id ||
            result.runId !== input.data.request.run_id ||
            result.requestDigest !== sha256Digest(input.data.request) ||
            !stateMatchesDisposition ||
            (input.data.request.mode === "forced" &&
              result.disposition === "requested" &&
              !result.reconciliationRequired)
          ) {
            throw new InvalidDaemonResultError({
              issues: [{ path: "cancellation", code: "binding_mismatch" }],
            });
          }
          const output = publicCancellationResultSchema.parse({
            request_id: result.requestId,
            run_id: result.runId,
            disposition: result.disposition,
            state: result.state,
            generation: result.generation,
            request_digest: result.requestDigest,
            reconciliation_required: result.reconciliationRequired,
          });
          return success(id, toolSuccess(output));
        } catch (error) {
          return success(id, toolFailure(error, input.data.request.run_id));
        }
      }
      case "runmill_record_approval": {
        const input = recordApprovalArgumentsSchema.safeParse(args);
        if (!input.success) return success(id, invalidToolArguments(input.error));
        try {
          const raw = await this.#requestControl({
            type: "asf.record_approval",
            envelope: input.data.envelope,
          });
          const result = parseDaemonResult(approvalDaemonResultSchema, raw);
          if (
            result.approvalId !== input.data.envelope.payload.approval_id ||
            result.runId !== input.data.envelope.payload.run_id ||
            result.decision !== input.data.envelope.payload.decision ||
            result.envelopeDigest !== sha256Digest(input.data.envelope)
          ) {
            throw new InvalidDaemonResultError({
              issues: [{ path: "approval", code: "binding_mismatch" }],
            });
          }
          const output = publicApprovalResultSchema.parse({
            approval_id: result.approvalId,
            run_id: result.runId,
            decision: result.decision,
            disposition: result.disposition,
            envelope_digest: result.envelopeDigest,
          });
          return success(id, toolSuccess(output));
        } catch (error) {
          return success(id, toolFailure(error, input.data.envelope.payload.run_id));
        }
      }
      case "runmill_reconcile_run": {
        const input = reconcileRunArgumentsSchema.safeParse(args);
        if (!input.success) return success(id, invalidToolArguments(input.error));
        try {
          const raw = await this.#requestControl({
            type: "asf.reconcile_run",
            request: input.data.request,
          });
          const result = parseDaemonResult(reconciliationDaemonResultSchema, raw);
          const sameOperation =
            result.operationId === input.data.request.operation_id;
          const dispositionStatusValid =
            result.disposition === "queued"
              ? result.status === "queued"
              : result.disposition === "nothing-to-reconcile"
                ? result.status === "completed"
                : sameOperation || result.status === "queued" || result.status === "running";
          if (
            result.runId !== input.data.request.run_id ||
            (sameOperation && result.requestDigest !== sha256Digest(input.data.request)) ||
            (!sameOperation && result.disposition !== "existing") ||
            !dispositionStatusValid
          ) {
            throw new InvalidDaemonResultError({
              issues: [{ path: "reconciliation", code: "binding_mismatch" }],
            });
          }
          const output = publicReconciliationResultSchema.parse({
            operation_id: result.operationId,
            run_id: result.runId,
            disposition: result.disposition,
            status: result.status,
            request_digest: result.requestDigest,
            requested_at: result.requestedAt,
          });
          return success(id, toolSuccess(output));
        } catch (error) {
          return success(id, toolFailure(error, input.data.request.run_id));
        }
      }
      case "runmill_acknowledge_outcome": {
        const input = acknowledgeOutcomeArgumentsSchema.safeParse(args);
        if (!input.success) return success(id, invalidToolArguments(input.error));
        try {
          const raw = await this.#requestControl({
            type: "asf.acknowledge_outcome",
            acknowledgement: input.data.acknowledgement,
          });
          const result = parseDaemonResult(acknowledgementDaemonResultSchema, raw);
          if (
            result.acknowledgementId !==
              input.data.acknowledgement.acknowledgement_id ||
            result.runId !== input.data.acknowledgement.run_id ||
            result.bundleDigest !== input.data.acknowledgement.bundle_digest
          ) {
            throw new InvalidDaemonResultError({
              issues: [{ path: "acknowledgement", code: "binding_mismatch" }],
            });
          }
          const output = publicAcknowledgementResultSchema.parse({
            acknowledgement_id: result.acknowledgementId,
            run_id: result.runId,
            bundle_digest: result.bundleDigest,
            disposition: result.disposition,
            acknowledged_at: result.acknowledgedAt,
          });
          return success(id, toolSuccess(output));
        } catch (error) {
          return success(id, toolFailure(error, input.data.acknowledgement.run_id));
        }
      }
      case "runmill_health": {
        const input = healthArgumentsSchema.safeParse(args);
        if (!input.success) return success(id, invalidToolArguments(input.error));
        try {
          const raw = await this.#requestControl({ type: "asf.health" });
          const result = parseDaemonResult(asfHealthReportSchema, raw);
          return success(id, toolSuccess(result));
        } catch (error) {
          return success(id, toolFailure(error));
        }
      }
      default:
        return protocolError(id, -32602, "Unknown tool");
    }
  }
}

export function createStdioMcpTransport(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): McpNdjsonTransport {
  return {
    incoming: input,
    async send(line) {
      if (!output.write(line, "utf8")) await once(output, "drain");
    },
  };
}

/** Serve one newline-delimited MCP connection until its input closes. */
export async function serveAsfMcpTransport(
  server: AsfMcpServer,
  transport: McpNdjsonTransport,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";

  const processLine = async (line: string): Promise<void> => {
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      await transport.send(`${JSON.stringify(protocolError(null, -32700, "Parse error"))}\n`);
      return;
    }
    const response = await server.handleMessage(raw);
    if (response !== undefined) await transport.send(`${JSON.stringify(response)}\n`);
  };

  for await (const chunk of transport.incoming) {
    try {
      buffer +=
        typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    } catch {
      await transport.send(`${JSON.stringify(protocolError(null, -32700, "Parse error"))}\n`);
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (Buffer.byteLength(line, "utf8") > MAX_MCP_MESSAGE_BYTES) {
        await transport.send(
          `${JSON.stringify(protocolError(null, -32600, "MCP message too large"))}\n`,
        );
        continue;
      }
      await processLine(line);
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_MCP_MESSAGE_BYTES) {
      await transport.send(
        `${JSON.stringify(protocolError(null, -32600, "MCP message too large"))}\n`,
      );
      return;
    }
  }

  try {
    buffer += decoder.decode();
  } catch {
    await transport.send(`${JSON.stringify(protocolError(null, -32700, "Parse error"))}\n`);
    return;
  }
  if (buffer !== "") await processLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
}

export async function serveAsfMcpStdio(
  options: AsfMcpServerOptions = {},
  transport: McpNdjsonTransport = createStdioMcpTransport(),
): Promise<void> {
  await serveAsfMcpTransport(new AsfMcpServer(options), transport);
}
