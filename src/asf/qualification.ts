import { posix } from "node:path";
import {
  ASF_CHECKPOINT_KINDS,
  type AsfCheckpointKind,
} from "./checkpoint-policy.js";

export const ASF_QUALIFICATION_PREFLIGHT_INPUT_SCHEMA =
  "asf.qualification-preflight-input/v1" as const;
export const ASF_QUALIFICATION_PREFLIGHT_SCHEMA =
  "asf.qualification-preflight/v1" as const;
export const ASF_PR_ONLY_QUALIFICATION_PROFILE =
  "asf.pr-only-qualification-profile/v1" as const;

export const ASF_QUALIFICATION_TARGETS = Object.freeze([
  "process-cold-start",
  "ctxlane",
  "github-protected",
  "integrated",
] as const);

export type AsfQualificationTarget = (typeof ASF_QUALIFICATION_TARGETS)[number];

export const ASF_PROCESS_COLD_START_BOUNDARIES = Object.freeze([
  "before",
  "after",
] as const);
export type AsfProcessColdStartBoundary =
  (typeof ASF_PROCESS_COLD_START_BOUNDARIES)[number];

const PR_ONLY_NOT_APPLICABLE_KINDS = [
  "merge-queue-candidate-state",
  "merge-intent-observation",
] as const satisfies readonly AsfCheckpointKind[];

export type AsfPrOnlyNotApplicableCheckpointKind =
  (typeof PR_ONLY_NOT_APPLICABLE_KINDS)[number];
export type AsfPrOnlyApplicableCheckpointKind = Exclude<
  AsfCheckpointKind,
  AsfPrOnlyNotApplicableCheckpointKind
>;

export interface AsfQualificationCheckpointApplicability {
  readonly checkpointKind: AsfCheckpointKind;
  readonly applicability: "applicable" | "not-applicable";
  readonly reason: "pr-only-profile-prohibits-merge" | null;
}

export interface AsfProcessColdStartCase {
  readonly id: `process-cold-start:${AsfPrOnlyApplicableCheckpointKind}:${AsfProcessColdStartBoundary}`;
  readonly target: "process-cold-start";
  readonly checkpointKind: AsfPrOnlyApplicableCheckpointKind;
  readonly boundary: AsfProcessColdStartBoundary;
}

function isNotApplicableCheckpoint(
  kind: AsfCheckpointKind,
): kind is AsfPrOnlyNotApplicableCheckpointKind {
  return (
    PR_ONLY_NOT_APPLICABLE_KINDS as readonly AsfCheckpointKind[]
  ).includes(kind);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      deepFreeze(descriptor.value);
    }
  }
  return Object.freeze(value);
}

const applicableKinds = ASF_CHECKPOINT_KINDS.filter(
  (kind): kind is AsfPrOnlyApplicableCheckpointKind =>
    !isNotApplicableCheckpoint(kind),
);

if (
  ASF_CHECKPOINT_KINDS.length !== 17 ||
  new Set(ASF_CHECKPOINT_KINDS).size !== ASF_CHECKPOINT_KINDS.length ||
  applicableKinds.length !== 15 ||
  PR_ONLY_NOT_APPLICABLE_KINDS.some(
    (kind) => !ASF_CHECKPOINT_KINDS.includes(kind),
  )
) {
  throw new Error(
    "ASF PR-only qualification checkpoint profile is out of sync with the checkpoint catalog",
  );
}

export const ASF_PR_ONLY_APPLICABLE_CHECKPOINT_KINDS = deepFreeze([
  ...applicableKinds,
] as readonly AsfPrOnlyApplicableCheckpointKind[]);

export const ASF_PR_ONLY_NOT_APPLICABLE_CHECKPOINTS = deepFreeze(
  PR_ONLY_NOT_APPLICABLE_KINDS.map((checkpointKind) => ({
    checkpointKind,
    applicability: "not-applicable" as const,
    reason: "pr-only-profile-prohibits-merge" as const,
  })),
);

