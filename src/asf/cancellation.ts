import { z } from "zod";
import { RunmillError } from "../errors/runmill-error.js";
import { sha256Digest } from "./canonical-json.js";

export const CANCELLATION_REQUEST_SCHEMA = "asf.cancellation-request/v1" as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const cancellationRequestSchema = z
  .object({
    schema: z.literal(CANCELLATION_REQUEST_SCHEMA),
    request_id: identifierSchema,
    run_id: identifierSchema,
    requester: z
      .object({
        subject: identifierSchema,
        authority: z.literal("asf:cancel"),
      })
      .strict(),
    reason: z.string().trim().min(1).max(2_048),
    mode: z.enum(["graceful", "forced"]),
    grace_seconds: z.number().int().min(0).max(300),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.mode === "graceful" && request.grace_seconds < 1) {
      context.addIssue({
        code: "custom",
        path: ["grace_seconds"],
        message: "graceful cancellation requires a positive grace period",
      });
    }
    if (request.mode === "forced" && request.grace_seconds !== 0) {
      context.addIssue({
        code: "custom",
        path: ["grace_seconds"],
        message: "forced cancellation must use a zero-second grace period",
      });
    }
  });

export type CancellationRequest = z.infer<typeof cancellationRequestSchema>;

export interface CancellationResult {
  readonly requestId: string;
  readonly runId: string;
  readonly disposition: "requested" | "existing" | "already-terminal";
  readonly state: string;
  readonly generation: number;
  readonly requestDigest: string;
  readonly reconciliationRequired: boolean;
}

const cancellationPolicy = Symbol("runmill.asf.cancellation-policy");

export interface AppliedCancellationPolicy {
  readonly mode: CancellationRequest["mode"];
  readonly graceSeconds: number;
}

type CancellationResultWithPolicy = CancellationResult & {
  readonly [cancellationPolicy]?: AppliedCancellationPolicy;
};

/**
 * Read the controller-validated cancellation timing carried inside this
 * process. The symbol is deliberately non-enumerable, so the private daemon
 * and public MCP response contracts remain unchanged.
 */
export function appliedCancellationPolicy(
  result: CancellationResult,
): AppliedCancellationPolicy | undefined {
  const policy = (result as CancellationResultWithPolicy)[cancellationPolicy];
  if (
    policy === undefined ||
    (policy.mode !== "graceful" && policy.mode !== "forced") ||
    !Number.isSafeInteger(policy.graceSeconds) ||
    policy.graceSeconds < 0 ||
    (policy.mode === "graceful" && policy.graceSeconds < 1) ||
    (policy.mode === "forced" && policy.graceSeconds !== 0)
  ) {
    return undefined;
  }
  return policy;
}

export interface CancellationStore {
  requestAsfCancellation(input: {
    readonly request: CancellationRequest;
    readonly requestDigest: string;
  }): CancellationResult;
}

function cancellationError(whatHappened: string): RunmillError {
  return RunmillError.fromCatalog("RM-CANCEL-001", { whatHappened });
}

export function parseCancellationRequest(raw: unknown): CancellationRequest {
  const parsed = cancellationRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw cancellationError(
      "the cancellation request is malformed:\n" +
        parsed.error.issues
          .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("\n"),
    );
  }
  return parsed.data;
}

/** Stateless validation plus an atomic durable/fencing store operation. */
export class AsfCancellationService {
  readonly #store: CancellationStore;

  constructor(store: CancellationStore) {
    this.#store = store;
  }

  request(raw: unknown): CancellationResult {
    const request = parseCancellationRequest(raw);
    const result = this.#store.requestAsfCancellation({
      request,
      requestDigest: sha256Digest(request),
    });
    const returned = { ...result } as CancellationResultWithPolicy;
    Object.defineProperty(returned, cancellationPolicy, {
      value: Object.freeze({
        mode: request.mode,
        graceSeconds: request.grace_seconds,
      } satisfies AppliedCancellationPolicy),
      configurable: false,
      enumerable: false,
      writable: false,
    });
    return returned;
  }
}
