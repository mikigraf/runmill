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
export const ASF_QUALIFICATION_EXECUTION_SCHEMA =
  "asf.qualification-execution/v1" as const;

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

export type AsfLiveQualificationTarget = Exclude<
  AsfQualificationTarget,
  "process-cold-start"
>;
const ASF_LIVE_QUALIFICATION_TARGETS = [
  "ctxlane",
  "github-protected",
  "integrated",
] as const satisfies readonly AsfLiveQualificationTarget[];

export interface AsfLiveQualificationCase {
  readonly id: string;
  readonly target: AsfLiveQualificationTarget;
  readonly kind:
    | "ctxlane-service-restart"
    | "ctxlane-lease-generation-change"
    | "github-protected-pr-pilot"
    | "github-response-loss"
    | "github-head-drift"
    | "submission-response-loss"
    | "provider-harness-timeout"
    | "sandbox-denial-canary"
    | "workspace-checkpoint-recovery"
    | "verification-response-loss"
    | "review-response-loss"
    | "evidence-persistence-loss"
    | "acknowledgement-response-loss"
    | "cancellation-revocation"
    | "worker-heartbeat-takeover"
    | "disk-full"
    | "clock-rollback"
    | "host-reboot";
}

export type AsfQualificationCase =
  | AsfProcessColdStartCase
  | AsfLiveQualificationCase;

/**
 * Closed external qualification cases from the PRD failure matrix. These are
 * identifiers for an operator-owned executor, not claims that the cases have
 * run. Keeping the catalog in the worker makes omissions reviewable and lets
 * a report prove exactly which cases were attempted.
 */
export const ASF_LIVE_QUALIFICATION_CASES = deepFreeze([
  {
    id: "live:ctxlane:service-restart",
    target: "ctxlane",
    kind: "ctxlane-service-restart",
  },
  {
    id: "live:ctxlane:lease-generation-change",
    target: "ctxlane",
    kind: "ctxlane-lease-generation-change",
  },
  {
    id: "live:github:protected-pr-pilot",
    target: "github-protected",
    kind: "github-protected-pr-pilot",
  },
  {
    id: "live:github:response-loss",
    target: "github-protected",
    kind: "github-response-loss",
  },
  {
    id: "live:github:head-drift",
    target: "github-protected",
    kind: "github-head-drift",
  },
  {
    id: "live:integrated:submission-response-loss",
    target: "integrated",
    kind: "submission-response-loss",
  },
  {
    id: "live:integrated:provider-harness-timeout",
    target: "integrated",
    kind: "provider-harness-timeout",
  },
  {
    id: "live:integrated:sandbox-denial-canary",
    target: "integrated",
    kind: "sandbox-denial-canary",
  },
  {
    id: "live:integrated:workspace-checkpoint-recovery",
    target: "integrated",
    kind: "workspace-checkpoint-recovery",
  },
  {
    id: "live:integrated:verification-response-loss",
    target: "integrated",
    kind: "verification-response-loss",
  },
  {
    id: "live:integrated:review-response-loss",
    target: "integrated",
    kind: "review-response-loss",
  },
  {
    id: "live:integrated:evidence-persistence-loss",
    target: "integrated",
    kind: "evidence-persistence-loss",
  },
  {
    id: "live:integrated:acknowledgement-response-loss",
    target: "integrated",
    kind: "acknowledgement-response-loss",
  },
  {
    id: "live:integrated:cancellation-revocation",
    target: "integrated",
    kind: "cancellation-revocation",
  },
  {
    id: "live:integrated:worker-heartbeat-takeover",
    target: "integrated",
    kind: "worker-heartbeat-takeover",
  },
  {
    id: "live:integrated:disk-full",
    target: "integrated",
    kind: "disk-full",
  },
  {
    id: "live:integrated:clock-rollback",
    target: "integrated",
    kind: "clock-rollback",
  },
  {
    id: "live:integrated:host-reboot",
    target: "integrated",
    kind: "host-reboot",
  },
] as const satisfies readonly AsfLiveQualificationCase[]);