export const ASF_PR_ONLY_CHECKPOINT_APPLICABILITY = deepFreeze(
  ASF_CHECKPOINT_KINDS.map(
    (checkpointKind): AsfQualificationCheckpointApplicability =>
      isNotApplicableCheckpoint(checkpointKind)
        ? {
            checkpointKind,
            applicability: "not-applicable",
            reason: "pr-only-profile-prohibits-merge",
          }
        : { checkpointKind, applicability: "applicable", reason: null },
  ),
);

export const ASF_PROCESS_COLD_START_CASES = deepFreeze(
  ASF_PR_ONLY_APPLICABLE_CHECKPOINT_KINDS.flatMap((checkpointKind) =>
    ASF_PROCESS_COLD_START_BOUNDARIES.map(
      (boundary): AsfProcessColdStartCase => ({
        id: `process-cold-start:${checkpointKind}:${boundary}`,
        target: "process-cold-start",
        checkpointKind,
        boundary,
      }),
    ),
  ),
);

export const ASF_QUALIFICATION_BLOCK_REASONS = Object.freeze([
  "ctxlane.authenticated-service-unavailable",
  "ctxlane.lifecycle-unavailable",
  "execution-not-explicitly-authorized",
  "github.output-path-invalid",
  "github.output-path-conflicts-token-file",
  "github.private-repository-required",
  "github.repository-acknowledgement-required",
  "github.repository-invalid",
  "github.token-file-invalid",
  "integrated.reference-path-unavailable",
  "platform-not-linux",
] as const);

export type AsfQualificationBlockReason =
  (typeof ASF_QUALIFICATION_BLOCK_REASONS)[number];

interface CommonPreflightInput {
  readonly schema: typeof ASF_QUALIFICATION_PREFLIGHT_INPUT_SCHEMA;
  readonly target: AsfQualificationTarget;
  readonly execute?: unknown;
  readonly platform?: unknown;
}

export interface ProcessColdStartPreflightInput extends CommonPreflightInput {
  readonly target: "process-cold-start";
}

export interface CtxlanePreflightInput extends CommonPreflightInput {
  readonly target: "ctxlane";
}

export interface IntegratedPreflightInput extends CommonPreflightInput {
  readonly target: "integrated";
}

export interface GitHubProtectedPreflightInput extends CommonPreflightInput {
  readonly target: "github-protected";
  readonly repository?: unknown;
  readonly privateRepository?: unknown;
  readonly tokenFile?: unknown;
  readonly outputPath?: unknown;
  readonly acknowledgement?: unknown;
}

export type AsfQualificationPreflightInput =
  | ProcessColdStartPreflightInput
  | CtxlanePreflightInput
  | GitHubProtectedPreflightInput
  | IntegratedPreflightInput;

export interface AsfQualificationPreflightResult {
  readonly schema: typeof ASF_QUALIFICATION_PREFLIGHT_SCHEMA;
  readonly profile: typeof ASF_PR_ONLY_QUALIFICATION_PROFILE;
  readonly target: AsfQualificationTarget;
  readonly decision: "ready-to-run" | "blocked";
  readonly readyToRun: boolean;
  /** This scaffold can never grant production authority. */
  readonly productionQualified: false;
  readonly reasons: readonly AsfQualificationBlockReason[];
  readonly checkpointApplicability: readonly AsfQualificationCheckpointApplicability[];
  readonly processColdStartCases: readonly AsfProcessColdStartCase[];
}

export class AsfQualificationPreflightInputError extends Error {
  readonly code = "INVALID_QUALIFICATION_PREFLIGHT_INPUT" as const;

  constructor() {
    super(
      "ASF qualification preflight input is malformed or contains unknown fields",
    );
    this.name = "AsfQualificationPreflightInputError";
  }
}

const COMMON_INPUT_KEYS: ReadonlySet<string> = new Set([
  "schema",
  "target",
  "execute",
  "platform",
]);
const GITHUB_INPUT_KEYS: ReadonlySet<string> = new Set([
  ...COMMON_INPUT_KEYS,
  "repository",
  "privateRepository",
  "tokenFile",
  "outputPath",
  "acknowledgement",
]);

