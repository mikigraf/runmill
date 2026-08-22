import { sha256Digest } from "./canonical-json.js";
import type { StateStore } from "../state/store.js";

export const ASF_PROVIDER_BUDGET_ALLOWANCE_SCHEMA =
  "asf.provider-budget-allowance/v1" as const;

export const ASF_PROVIDER_BUDGET_ROLES = [
  "implementer",
  "fixer",
  "local-reviewer",
  "pr-reviewer",
] as const;

export type AsfProviderBudgetRole = (typeof ASF_PROVIDER_BUDGET_ROLES)[number];

export type AsfProviderBudgetExhaustionReason =
  | "wall-deadline"
  | "cost-limit"
  | "invocation-limit";

export interface AsfProviderBudgetBinding {
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly policyDigest: string;
  readonly fencingGeneration: number;
  /** Candidate held by the lifecycle before this provider effect. */
  readonly candidateSha: string | null;
}

export interface AsfProviderBudgetLimits {
  readonly wallSeconds: number;
  readonly maxCostUsd: number;
  readonly maxAgentInvocations: number;
}

export interface AsfProviderEffectBudgetInput {
  readonly binding: AsfProviderBudgetBinding;
  readonly effectKey: string;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly intentGeneration: number;
  readonly intentMode: "observe-before-apply" | "reconcile-only";
  readonly role: AsfProviderBudgetRole;
  readonly invocationId: string;
  /** Candidate/base SHA carried in the trusted provider binding. */
  readonly providerCandidateSha: string;
  readonly limits: AsfProviderBudgetLimits;
}

export interface AsfProviderBudgetAllowance {
  readonly schema: typeof ASF_PROVIDER_BUDGET_ALLOWANCE_SCHEMA;
  readonly reservationId: string;
  readonly reservationDigest: string;
  readonly authorization: "invoke" | "reconcile-only";
  readonly acceptedAt: string;
  readonly deadlineAt: string;
  readonly remainingWallMs: number;
  readonly maxCostUsd: number;
  readonly invocationOrdinal: number;
  readonly maxAgentInvocations: number;
}

export type AsfProviderBudgetDecision =
  | {
      readonly status: "reserved";
      readonly allowance: AsfProviderBudgetAllowance;
    }
  | {
      readonly status: "exhausted";
      readonly reason: AsfProviderBudgetExhaustionReason;
      /** Durable observation proving that this effect was not authorized. */
      readonly observationDigest: string;
    };

export interface AsfProviderBudgetCompletionInput {
  readonly binding: AsfProviderBudgetBinding;
  readonly reservationId: string;
  readonly reservationDigest: string;
  readonly effectKey: string;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly role: AsfProviderBudgetRole;
  readonly invocationId: string;
  readonly providerCandidateSha: string;
  readonly providerResultDigest: string;
  readonly provider: string;
  readonly model: string;
  readonly principal: string;
  readonly profile: string;
  readonly actualCostUsd: number;
  readonly limits: AsfProviderBudgetLimits;
}

export interface AsfProviderBudgetCompletion {
  readonly status: "completed";
  readonly actualCostMicros: number;
  readonly conservativeCostMicros: number;
  readonly invocationCount: number;
  readonly completedAfterDeadline: boolean;
  readonly exceededReservedCost: boolean;
}

export interface AsfRunBudgetCheckInput {
  readonly binding: AsfProviderBudgetBinding;
  readonly limits: AsfProviderBudgetLimits;
}

export type AsfRunBudgetCheck =
  | { readonly status: "available" }
  | {
      readonly status: "exhausted";
      readonly reason: "wall-deadline" | "cost-limit";
      readonly observationDigest: string;
    };

/**
 * Durable budget authority used by the ASF orchestrator. Implementations are
 * not provider adapters: they make the fail-closed reservation decision before
 * a provider is authorized and preserve unknown crash-window usage.
 */
export interface AsfProviderBudgetController {
  checkRun(input: AsfRunBudgetCheckInput): AsfRunBudgetCheck;
  reserve(input: AsfProviderEffectBudgetInput): AsfProviderBudgetDecision;
  complete(input: AsfProviderBudgetCompletionInput): AsfProviderBudgetCompletion;
}

function decimalParts(value: number): { coefficient: bigint; exponent: number } {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("ASF cost must be a finite non-negative number");
  }
  const [mantissa = "", rawExponent = "0"] = value.toString().toLowerCase().split("e");
  const exponent = Number(rawExponent);
  if (!Number.isSafeInteger(exponent)) throw new Error("ASF cost exponent is invalid");
  const [whole = "", fraction = ""] = mantissa.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/u, "");
  if (!/^\d+$/u.test(digits)) throw new Error("ASF cost is not a decimal number");
  return {
    coefficient: BigInt(digits),
    exponent: exponent - fraction.length,
  };
}