if (
  new Set(ASF_LIVE_QUALIFICATION_CASES.map((qualificationCase) => qualificationCase.id)).size !==
    ASF_LIVE_QUALIFICATION_CASES.length ||
  ASF_LIVE_QUALIFICATION_TARGETS.some(
    (target) => !ASF_LIVE_QUALIFICATION_CASES.some((qualificationCase) => qualificationCase.target === target),
  )
) {
  throw new Error("ASF live qualification case catalog is incomplete or duplicated");
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

export interface AsfQualificationCaseResult {
  readonly case: AsfQualificationCase;
  readonly status: "passed" | "failed";
  readonly reason: "assertion-failed" | "executor-failed" | "invalid-result" | null;
}

export interface AsfQualificationExecutionReport {
  readonly schema: typeof ASF_QUALIFICATION_EXECUTION_SCHEMA;
  readonly profile: typeof ASF_PR_ONLY_QUALIFICATION_PROFILE;
  readonly target: AsfQualificationTarget;
  readonly decision: "blocked" | "passed" | "failed";
  readonly productionQualified: false;
  readonly blockedReasons: readonly AsfQualificationBlockReason[];
  readonly cases: readonly AsfQualificationCaseResult[];
  readonly passedCases: number;
  readonly failedCases: number;
}

export interface AsfQualificationCaseExecution {
  readonly status: "passed" | "failed";
}

export type AsfQualificationCaseExecutor = (
  qualificationCase: AsfQualificationCase,
) => AsfQualificationCaseExecution | Promise<AsfQualificationCaseExecution>;

export class AsfQualificationPreflightInputError extends Error {
  readonly code = "INVALID_QUALIFICATION_PREFLIGHT_INPUT" as const;

  constructor() {
    super(
      "ASF qualification preflight input is malformed or contains unknown fields",
    );
    this.name = "AsfQualificationPreflightInputError";
  }
}

export class AsfQualificationExecutionReportError extends Error {
  readonly code = "INVALID_QUALIFICATION_EXECUTION_REPORT" as const;

  constructor(reason: string) {
    super(`ASF qualification execution report is invalid: ${reason}`);
    this.name = "AsfQualificationExecutionReportError";
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

function executionStatus(raw: unknown): AsfQualificationCaseExecution["status"] | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  try {
    if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (
      Reflect.ownKeys(raw).some((key) => typeof key !== "string") ||
      Object.keys(descriptors).length !== 1 ||
      descriptors.status?.enumerable !== true ||
      !("value" in (descriptors.status ?? {}))
    ) {
      return null;
    }
    const status = descriptors.status.value;
    return status === "passed" || status === "failed" ? status : null;
  } catch {
    return null;
  }
}

function casesForTarget(
  target: AsfQualificationTarget,
): readonly AsfQualificationCase[] {
  if (target === "process-cold-start") return ASF_PROCESS_COLD_START_CASES;
  return ASF_LIVE_QUALIFICATION_CASES.filter((item) => item.target === target);
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

/**
 * Execute an explicitly authorized qualification matrix through an
 * operator-owned harness. A blocked preflight never calls the executor. Any
 * thrown, malformed, or failed case is represented as failed evidence without
 * exposing executor details, and no result can grant production authority.
 */
export async function runAsfQualificationMatrix(
  raw: unknown,
  executeCase: AsfQualificationCaseExecutor,
): Promise<AsfQualificationExecutionReport> {
  const preflight = evaluateAsfQualificationPreflight(raw);
  if (!preflight.readyToRun) {
    return deepFreeze({
      schema: ASF_QUALIFICATION_EXECUTION_SCHEMA,
      profile: ASF_PR_ONLY_QUALIFICATION_PROFILE,
      target: preflight.target,
      decision: "blocked",
      productionQualified: false,
      blockedReasons: preflight.reasons,
      cases: [],
      passedCases: 0,
      failedCases: 0,
    });
  }

  const results: AsfQualificationCaseResult[] = [];
  for (const qualificationCase of casesForTarget(preflight.target)) {
    let status: AsfQualificationCaseExecution["status"] | null = null;
    let reason: AsfQualificationCaseResult["reason"] = null;
    try {
      const execution = await executeCase(qualificationCase);
      status = executionStatus(execution);
      if (status === null) reason = "invalid-result";
    } catch {
      reason = "executor-failed";
    }
    if (status === null) {
      status = "failed";
    } else if (status === "failed") {
      reason = "assertion-failed";
    }
    results.push({ case: qualificationCase, status, reason });
  }
  const passedCases = results.filter((result) => result.status === "passed").length;
  const failedCases = results.length - passedCases;
  return deepFreeze({
    schema: ASF_QUALIFICATION_EXECUTION_SCHEMA,
    profile: ASF_PR_ONLY_QUALIFICATION_PROFILE,
    target: preflight.target,
    decision: failedCases === 0 ? "passed" : "failed",
    productionQualified: false,
    blockedReasons: [],
    cases: results,
    passedCases,
    failedCases,
  });
}

function safeRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
      Object.values(descriptors).some(
        (descriptor) =>
          descriptor.enumerable !== true || !("value" in descriptor),
      )
    ) {
      return null;
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(descriptors).map(([key, descriptor]) => [
          key,
          "value" in descriptor ? descriptor.value : undefined,
        ]),
      ),
    );
  } catch {
    return null;
  }
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const PROCESS_COLD_START_DESCRIPTOR_KEYS: ReadonlySet<string> = new Set([
  "id",
  "target",
  "checkpointKind",
  "boundary",
]);
const LIVE_DESCRIPTOR_KEYS: ReadonlySet<string> = new Set([
  "id",
  "target",
  "kind",
]);

