import { describe, expect, it } from "vitest";
import {
  ASF_LIVE_QUALIFICATION_CASES,
  ASF_PROCESS_COLD_START_CASES,
  ASF_PR_ONLY_APPLICABLE_CHECKPOINT_KINDS,
  ASF_PR_ONLY_CHECKPOINT_APPLICABILITY,
  ASF_PR_ONLY_NOT_APPLICABLE_CHECKPOINTS,
  ASF_PR_ONLY_QUALIFICATION_PROFILE,
  ASF_QUALIFICATION_EXECUTION_SCHEMA,
  ASF_QUALIFICATION_PREFLIGHT_INPUT_SCHEMA,
  ASF_QUALIFICATION_PREFLIGHT_SCHEMA,
  AsfQualificationExecutionReportError,
  AsfQualificationPreflightInputError,
  evaluateAsfQualificationPreflight,
  runAsfQualificationMatrix,
  verifyAsfQualificationExecutionReport,
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

describe("qualification execution matrix", () => {
  it("does not invoke an executor when preflight blocks the target", async () => {
    let calls = 0;
    const result = await runAsfQualificationMatrix(
      input("integrated"),
      async () => {
        calls += 1;
        return { status: "passed" };
      },
    );

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      schema: "asf.qualification-execution/v1",
      target: "integrated",
      decision: "blocked",
      productionQualified: false,
      cases: [],
      passedCases: 0,
      failedCases: 0,
    });
  });

  it("executes every process cold-start case exactly once and freezes the report", async () => {
    const seen: string[] = [];
    const result = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async (qualificationCase) => {
        seen.push(qualificationCase.id);
        return { status: "passed" };
      },
    );

    expect(seen).toEqual(ASF_PROCESS_COLD_START_CASES.map(({ id }) => id));
    expect(result).toMatchObject({
      decision: "passed",
      productionQualified: false,
      passedCases: 30,
      failedCases: 0,
    });
    expect(result.cases).toHaveLength(30);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cases)).toBe(true);
    expect(Object.isFrozen(result.cases[0])).toBe(true);
  });

  it("turns thrown, malformed, and failed executor results into bounded failures", async () => {
    let index = 0;
    const result = await runAsfQualificationMatrix(
      githubInput(),
      async () => {
        index += 1;
        if (index === 1) throw new Error("private executor detail");
        if (index === 2) return { status: "unexpected" } as never;
        return { status: "failed" };
      },
    );

    expect(ASF_LIVE_QUALIFICATION_CASES.filter((item) => item.target === "github-protected")).toHaveLength(3);
    expect(result).toMatchObject({
      target: "github-protected",
      decision: "failed",
      productionQualified: false,
      passedCases: 0,
      failedCases: 3,
    });
    expect(result.cases.map((item) => item.reason)).toEqual([
      "executor-failed",
      "invalid-result",
      "assertion-failed",
    ]);
    expect(JSON.stringify(result)).not.toContain("private executor detail");
  });

  it("runs the explicitly bound private GitHub target only after preflight", async () => {
    const seen: string[] = [];
    const result = await runAsfQualificationMatrix(
      githubInput(),
      (qualificationCase) => {
        seen.push(qualificationCase.id);
        return { status: "passed" };
      },
    );

    expect(seen).toEqual([
      "live:github:protected-pr-pilot",
      "live:github:response-loss",
      "live:github:head-drift",
    ]);
    expect(result.decision).toBe("passed");
    expect(result.productionQualified).toBe(false);
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

describe("qualification execution report verification", () => {
  it("verifies a valid blocked report", () => {
    const report = {
      schema: ASF_QUALIFICATION_EXECUTION_SCHEMA,
      profile: ASF_PR_ONLY_QUALIFICATION_PROFILE,
      target: "integrated",
      decision: "blocked",
      productionQualified: false,
      blockedReasons: [
        "ctxlane.authenticated-service-unavailable",
        "ctxlane.lifecycle-unavailable",
      ],
      cases: [],
      passedCases: 0,
      failedCases: 0,
    };

    const verified = verifyAsfQualificationExecutionReport(report);
    expect(verified).toEqual(report);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.cases)).toBe(true);
    expect(Object.isFrozen(verified.blockedReasons)).toBe(true);
  });

  it("verifies a valid passed process-cold-start report with all cases", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    const verified = verifyAsfQualificationExecutionReport(report);
    expect(verified).toEqual(report);
    expect(verified.decision).toBe("passed");
    expect(verified.passedCases).toBe(30);
    expect(verified.failedCases).toBe(0);
    expect(verified.cases).toHaveLength(30);
  });

  it("verifies a valid failed github-protected report", async () => {
    const report = await runAsfQualificationMatrix(githubInput(), async () => ({
      status: "failed",
    }));

    const verified = verifyAsfQualificationExecutionReport(report);
    expect(verified.decision).toBe("failed");
    expect(verified.passedCases).toBe(0);
    expect(verified.failedCases).toBe(3);
    expect(verified.cases.every((c) => c.status === "failed")).toBe(true);
    expect(verified.cases.every((c) => c.reason === "assertion-failed")).toBe(true);
  });

  it("verifies a valid mixed pass/fail report", async () => {
    let index = 0;
    const report = await runAsfQualificationMatrix(githubInput(), async () => {
      index += 1;
      return { status: index === 1 ? "passed" : "failed" };
    });

    const verified = verifyAsfQualificationExecutionReport(report);
    expect(verified.decision).toBe("failed");
    expect(verified.passedCases).toBe(1);
    expect(verified.failedCases).toBe(2);
  });

  it("rejects non-object values", () => {
    expect(() => verifyAsfQualificationExecutionReport(null)).toThrow(
      AsfQualificationExecutionReportError,
    );
    expect(() => verifyAsfQualificationExecutionReport([])).toThrow(
      AsfQualificationExecutionReportError,
    );
    expect(() => verifyAsfQualificationExecutionReport("report")).toThrow(
      AsfQualificationExecutionReportError,
    );
  });

  it("rejects invalid schema", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        schema: "asf.qualification-execution/v2",
      }),
    ).toThrow("invalid schema");
  });

  it("rejects extra report and case-result keys without touching caller input", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        unexpected: true,
      }),
    ).toThrow("unknown report keys");

    const first = report.cases[0]!;
    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        cases: [{ ...first, extra: "must-refuse" }, ...report.cases.slice(1)],
      }),
    ).toThrow("unknown case-result keys");

    const hostile = new Proxy(report, {
      ownKeys: () => {
        throw new Error("hostile proxy");
      },
    });
    expect(() => verifyAsfQualificationExecutionReport(hostile)).toThrow(
      AsfQualificationExecutionReportError,
    );
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.cases)).toBe(true);
  });

  it("rejects invalid profile", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        profile: "asf.other-profile/v1",
      }),
    ).toThrow("invalid profile");
  });

  it("rejects unknown target", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        target: "future-target",
      }),
    ).toThrow("unknown target");
  });

  it("rejects productionQualified not exactly false", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        productionQualified: true,
      }),
    ).toThrow("productionQualified must be exactly false");

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        productionQualified: null,
      }),
    ).toThrow("productionQualified must be exactly false");
  });

  it("rejects invalid decision", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        decision: "unknown",
      }),
    ).toThrow("invalid decision");
  });

  it("rejects invalid blockedReasons", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        blockedReasons: ["unknown-reason"],
      }),
    ).toThrow("invalid blockedReasons");
  });

  it("rejects unsorted or duplicated blocked reasons", () => {
    const report = {
      schema: ASF_QUALIFICATION_EXECUTION_SCHEMA,
      profile: ASF_PR_ONLY_QUALIFICATION_PROFILE,
      target: "integrated",
      decision: "blocked",
      productionQualified: false,
      blockedReasons: [
        "integrated.reference-path-unavailable",
        "ctxlane.lifecycle-unavailable",
        "ctxlane.authenticated-service-unavailable",
        "ctxlane.authenticated-service-unavailable",
      ],
      cases: [],
      passedCases: 0,
      failedCases: 0,
    };

    expect(() => verifyAsfQualificationExecutionReport(report)).toThrow(
      "blockedReasons must be sorted and unique",
    );
  });

  it("rejects blocked decision without blockedReasons", () => {
    expect(() =>
      verifyAsfQualificationExecutionReport({
        schema: ASF_QUALIFICATION_EXECUTION_SCHEMA,
        profile: ASF_PR_ONLY_QUALIFICATION_PROFILE,
        target: "integrated",
        decision: "blocked",
        productionQualified: false,
        blockedReasons: [],
        cases: [],
        passedCases: 0,
        failedCases: 0,
      }),
    ).toThrow("blocked decision requires blockedReasons");
  });

  it("rejects blocked decision with cases", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        decision: "blocked",
        blockedReasons: ["platform-not-linux"],
      }),
    ).toThrow("blocked decision must have no cases");
  });

  it("rejects blocked decision with non-zero counts", () => {
    expect(() =>
      verifyAsfQualificationExecutionReport({
        schema: ASF_QUALIFICATION_EXECUTION_SCHEMA,
        profile: ASF_PR_ONLY_QUALIFICATION_PROFILE,
        target: "integrated",
        decision: "blocked",
        productionQualified: false,
        blockedReasons: ["platform-not-linux"],
        cases: [],
        passedCases: 1,
        failedCases: 0,
      }),
    ).toThrow("blocked decision must have zero counts");
  });

  it("rejects non-blocked decision with blockedReasons", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        blockedReasons: ["platform-not-linux"],
      }),
    ).toThrow("non-blocked decision must have empty blockedReasons");
  });

  it("rejects non-blocked reports for targets still hard-blocked by preflight", async () => {
    const report = await runAsfQualificationMatrix(
      input("integrated"),
      async () => ({ status: "passed" }),
    );

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        decision: "passed",
        blockedReasons: [],
        cases: ASF_LIVE_QUALIFICATION_CASES.filter(
          (qualificationCase) => qualificationCase.target === "integrated",
        ).map((qualificationCase) => ({
          case: qualificationCase,
          status: "passed",
          reason: null,
        })),
        passedCases: 15,
        failedCases: 0,
      }),
    ).toThrow("target remains blocked by authenticated-service qualification");
  });

  it("rejects case count mismatch", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        cases: report.cases.slice(0, 29),
      }),
    ).toThrow("missing case from catalog");
  });

  it("rejects duplicate case ids", async () => {
    const report = await runAsfQualificationMatrix(githubInput(), async () => ({
      status: "passed",
    }));

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        cases: [report.cases[0]!, report.cases[0]!, report.cases[2]!],
      }),
    ).toThrow("duplicate case id");
  });

  it("rejects unknown case id", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    const tamperedCases = [...report.cases];
    tamperedCases[0] = {
      ...tamperedCases[0]!,
      case: {
        ...tamperedCases[0]!.case,
        id: "process-cold-start:unknown-checkpoint:before",
      } as never,
    };

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        cases: tamperedCases,
      }),
    ).toThrow("unknown case id");
  });

  it("rejects tampered case descriptors for process-cold-start", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    const tamperedCases = [...report.cases];
    const originalCase = tamperedCases[0]!.case;
    tamperedCases[0] = {
      ...tamperedCases[0]!,
      case: {
        ...originalCase,
        checkpointKind: "work-order-admission",
        boundary: "after",
      } as never,
    };

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        cases: tamperedCases,
      }),
    ).toThrow("case descriptor does not match catalog");
  });

  it("rejects tampered case descriptors for live targets", async () => {
    const report = await runAsfQualificationMatrix(githubInput(), async () => ({
      status: "passed",
    }));

    const tamperedCases = [...report.cases];
    tamperedCases[0] = {
      ...tamperedCases[0]!,
      case: {
        ...tamperedCases[0]!.case,
        kind: "github-response-loss",
      } as never,
    };

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        cases: tamperedCases,
      }),
    ).toThrow("case descriptor does not match catalog");
  });

  it("rejects missing cases from catalog", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    const casesToKeep = report.cases.slice(0, 29);

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        cases: casesToKeep,
        passedCases: 29,
        failedCases: 0,
      }),
    ).toThrow("missing case from catalog");
  });

  it("rejects passedCases count mismatch", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        passedCases: 29,
      }),
    ).toThrow("passedCases count mismatch");
  });

  it("rejects failedCases count mismatch", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        failedCases: 1,
      }),
    ).toThrow("failedCases count mismatch");
  });

  it("rejects invalid status", async () => {
    const report = await runAsfQualificationMatrix(githubInput(), async () => ({
      status: "passed",
    }));

    const invalidCases = [...report.cases];
    invalidCases[0] = {
      ...invalidCases[0]!,
      status: "unknown" as never,
    };

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        cases: invalidCases,
      }),
    ).toThrow("invalid cases");
  });

  it("rejects passed status with non-null reason", async () => {
    const report = await runAsfQualificationMatrix(githubInput(), async () => ({
      status: "passed",
    }));

    const invalidCases = [...report.cases];
    invalidCases[0] = {
      ...invalidCases[0]!,
      reason: "assertion-failed",
    };

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        cases: invalidCases,
      }),
    ).toThrow("invalid cases");
  });

  it("rejects failed status with null reason", async () => {
    const report = await runAsfQualificationMatrix(githubInput(), async () => ({
      status: "failed",
    }));

    const invalidCases = [...report.cases];
    invalidCases[0] = {
      ...invalidCases[0]!,
      reason: null,
    };

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        cases: invalidCases,
      }),
    ).toThrow("invalid cases");
  });

  it("rejects invalid reason values", async () => {
    const report = await runAsfQualificationMatrix(githubInput(), async () => ({
      status: "failed",
    }));

    const invalidCases = [...report.cases];
    invalidCases[0] = {
      ...invalidCases[0]!,
      reason: "unknown-reason" as never,
    };

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        cases: invalidCases,
      }),
    ).toThrow("invalid cases");
  });

  it("rejects non-integer passedCases", async () => {
    const report = await runAsfQualificationMatrix(githubInput(), async () => ({
      status: "passed",
    }));

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        passedCases: 1.5,
      }),
    ).toThrow("passedCases must be an integer");
  });

  it("rejects non-integer failedCases", async () => {
    const report = await runAsfQualificationMatrix(githubInput(), async () => ({
      status: "passed",
    }));

    expect(() =>
      verifyAsfQualificationExecutionReport({
        ...report,
        failedCases: "0" as never,
      }),
    ).toThrow("failedCases must be an integer");
  });

  it("deeply freezes the verified report", async () => {
    const report = await runAsfQualificationMatrix(
      input("process-cold-start"),
      async () => ({ status: "passed" }),
    );

    const verified = verifyAsfQualificationExecutionReport(report);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.cases)).toBe(true);
    expect(Object.isFrozen(verified.cases[0])).toBe(true);
    expect(Object.isFrozen(verified.cases[0]!.case)).toBe(true);
    expect(Object.isFrozen(verified.blockedReasons)).toBe(true);
  });
});
