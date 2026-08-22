import { describe, expect, it } from "vitest";
import {
  ASF_PROCESS_COLD_START_CASES,
  ASF_PR_ONLY_APPLICABLE_CHECKPOINT_KINDS,
  ASF_PR_ONLY_CHECKPOINT_APPLICABILITY,
  ASF_PR_ONLY_NOT_APPLICABLE_CHECKPOINTS,
  ASF_PR_ONLY_QUALIFICATION_PROFILE,
  ASF_QUALIFICATION_PREFLIGHT_INPUT_SCHEMA,
  ASF_QUALIFICATION_PREFLIGHT_SCHEMA,
  AsfQualificationPreflightInputError,
  evaluateAsfQualificationPreflight,
} from "../../src/asf/qualification.js";

const APPLICABLE = [
  "work-order-admission",
  "repository-lease-acquisition",
  "identity-lease-acquisition",
  "workspace-sandbox-proof",
  "task-packet-creation",
  "implementer-session-marker",
  "candidate-commit-creation",
  "local-verification-pass",
  "local-review-fixer-iteration",
  "branch-push-intent-observation",
  "pull-request-intent-observation",
  "ci-reconciliation-snapshot",
  "pr-review-fixer-iteration",
  "evidence-finalization-acknowledgement",
  "lease-release-workspace-cleanup",
] as const;

function input(
  target: "process-cold-start" | "ctxlane" | "github-protected" | "integrated",
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schema: ASF_QUALIFICATION_PREFLIGHT_INPUT_SCHEMA,
    target,
    execute: true,
    platform: "linux",
    ...overrides,
  };
}

function githubInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return input("github-protected", {
    repository: "cloudsail/runmill-qualification",
    privateRepository: true,
    tokenFile: "/run/secrets/runmill-github-token",
    outputPath: "/var/lib/runmill/qualification/result.json",
    acknowledgement: "cloudsail/runmill-qualification",
    ...overrides,
  });
}

describe("PR-only qualification manifest", () => {
  it("derives the exact fifteen applicable checkpoints and names both merge exclusions", () => {
    expect(ASF_QUALIFICATION_PREFLIGHT_INPUT_SCHEMA).toBe(
      "asf.qualification-preflight-input/v1",
    );
    expect(ASF_QUALIFICATION_PREFLIGHT_SCHEMA).toBe(
      "asf.qualification-preflight/v1",
    );
    expect(ASF_PR_ONLY_QUALIFICATION_PROFILE).toBe(
      "asf.pr-only-qualification-profile/v1",
    );
    expect(Object.isFrozen(ASF_PROCESS_COLD_START_CASES)).toBe(true);
    expect(ASF_PR_ONLY_APPLICABLE_CHECKPOINT_KINDS).toEqual(APPLICABLE);
    expect(ASF_PR_ONLY_NOT_APPLICABLE_CHECKPOINTS).toEqual([
      {
        checkpointKind: "merge-queue-candidate-state",
        applicability: "not-applicable",
        reason: "pr-only-profile-prohibits-merge",
      },
      {
        checkpointKind: "merge-intent-observation",
        applicability: "not-applicable",
        reason: "pr-only-profile-prohibits-merge",
      },
    ]);
    expect(ASF_PR_ONLY_CHECKPOINT_APPLICABILITY).toHaveLength(17);
    expect(
      ASF_PR_ONLY_CHECKPOINT_APPLICABILITY.filter(
        (checkpoint) => checkpoint.applicability === "applicable",
      ).map((checkpoint) => checkpoint.checkpointKind),
    ).toEqual(APPLICABLE);
    expect(
      ASF_PR_ONLY_CHECKPOINT_APPLICABILITY.filter(
        (checkpoint) => checkpoint.applicability === "not-applicable",
      ),
    ).toEqual(ASF_PR_ONLY_NOT_APPLICABLE_CHECKPOINTS);
  });

  it("exports the deterministic checkpoint-major thirty-case cold-start matrix", () => {
    expect(ASF_PROCESS_COLD_START_CASES).toHaveLength(30);
    expect(ASF_PROCESS_COLD_START_CASES).toEqual(
      APPLICABLE.flatMap((checkpointKind) =>
        (["before", "after"] as const).map((boundary) => ({
          id: `process-cold-start:${checkpointKind}:${boundary}`,
          target: "process-cold-start",
          checkpointKind,
          boundary,
        })),
      ),
    );
    expect(
      new Set(ASF_PROCESS_COLD_START_CASES.map((item) => item.id)).size,
    ).toBe(30);
    expect(JSON.stringify(ASF_PROCESS_COLD_START_CASES)).not.toContain(
      "merge-intent",
    );
    expect(JSON.stringify(ASF_PROCESS_COLD_START_CASES)).not.toContain(
      "merge-queue",
    );
  });
});