function validateCaseDescriptor(
  caseValue: unknown,
  target: AsfQualificationTarget,
): AsfQualificationCase | null {
  const record = safeRecord(caseValue);
  if (record === null) return null;

  const allowedKeys =
    target === "process-cold-start"
      ? PROCESS_COLD_START_DESCRIPTOR_KEYS
      : LIVE_DESCRIPTOR_KEYS;

  const actualKeys = new Set(Object.keys(record));
  if (
    actualKeys.size !== allowedKeys.size ||
    [...allowedKeys].some((key) => !actualKeys.has(key))
  ) {
    return null;
  }

  return record as unknown as AsfQualificationCase;
}

function caseDescriptorEquals(
  left: AsfQualificationCase,
  right: AsfQualificationCase,
): boolean {
  if (left.id !== right.id || left.target !== right.target) return false;
  if (left.target === "process-cold-start" && right.target === "process-cold-start") {
    return (
      left.checkpointKind === right.checkpointKind && left.boundary === right.boundary
    );
  }
  if (left.target !== "process-cold-start" && right.target !== "process-cold-start") {
    return left.kind === right.kind;
  }
  return false;
}

function cloneCaseDescriptor(
  qualificationCase: AsfQualificationCase,
): AsfQualificationCase {
  if (qualificationCase.target === "process-cold-start") {
    return {
      id: qualificationCase.id,
      target: qualificationCase.target,
      checkpointKind: qualificationCase.checkpointKind,
      boundary: qualificationCase.boundary,
    };
  }
  return {
    id: qualificationCase.id,
    target: qualificationCase.target,
    kind: qualificationCase.kind,
  };
}

/**
 * Bounded fail-closed verification of an operator-supplied serialized execution
 * report. Rejects malformed or tampered reports without exposing executor
 * details, and never grants production authority. Validates strict object shape,
 * schema/profile, known target, productionQualified exactly false,
 * decision/blockedReasons consistency, blocked reports have no cases and zero
 * counts, runnable targets have exact catalog membership with no
 * missing/duplicate/unknown cases, immutable case descriptor equality, exact
 * status/reason consistency (passed => reason null, failed =>
 * assertion-failed/executor-failed/invalid-result), and exact count equality.
 * Returns a deeply frozen safe report copy. Does not mutate caller input.
 */
