import { z } from "zod";
import { RunmillError } from "../errors/runmill-error.js";
import { sha256Digest } from "./canonical-json.js";

export const OUTCOME_ACKNOWLEDGEMENT_SCHEMA =
  "asf.outcome-acknowledgement/v1" as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const outcomeAcknowledgementSchema = z
  .object({
    schema: z.literal(OUTCOME_ACKNOWLEDGEMENT_SCHEMA),
    acknowledgement_id: identifierSchema,
    run_id: identifierSchema,
    bundle_digest: digestSchema,
    acknowledged_by: z
      .object({
        subject: identifierSchema,
        authority: z.literal("asf:acknowledge-outcome"),
      })
      .strict(),
  })
  .strict();

export type OutcomeAcknowledgement = z.infer<typeof outcomeAcknowledgementSchema>;

export interface AcknowledgeOutcomeResult {
  readonly acknowledgementId: string;
  readonly runId: string;
  readonly bundleDigest: string;
  readonly disposition: "recorded" | "existing";
  readonly acknowledgedAt: string;
}

export interface OutcomeAcknowledgementStore {
  acknowledgeAsfOutcome(input: {
    readonly acknowledgement: OutcomeAcknowledgement;
    readonly requestDigest: string;
  }): AcknowledgeOutcomeResult;
}

function invalid(whatHappened: string): RunmillError {
  return RunmillError.fromCatalog("RM-EVID-008", { whatHappened });
}

export function parseOutcomeAcknowledgement(raw: unknown): OutcomeAcknowledgement {
  const parsed = outcomeAcknowledgementSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(
      "the outcome acknowledgement is malformed:\n" +
        parsed.error.issues
          .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("\n"),
    );
  }
  return parsed.data;
}

export class AsfOutcomeAcknowledgementService {
  readonly #store: OutcomeAcknowledgementStore;

  constructor(store: OutcomeAcknowledgementStore) {
    this.#store = store;
  }

  acknowledge(raw: unknown): AcknowledgeOutcomeResult {
    const acknowledgement = parseOutcomeAcknowledgement(raw);
    return this.#store.acknowledgeAsfOutcome({
      acknowledgement,
      requestDigest: sha256Digest(acknowledgement),
    });
  }
}