function inputRecord(raw: unknown): Readonly<Record<string, unknown>> {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new AsfQualificationPreflightInputError();
    }
    const prototype: unknown = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AsfQualificationPreflightInputError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (
      Reflect.ownKeys(raw).some((key) => typeof key !== "string") ||
      Object.values(descriptors).some(
        (descriptor) =>
          descriptor.enumerable !== true || !("value" in descriptor),
      )
    ) {
      throw new AsfQualificationPreflightInputError();
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(descriptors).map(([key, descriptor]) => [
          key,
          "value" in descriptor ? descriptor.value : undefined,
        ]),
      ),
    );
  } catch (error) {
    if (error instanceof AsfQualificationPreflightInputError) throw error;
    throw new AsfQualificationPreflightInputError();
  }
}

function parseInput(raw: unknown): AsfQualificationPreflightInput {
  const input = inputRecord(raw);
  if (input["schema"] !== ASF_QUALIFICATION_PREFLIGHT_INPUT_SCHEMA) {
    throw new AsfQualificationPreflightInputError();
  }
  const target = ASF_QUALIFICATION_TARGETS.find(
    (candidate) => candidate === input["target"],
  );
  if (target === undefined) throw new AsfQualificationPreflightInputError();
  const allowed =
    target === "github-protected" ? GITHUB_INPUT_KEYS : COMMON_INPUT_KEYS;
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new AsfQualificationPreflightInputError();
  }
  return input as unknown as AsfQualificationPreflightInput;
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedReasons(
  reasons: readonly AsfQualificationBlockReason[],
): readonly AsfQualificationBlockReason[] {
  return [...new Set(reasons)].sort(ordinal);
}

function safePosixFilePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 1 &&
    value.length <= 4_096 &&
    posix.isAbsolute(value) &&
    posix.normalize(value) === value &&
    !value.endsWith("/") &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function safeGitHubRepository(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 140) return false;
  const match =
    /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})$/u.exec(
      value,
    );
  return match !== null && match[2] !== "." && match[2] !== "..";
}

function commonReasons(
  input: AsfQualificationPreflightInput,
): AsfQualificationBlockReason[] {
  const reasons: AsfQualificationBlockReason[] = [];
  if (input.execute !== true)
    reasons.push("execution-not-explicitly-authorized");
  if (input.platform !== "linux") reasons.push("platform-not-linux");
  return reasons;
}

/**
 * Pure, non-authorizing prerequisite evaluation for explicit qualification.
 * It performs no environment, filesystem, socket, credential, or network read.
 */
export function evaluateAsfQualificationPreflight(
  raw: unknown,
): AsfQualificationPreflightResult {
  const input = parseInput(raw);
  const reasons = commonReasons(input);

  if (input.target === "ctxlane" || input.target === "integrated") {
    reasons.push(
      "ctxlane.authenticated-service-unavailable",
      "ctxlane.lifecycle-unavailable",
    );
    if (input.target === "integrated") {
      reasons.push("integrated.reference-path-unavailable");
    }
  } else if (input.target === "github-protected") {
    if (!safeGitHubRepository(input.repository)) {
      reasons.push("github.repository-invalid");
    }
    if (input.privateRepository !== true) {
      reasons.push("github.private-repository-required");
    }
    if (!safePosixFilePath(input.tokenFile)) {
      reasons.push("github.token-file-invalid");
    }
    if (!safePosixFilePath(input.outputPath)) {
      reasons.push("github.output-path-invalid");
    }
    if (
      safePosixFilePath(input.tokenFile) &&
      safePosixFilePath(input.outputPath) &&
      input.tokenFile === input.outputPath
    ) {
      reasons.push("github.output-path-conflicts-token-file");
    }
    if (
      typeof input.repository !== "string" ||
      input.acknowledgement !== input.repository
    ) {
      reasons.push("github.repository-acknowledgement-required");
    }
  }

  const normalized = normalizedReasons(reasons);
  const readyToRun = normalized.length === 0;
  return deepFreeze({
    schema: ASF_QUALIFICATION_PREFLIGHT_SCHEMA,
    profile: ASF_PR_ONLY_QUALIFICATION_PROFILE,
    target: input.target,
    decision: readyToRun ? "ready-to-run" : "blocked",
    readyToRun,
    productionQualified: false,
    reasons: normalized,
    checkpointApplicability: ASF_PR_ONLY_CHECKPOINT_APPLICABILITY,
    processColdStartCases: ASF_PROCESS_COLD_START_CASES,
  });
}