export function verifyAsfQualificationExecutionReport(
  raw: unknown,
): AsfQualificationExecutionReport {
  try {
    const report = safeRecord(raw);
    if (report === null) {
      throw new AsfQualificationExecutionReportError("not a plain object");
    }

  const allowedReportKeys: ReadonlySet<string> = new Set([
    "schema",
    "profile",
    "target",
    "decision",
    "productionQualified",
    "blockedReasons",
    "cases",
    "passedCases",
    "failedCases",
  ]);

  const actualReportKeys = new Set(Object.keys(report));
  if (
    actualReportKeys.size !== allowedReportKeys.size ||
    [...allowedReportKeys].some((key) => !actualReportKeys.has(key))
  ) {
    throw new AsfQualificationExecutionReportError("unknown report keys");
  }

  if (report.schema !== ASF_QUALIFICATION_EXECUTION_SCHEMA) {
    throw new AsfQualificationExecutionReportError("invalid schema");
  }

  if (report.profile !== ASF_PR_ONLY_QUALIFICATION_PROFILE) {
    throw new AsfQualificationExecutionReportError("invalid profile");
  }

  const target = ASF_QUALIFICATION_TARGETS.find((t) => t === report.target);
  if (target === undefined) {
    throw new AsfQualificationExecutionReportError("unknown target");
  }

  if (report.productionQualified !== false) {
    throw new AsfQualificationExecutionReportError(
      "productionQualified must be exactly false",
    );
  }

  const decision = report.decision;
  if (decision !== "blocked" && decision !== "passed" && decision !== "failed") {
    throw new AsfQualificationExecutionReportError("invalid decision");
  }

  if (!Array.isArray(report.blockedReasons)) {
    throw new AsfQualificationExecutionReportError("invalid blockedReasons");
  }

  for (const item of report.blockedReasons) {
    if (
      !ASF_QUALIFICATION_BLOCK_REASONS.includes(item as AsfQualificationBlockReason)
    ) {
      throw new AsfQualificationExecutionReportError("invalid blockedReasons");
    }
  }
  const normalizedBlockedReasons = normalizedReasons(
    report.blockedReasons as AsfQualificationBlockReason[],
  );
  if (
    normalizedBlockedReasons.length !== report.blockedReasons.length ||
    normalizedBlockedReasons.some(
      (reason, index) =>
        reason !== (report.blockedReasons as readonly unknown[])[index],
    )
  ) {
    throw new AsfQualificationExecutionReportError(
      "blockedReasons must be sorted and unique",
    );
  }

  if (!Array.isArray(report.cases)) {
    throw new AsfQualificationExecutionReportError("invalid cases");
  }

  const allowedCaseResultKeys: ReadonlySet<string> = new Set([
    "case",
    "status",
    "reason",
  ]);

  for (const item of report.cases) {
    const caseResult = safeRecord(item);
    if (caseResult === null) {
      throw new AsfQualificationExecutionReportError("invalid cases");
    }

    const actualCaseKeys = new Set(Object.keys(caseResult));
    if (
      actualCaseKeys.size !== allowedCaseResultKeys.size ||
      [...allowedCaseResultKeys].some((key) => !actualCaseKeys.has(key))
    ) {
      throw new AsfQualificationExecutionReportError("unknown case-result keys");
    }

    const validatedCase = validateCaseDescriptor(caseResult.case, target);
    if (validatedCase === null) {
      throw new AsfQualificationExecutionReportError("unknown case-descriptor keys");
    }

    const status = caseResult.status;
    if (status !== "passed" && status !== "failed") {
      throw new AsfQualificationExecutionReportError("invalid cases");
    }

    const reason = caseResult.reason;
    if (
      reason !== null &&
      reason !== "assertion-failed" &&
      reason !== "executor-failed" &&
      reason !== "invalid-result"
    ) {
      throw new AsfQualificationExecutionReportError("invalid cases");
    }

    if (status === "passed" && reason !== null) {
      throw new AsfQualificationExecutionReportError("invalid cases");
    }

    if (status === "failed" && reason === null) {
      throw new AsfQualificationExecutionReportError("invalid cases");
    }
  }

  if (
    !isFiniteNonNegative(report.passedCases) ||
    !Number.isInteger(report.passedCases)
  ) {
    throw new AsfQualificationExecutionReportError("passedCases must be an integer");
  }

  if (
    !isFiniteNonNegative(report.failedCases) ||
    !Number.isInteger(report.failedCases)
  ) {
    throw new AsfQualificationExecutionReportError("failedCases must be an integer");
  }

  if (decision === "blocked") {
    if (report.blockedReasons.length === 0) {
      throw new AsfQualificationExecutionReportError(
        "blocked decision requires blockedReasons",
      );
    }
    if (report.cases.length !== 0) {
      throw new AsfQualificationExecutionReportError(
        "blocked decision must have no cases",
      );
    }
    if (report.passedCases !== 0 || report.failedCases !== 0) {
      throw new AsfQualificationExecutionReportError(
        "blocked decision must have zero counts",
      );
    }
  } else {
    if (target === "ctxlane" || target === "integrated") {
      throw new AsfQualificationExecutionReportError(
        "target remains blocked by authenticated-service qualification",
      );
    }
    if (report.blockedReasons.length !== 0) {
      throw new AsfQualificationExecutionReportError(
        "non-blocked decision must have empty blockedReasons",
      );
    }

    const expectedCases = casesForTarget(target);
    const caseIds = new Set<string>();

    for (let i = 0; i < report.cases.length; i++) {
      const result = safeRecord(report.cases[i]);
      const reportCase = result === null
        ? null
        : validateCaseDescriptor(result.case, target);
      if (reportCase === null) {
        throw new AsfQualificationExecutionReportError("invalid cases");
      }

      if (caseIds.has(reportCase.id)) {
        throw new AsfQualificationExecutionReportError("duplicate case id");
      }
      caseIds.add(reportCase.id);

      const expectedCase = expectedCases.find((c) => c.id === reportCase.id);
      if (expectedCase === undefined) {
        throw new AsfQualificationExecutionReportError("unknown case id");
      }

      if (expectedCases[i]?.id !== reportCase.id) {
        throw new AsfQualificationExecutionReportError("case order mismatch");
      }

      if (!caseDescriptorEquals(reportCase, expectedCase)) {
        throw new AsfQualificationExecutionReportError(
          "case descriptor does not match catalog",
        );
      }
    }

    for (const expectedCase of expectedCases) {
      if (!caseIds.has(expectedCase.id)) {
        throw new AsfQualificationExecutionReportError("missing case from catalog");
      }
    }

    if (report.cases.length !== expectedCases.length) {
      throw new AsfQualificationExecutionReportError(
        "case count does not match target catalog",
      );
    }

    const actualPassedCases = report.cases.filter(
      (item) => safeRecord(item)?.status === "passed",
    ).length;
    const actualFailedCases = report.cases.length - actualPassedCases;

    if (report.passedCases !== actualPassedCases) {
      throw new AsfQualificationExecutionReportError("passedCases count mismatch");
    }

    if (report.failedCases !== actualFailedCases) {
      throw new AsfQualificationExecutionReportError("failedCases count mismatch");
    }
  }

    const sanitizedCases = report.cases.map((item) => {
      const caseResult = safeRecord(item);
      const reportCase = caseResult === null
        ? null
        : validateCaseDescriptor(caseResult.case, target);
      const expectedCase = reportCase === null
        ? undefined
        : casesForTarget(target).find((candidate) => candidate.id === reportCase.id);
      if (caseResult === null || reportCase === null || expectedCase === undefined) {
        throw new AsfQualificationExecutionReportError("invalid cases");
      }
      return {
        case: cloneCaseDescriptor(expectedCase),
        status: caseResult.status as "passed" | "failed",
        reason: caseResult.reason as
          | "assertion-failed"
          | "executor-failed"
          | "invalid-result"
          | null,
      };
    });

    return deepFreeze({
      schema: ASF_QUALIFICATION_EXECUTION_SCHEMA,
      profile: ASF_PR_ONLY_QUALIFICATION_PROFILE,
      target,
      decision,
      productionQualified: false,
      blockedReasons: [...report.blockedReasons] as AsfQualificationBlockReason[],
      cases: sanitizedCases,
      passedCases: report.passedCases,
      failedCases: report.failedCases,
    });
  } catch (error) {
    if (error instanceof AsfQualificationExecutionReportError) throw error;
    throw new AsfQualificationExecutionReportError("malformed report");
  }
}