describe("pure qualification preflight", () => {
  it("can only make an explicitly requested Linux process matrix ready to run", () => {
    const ready = evaluateAsfQualificationPreflight(
      input("process-cold-start"),
    );
    expect(ready).toMatchObject({
      schema: ASF_QUALIFICATION_PREFLIGHT_SCHEMA,
      profile: ASF_PR_ONLY_QUALIFICATION_PROFILE,
      target: "process-cold-start",
      decision: "ready-to-run",
      readyToRun: true,
      productionQualified: false,
      reasons: [],
    });

    expect(
      evaluateAsfQualificationPreflight(
        input("process-cold-start", { execute: false, platform: "darwin" }),
      ).reasons,
    ).toEqual(["execution-not-explicitly-authorized", "platform-not-linux"]);
  });

  it.each([
    [
      "ctxlane",
      [
        "ctxlane.authenticated-service-unavailable",
        "ctxlane.lifecycle-unavailable",
      ],
    ],
    [
      "integrated",
      [
        "ctxlane.authenticated-service-unavailable",
        "ctxlane.lifecycle-unavailable",
        "integrated.reference-path-unavailable",
      ],
    ],
  ] as const)(
    "keeps %s blocked even with explicit Linux execution",
    (target, reasons) => {
      const result = evaluateAsfQualificationPreflight(input(target));
      expect(result).toMatchObject({
        target,
        decision: "blocked",
        readyToRun: false,
        productionQualified: false,
        reasons,
      });
    },
  );

  it("makes GitHub only syntactically ready-to-run with every explicit private target binding", () => {
    const result = evaluateAsfQualificationPreflight(githubInput());
    expect(result).toMatchObject({
      target: "github-protected",
      decision: "ready-to-run",
      readyToRun: true,
      productionQualified: false,
      reasons: [],
    });
  });

  it("reports every missing GitHub prerequisite instead of skipping the target", () => {
    expect(
      evaluateAsfQualificationPreflight({
        schema: ASF_QUALIFICATION_PREFLIGHT_INPUT_SCHEMA,
        target: "github-protected",
      }).reasons,
    ).toEqual([
      "execution-not-explicitly-authorized",
      "github.output-path-invalid",
      "github.private-repository-required",
      "github.repository-acknowledgement-required",
      "github.repository-invalid",
      "github.token-file-invalid",
      "platform-not-linux",
    ]);
  });

  it.each([
    ["execution", { execute: false }, "execution-not-explicitly-authorized"],
    ["platform", { platform: "darwin" }, "platform-not-linux"],
    [
      "privacy",
      { privateRepository: false },
      "github.private-repository-required",
    ],
    [
      "repository",
      { repository: "../../etc/passwd" },
      "github.repository-invalid",
    ],
    [
      "repository control",
      { repository: "owner/repo\nother" },
      "github.repository-invalid",
    ],
    [
      "token path",
      { tokenFile: "relative/token" },
      "github.token-file-invalid",
    ],
    [
      "token control",
      { tokenFile: "/run/token\0tail" },
      "github.token-file-invalid",
    ],
    [
      "output path",
      { outputPath: "/var/lib/../tmp/result" },
      "github.output-path-invalid",
    ],
    [
      "output/token conflict",
      {
        outputPath: "/run/secrets/runmill-github-token",
      },
      "github.output-path-conflicts-token-file",
    ],
    [
      "acknowledgement",
      { acknowledgement: "cloudsail/another-repository" },
      "github.repository-acknowledgement-required",
    ],
  ] as const)(
    "blocks invalid GitHub %s configuration",
    (_label, override, reason) => {
      const result = evaluateAsfQualificationPreflight(githubInput(override));
      expect(result.decision).toBe("blocked");
      expect(result.reasons).toContain(reason);
      expect(result.productionQualified).toBe(false);
    },
  );

  it("does not infer the real host platform or execution authority", () => {
    expect(
      evaluateAsfQualificationPreflight({
        schema: ASF_QUALIFICATION_PREFLIGHT_INPUT_SCHEMA,
        target: "process-cold-start",
      }).reasons,
    ).toEqual(["execution-not-explicitly-authorized", "platform-not-linux"]);
  });

  it("deeply freezes every result and shared nested manifest record", () => {
    const result = evaluateAsfQualificationPreflight(githubInput());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
    expect(Object.isFrozen(result.checkpointApplicability)).toBe(true);
    expect(Object.isFrozen(result.checkpointApplicability[0])).toBe(true);
    expect(Object.isFrozen(result.processColdStartCases)).toBe(true);
    expect(Object.isFrozen(result.processColdStartCases[0])).toBe(true);
    expect(() => {
      (
        result.processColdStartCases as AsfProcessColdStartCaseMutation[]
      )[0]!.boundary = "after";
    }).toThrow(TypeError);
  });

  it("returns deterministic, sorted, unique blocked reasons", () => {
    const raw = input("integrated", { execute: false, platform: "other" });
    const first = evaluateAsfQualificationPreflight(raw);
    const second = evaluateAsfQualificationPreflight(structuredClone(raw));
    expect(first).toEqual(second);
    expect(first.reasons).toEqual([...new Set(first.reasons)].sort());
  });
});