function scaledUsdMicros(value: number, rounding: "floor" | "ceil"): number {
  const { coefficient, exponent } = decimalParts(value);
  const microExponent = exponent + 6;
  let micros: bigint;
  if (microExponent >= 0) {
    micros = coefficient * 10n ** BigInt(microExponent);
  } else {
    const divisor = 10n ** BigInt(-microExponent);
    micros = coefficient / divisor;
    if (rounding === "ceil" && coefficient % divisor !== 0n) micros += 1n;
  }
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("ASF cost exceeds the durable micro-USD range");
  }
  return Number(micros);
}

/** Policy caps round down, so sub-micro authority is never widened. */
export function asfCostLimitUsdToMicros(value: number): number {
  return scaledUsdMicros(value, "floor");
}

/** Observed usage rounds up, so sub-micro provider charges never disappear. */
export function asfObservedCostUsdToMicros(value: number): number {
  return scaledUsdMicros(value, "ceil");
}

export function asfMicrosToUsd(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("ASF micro-USD value must be a non-negative safe integer");
  }
  return value / 1_000_000;
}

export function asfProviderInvocationId(
  effectKey: string,
  role: AsfProviderBudgetRole,
): string {
  const digest = sha256Digest({ effect_key: effectKey, role });
  return `agent_${digest.slice("sha256:".length, "sha256:".length + 32)}`;
}

export function asfProviderBudgetReservationId(input: {
  readonly effectKey: string;
  readonly role: AsfProviderBudgetRole;
  readonly invocationId: string;
}): string {
  const digest = sha256Digest({
    effect_key: input.effectKey,
    role: input.role,
    invocation_id: input.invocationId,
  });
  return `budget_${digest.slice("sha256:".length, "sha256:".length + 32)}`;
}

/** Production adapter over StateStore's IMMEDIATE, exact-bound transactions. */
export class StateStoreAsfProviderBudgetController
  implements AsfProviderBudgetController
{
  readonly #store: StateStore;
  readonly #ownerId: string;

  constructor(store: StateStore, ownerId: string) {
    if (ownerId.trim() === "") throw new Error("ASF budget owner id is required");
    this.#store = store;
    this.#ownerId = ownerId;
  }

  checkRun(input: AsfRunBudgetCheckInput): AsfRunBudgetCheck {
    return this.#store.checkAsfRunBudget({
      ownerId: this.#ownerId,
      binding: input.binding,
      limits: {
        wallSeconds: input.limits.wallSeconds,
        maxCostMicros: asfCostLimitUsdToMicros(input.limits.maxCostUsd),
        maxAgentInvocations: input.limits.maxAgentInvocations,
      },
    });
  }

  reserve(input: AsfProviderEffectBudgetInput): AsfProviderBudgetDecision {
    const decision = this.#store.reserveAsfProviderBudget({
      ownerId: this.#ownerId,
      ...input,
      limits: {
        wallSeconds: input.limits.wallSeconds,
        maxCostMicros: asfCostLimitUsdToMicros(input.limits.maxCostUsd),
        maxAgentInvocations: input.limits.maxAgentInvocations,
      },
    });
    if (decision.status === "exhausted") return decision;
    return {
      status: "reserved",
      allowance: {
        schema: ASF_PROVIDER_BUDGET_ALLOWANCE_SCHEMA,
        reservationId: decision.reservationId,
        reservationDigest: decision.reservationDigest,
        authorization: decision.authorization,
        acceptedAt: decision.acceptedAt,
        deadlineAt: decision.deadlineAt,
        remainingWallMs: decision.remainingWallMs,
        maxCostUsd: asfMicrosToUsd(decision.reservedCostMicros),
        invocationOrdinal: decision.invocationOrdinal,
        maxAgentInvocations: decision.maxAgentInvocations,
      },
    };
  }

  complete(input: AsfProviderBudgetCompletionInput): AsfProviderBudgetCompletion {
    return this.#store.completeAsfProviderBudget({
      ownerId: this.#ownerId,
      ...input,
      actualCostMicros: asfObservedCostUsdToMicros(input.actualCostUsd),
      limits: {
        wallSeconds: input.limits.wallSeconds,
        maxCostMicros: asfCostLimitUsdToMicros(input.limits.maxCostUsd),
        maxAgentInvocations: input.limits.maxAgentInvocations,
      },
    });
  }
}