type AsfProcessColdStartCaseMutation = {
  id: string;
  target: "process-cold-start";
  checkpointKind: string;
  boundary: "before" | "after";
};

describe("qualification input refusal", () => {
  it.each([
    null,
    [],
    "process-cold-start",
    {},
    {
      schema: "asf.qualification-preflight-input/v2",
      target: "process-cold-start",
    },
    {
      schema: ASF_QUALIFICATION_PREFLIGHT_INPUT_SCHEMA,
      target: "future-target",
    },
    {
      ...input("process-cold-start"),
      untrustedExtension: true,
    },
    {
      ...githubInput(),
      token: "must-never-be-an-accepted-field",
    },
  ])("rejects malformed or extended input %#", (raw) => {
    expect(() => evaluateAsfQualificationPreflight(raw)).toThrow(
      AsfQualificationPreflightInputError,
    );
  });

  it("rejects accessors without invoking them", () => {
    let invoked = false;
    const raw = input("process-cold-start");
    Object.defineProperty(raw, "execute", {
      enumerable: true,
      get() {
        invoked = true;
        return true;
      },
    });
    expect(() => evaluateAsfQualificationPreflight(raw)).toThrow(
      AsfQualificationPreflightInputError,
    );
    expect(invoked).toBe(false);
  });

  it("rejects non-enumerable fields and hostile proxies", () => {
    const hidden = input("process-cold-start");
    Object.defineProperty(hidden, "execute", {
      enumerable: false,
      value: true,
    });
    expect(() => evaluateAsfQualificationPreflight(hidden)).toThrow(
      AsfQualificationPreflightInputError,
    );

    const hostile = new Proxy(input("process-cold-start"), {
      ownKeys: () => {
        throw new Error("hostile proxy");
      },
    });
    expect(() => evaluateAsfQualificationPreflight(hostile)).toThrow(
      AsfQualificationPreflightInputError,
    );
  });

  it("rejects symbol keys and polluted prototypes", () => {
    const symbolInput = input("process-cold-start");
    Object.defineProperty(symbolInput, Symbol("hidden"), { value: true });
    expect(() => evaluateAsfQualificationPreflight(symbolInput)).toThrow(
      AsfQualificationPreflightInputError,
    );

    const polluted = Object.assign(
      Object.create({ inheritedAuthority: true }) as Record<string, unknown>,
      input("process-cold-start"),
    );
    expect(() => evaluateAsfQualificationPreflight(polluted)).toThrow(
      AsfQualificationPreflightInputError,
    );
  });
});
