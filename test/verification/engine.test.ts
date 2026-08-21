import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerificationEngine, type CheckSpec } from "../../src/verification/engine.js";
import { validateReportContent } from "../../src/verification/report.js";
import {
  Sandbox,
  type SandboxResult,
  type SandboxRunInput,
} from "../../src/workspace/sandbox.js";
import type { Workspace, WorkspaceManager } from "../../src/workspace/manager.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runmill-engine-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const workspace: Workspace = {
  runId: "run_1",
  path: "/unused/run",
  branch: "runmill/test",
  baseCommit: "base",
  isolation: "clone",
  writablePaths: ["/unused/run"],
};

function workspaces(): WorkspaceManager {
  return {
    createVerificationCheckout: async (_workspace: Workspace, sha: string) => {
      const path = join(dir, sha);
      mkdirSync(path, { recursive: true });
      return path;
    },
    destroyVerificationCheckout: async () => undefined,
    treeHash: async () => "same-tree",
  } as unknown as WorkspaceManager;
}

function sandbox(afterRun?: (cwd: string) => void): Sandbox {
  return {
    run: async (input: SandboxRunInput): Promise<SandboxResult> => {
      afterRun?.(input.cwd);
      return {
        outcome: "exited",
        exitCode: 0,
        signal: null,
        stdout: "1 passed",
        stderr: "",
        durationMs: 1,
      };
    },
  } as unknown as Sandbox;
}

function check(report?: CheckSpec["report"]): CheckSpec {
  return {
    id: "unit",
    run: "test-command",
    required: true,
    source: "repository-policy",
    ...(report === undefined ? {} : { report }),
  };
}

async function run(
  spec: CheckSpec,
  writeReport?: (cwd: string) => void,
  failOnSkippedCheck?: boolean,
) {
  return new VerificationEngine(sandbox(writeReport)).run({
    workspace,
    workspaces: workspaces(),
    manifest: [spec],
    candidateSha: "candidate",
    ...(failOnSkippedCheck === undefined ? {} : { failOnSkippedCheck }),
  });
}

describe("VerificationEngine coverage proof", () => {
  it("refuses an empty effective manifest instead of treating zero checks as a pass", async () => {
    let executed = false;
    const neverRun = {
      run: async (): Promise<SandboxResult> => {
        executed = true;
        throw new Error("verification must not execute");
      },
    } as unknown as Sandbox;

    await expect(
      new VerificationEngine(neverRun).run({
        workspace,
        workspaces: {} as WorkspaceManager,
        manifest: [],
        candidateSha: "candidate",
      }),
    ).rejects.toMatchObject({ code: "RM-VERIFY-001" });
    expect(executed).toBe(false);
  });

  it("requires the verification checkout Git metadata to remain read-only", async () => {
    let observed: SandboxRunInput | undefined;
    const capture = {
      run: async (input: SandboxRunInput): Promise<SandboxResult> => {
        observed = input;
        return {
          outcome: "exited",
          exitCode: 0,
          signal: null,
          stdout: "1 passed",
          stderr: "",
          durationMs: 1,
        };
      },
    } as unknown as Sandbox;

    await new VerificationEngine(capture).run({
      workspace,
      workspaces: workspaces(),
      manifest: [check()],
      candidateSha: "candidate",
    });

    expect(observed?.policy.protectedPaths).toEqual([join(dir, "candidate", ".git")]);
    expect(observed?.policy.writablePaths).toEqual([]);
    expect(observed?.policy.readablePaths).toEqual([join(dir, "candidate")]);
  });

  it("keeps prepared dependencies read-only while the verification tree is writable", async () => {
    let observed: SandboxRunInput | undefined;
    const modules = join(dir, "candidate", "node_modules");
    const capture = {
      run: async (input: SandboxRunInput): Promise<SandboxResult> => {
        observed = input;
        return {
          outcome: "exited",
          exitCode: 0,
          signal: null,
          stdout: "1 passed",
          stderr: "",
          durationMs: 1,
        };
      },
    } as unknown as Sandbox;
    const manager = {
      ...workspaces(),
      verificationDependencyPath: (checkout: string) => join(checkout, "node_modules"),
    } as unknown as WorkspaceManager;

    await new VerificationEngine(capture).run({
      workspace,
      workspaces: manager,
      manifest: [check()],
      candidateSha: "candidate",
    });

    expect(observed?.policy.writablePaths).toEqual([]);
    expect(observed?.policy.protectedPaths).toEqual([
      join(dir, "candidate", ".git"),
      modules,
    ]);
    expect(observed?.policy.allowNetwork).toBe(false);
  });

  it("refuses a required passing check with no report under the default policy", async () => {
    const outcome = await run(check());

    expect(outcome.results[0]).toMatchObject({ status: "passed", coverage: "unproven" });
    expect(outcome.mergeReady).toBe(false);
    expect(outcome.failures).toContain('required check "unit" has unproven coverage');
  });

  it("allows an explicitly relaxed policy to retain honest unproven evidence", async () => {
    const outcome = await run(check(), undefined, false);

    expect(outcome.results[0]).toMatchObject({ status: "passed", coverage: "unproven" });
    expect(outcome.mergeReady).toBe(true);
  });

  it("refuses when a declared report is missing", async () => {
    const outcome = await run(check({ path: "report.tap", format: "tap" }));

    expect(outcome.results[0]?.notes.join(" ")).toMatch(/report is empty/i);
    expect(outcome.results[0]?.coverage).toBe("unproven");
    expect(outcome.mergeReady).toBe(false);
  });

  it("refuses when a declared report is malformed", async () => {
    const outcome = await run(
      check({ path: "report.tap", format: "tap" }),
      (cwd) => writeFileSync(join(cwd, "report.tap"), "TAP version 13\n"),
    );

    expect(outcome.results[0]?.notes.join(" ")).toMatch(/no test plan/i);
    expect(outcome.results[0]?.coverage).toBe("unproven");
    expect(outcome.mergeReady).toBe(false);
    expect(existsSync(join(dir, "candidate", "report.tap"))).toBe(false);
  });

  it("accepts a newly generated parseable report and removes only that artifact", async () => {
    const outcome = await run(
      check({ path: "report.tap", format: "tap" }),
      (cwd) =>
        writeFileSync(join(cwd, "report.tap"), "TAP version 13\n1..1\nok 1 - unit\n"),
    );

    expect(outcome.results[0]).toMatchObject({ status: "passed", coverage: "proven" });
    expect(outcome.mergeReady).toBe(true);
    expect(existsSync(join(dir, "candidate", "report.tap"))).toBe(false);
  });

  it("refuses a pre-existing report because it may be stale", async () => {
    const manager = {
      createVerificationCheckout: async (_workspace: Workspace, sha: string) => {
        const path = join(dir, sha);
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "report.tap"), "TAP version 13\n1..1\nok 1 - unit\n");
        return path;
      },
      destroyVerificationCheckout: async () => undefined,
      treeHash: async () => "same-tree",
    } as unknown as WorkspaceManager;
    const outcome = await new VerificationEngine(sandbox()).run({
      workspace,
      workspaces: manager,
      manifest: [check({ path: "report.tap", format: "tap" })],
      candidateSha: "candidate",
    });

    expect(outcome.results[0]?.notes.join(" ")).toMatch(/existed before/i);
    expect(outcome.results[0]?.coverage).toBe("unproven");
    expect(outcome.mergeReady).toBe(false);
  });

  it("refuses a report that contradicts the process's successful exit", async () => {
    const outcome = await run(
      check({ path: "report.tap", format: "tap" }),
      (cwd) => writeFileSync(join(cwd, "report.tap"), "TAP version 13\n1..1\nnot ok 1 - unit\n"),
    );

    expect(outcome.results[0]).toMatchObject({ status: "failed", coverage: "proven" });
    expect(outcome.failures.join(" ")).toMatch(/report contains a failed test/i);
    expect(outcome.mergeReady).toBe(false);
  });

  it("runs the same sandbox and read-only dependency policy at base, then candidate", async () => {
    const observed: SandboxRunInput[] = [];
    const capture = {
      run: async (input: SandboxRunInput): Promise<SandboxResult> => {
        observed.push(input);
        writeFileSync(join(input.cwd, "report.tap"), "TAP version 13\n1..1\nok 1 - unit\n");
        return {
          outcome: "exited",
          exitCode: 0,
          signal: null,
          stdout: "1 passed",
          stderr: "",
          durationMs: 1,
        };
      },
    } as unknown as Sandbox;
    const manager = {
      ...workspaces(),
      verificationDependencyPath: (checkout: string) => join(checkout, "node_modules"),
    } as unknown as WorkspaceManager;

    const outcome = await new VerificationEngine(capture).run({
      workspace,
      workspaces: manager,
      manifest: [check({ path: "report.tap", format: "tap" })],
      candidateSha: "candidate",
    });

    expect(observed.map((input) => input.cwd)).toEqual([
      join(dir, "base"),
      join(dir, "candidate"),
    ]);
    for (const input of observed) {
      expect(input.policy).toEqual({
        writablePaths: [],
        writableFiles: [join(realpathSync(input.cwd), "report.tap")],
        readablePaths: [input.cwd],
        protectedPaths: [join(input.cwd, ".git"), join(input.cwd, "node_modules")],
        allowNetwork: false,
      });
    }
    expect(outcome.mergeReady).toBe(true);
  });
});

function tapReport(
  tests: readonly { readonly id: string; readonly status: "passed" | "failed" | "skipped" }[],
): string {
  return [
    "TAP version 13",
    `1..${tests.length}`,
    ...tests.map((test, index) => {
      const prefix = test.status === "failed" ? "not ok" : "ok";
      const directive = test.status === "skipped" ? " # SKIP declared reason" : "";
      return `${prefix} ${index + 1} - ${test.id}${directive}`;
    }),
    "",
  ].join("\n");
}

async function compareTap(input: {
  readonly base: string;
  readonly candidate: string;
  readonly declared?: readonly { readonly testId: string; readonly cause: string }[];
  readonly baseExitCode?: number;
  readonly manager?: WorkspaceManager;
}) {
  const provider = {
    run: async (request: SandboxRunInput): Promise<SandboxResult> => {
      const baseline = request.cwd === join(dir, "base");
      writeFileSync(join(request.cwd, "report.tap"), baseline ? input.base : input.candidate);
      return {
        outcome: "exited",
        exitCode: baseline ? (input.baseExitCode ?? 0) : 0,
        signal: null,
        stdout: "tests complete",
        stderr: "",
        durationMs: 1,
      };
    },
  } as unknown as Sandbox;
  return new VerificationEngine(provider).run({
    workspace,
    workspaces: input.manager ?? workspaces(),
    manifest: [
      {
        ...check({ path: "report.tap", format: "tap" }),
        ...(input.declared === undefined ? {} : { declaredSkips: input.declared }),
      },
    ],
    candidateSha: "candidate",
  });
}

describe("base-to-candidate test identity proof", () => {
  const passed = (id: string) => ({ id, status: "passed" as const });
  const skipped = (id: string) => ({ id, status: "skipped" as const });

  it("refuses a declaration for A when the candidate skipped B", async () => {
    const outcome = await compareTap({
      base: tapReport([passed("A"), passed("B")]),
      candidate: tapReport([passed("A"), skipped("B")]),
      declared: [{ testId: "A", cause: "tracked" }],
    });

    expect(outcome.mergeReady).toBe(false);
    expect(outcome.failures.join(" ")).toMatch(/not declared.*"B"/i);
    expect(outcome.failures.join(" ")).toMatch(/did not exactly match.*"A"/i);
  });

  it("refuses when a base-passing test disappears", async () => {
    const outcome = await compareTap({
      base: tapReport([passed("A"), passed("B")]),
      candidate: tapReport([passed("A")]),
    });

    expect(outcome.mergeReady).toBe(false);
    expect(outcome.failures.join(" ")).toMatch(/absent test id.*"B"/i);
  });

  it.each(["absent", "skipped"] as const)(
    "allows an exact per-check declaration for a %s base-passing test",
    async (kind) => {
      const outcome = await compareTap({
        base: tapReport([passed("A"), passed("B")]),
        candidate: tapReport([passed("A"), ...(kind === "skipped" ? [skipped("B")] : [])]),
        declared: [{ testId: "B", cause: "tracked in ENG-88" }],
      });

      expect(outcome.mergeReady).toBe(true);
    },
  );

  it("refuses a stale declaration even when every test passes", async () => {
    const report = tapReport([passed("A")]);
    const outcome = await compareTap({
      base: report,
      candidate: report,
      declared: [{ testId: "A", cause: "stale" }],
    });

    expect(outcome.mergeReady).toBe(false);
    expect(outcome.failures.join(" ")).toMatch(/did not exactly match candidate exceptions/i);
  });

  it("does not let a declaration for one check affect another check", async () => {
    const provider = {
      run: async (request: SandboxRunInput): Promise<SandboxResult> => {
        const isUnit = request.command === "unit-command";
        const isBase = request.cwd === join(dir, "base");
        const path = join(request.cwd, isUnit ? "unit.tap" : "e2e.tap");
        writeFileSync(
          path,
          isUnit
            ? tapReport([passed("A"), ...(isBase ? [passed("B")] : [skipped("B")])])
            : tapReport([passed("A")]),
        );
        return {
          outcome: "exited",
          exitCode: 0,
          signal: null,
          stdout: "tests complete",
          stderr: "",
          durationMs: 1,
        };
      },
    } as unknown as Sandbox;
    const outcome = await new VerificationEngine(provider).run({
      workspace,
      workspaces: workspaces(),
      manifest: [
        {
          ...check({ path: "unit.tap", format: "tap" }),
          id: "unit",
          run: "unit-command",
          declaredSkips: [{ testId: "B", cause: "unit only" }],
        },
        {
          ...check({ path: "e2e.tap", format: "tap" }),
          id: "e2e",
          run: "e2e-command",
        },
      ],
      candidateSha: "candidate",
    });

    expect(outcome.mergeReady).toBe(true);
  });

  it("fails closed when the baseline report is malformed", async () => {
    const outcome = await compareTap({
      base: "TAP version 13\n",
      candidate: tapReport([passed("A")]),
    });

    expect(outcome.mergeReady).toBe(false);
    expect(outcome.failures.join(" ")).toMatch(/RM-VERIFY-003.*baseline.*no test plan/i);
  });

  it("fails closed when the baseline mutates its checkout", async () => {
    const hashes = new Map<string, number>();
    const manager = {
      ...workspaces(),
      treeHash: async (checkout: Workspace) => {
        const count = hashes.get(checkout.path) ?? 0;
        hashes.set(checkout.path, count + 1);
        return checkout.path === join(dir, "base") ? `base-${count}` : "candidate";
      },
    } as unknown as WorkspaceManager;
    const report = tapReport([passed("A")]);
    const outcome = await compareTap({ base: report, candidate: report, manager });

    expect(outcome.mergeReady).toBe(false);
    expect(outcome.failures.join(" ")).toMatch(/RM-VERIFY-003.*baseline tree changed/i);
  });

  it("uses a valid baseline inventory even when the old command exited nonzero", async () => {
    const report = tapReport([passed("A")]);
    const outcome = await compareTap({ base: report, candidate: report, baseExitCode: 1 });

    expect(outcome.mergeReady).toBe(true);
    expect(outcome.results[0]?.notes.join(" ")).toMatch(/baseline inventory: 1 passed/i);
  });

  it.runIf(new Sandbox().mechanism !== "none")(
    "denies a malicious source mutate-and-restore attempt instead of trusting only hashes",
    async () => {
      const manager = {
        createVerificationCheckout: async (_workspace: Workspace, sha: string) => {
          const path = join(dir, sha);
          mkdirSync(join(path, ".git"), { recursive: true });
          writeFileSync(join(path, "source.txt"), "trusted");
          const script = join(path, "mutate-restore.sh");
          writeFileSync(
            script,
            [
              "#!/bin/sh",
              "if printf attacker > source.txt 2>/dev/null; then",
              "  printf trusted > source.txt",
              "  printf 'TAP version 13\\n1..1\\nok 1 - forged\\n' > report.tap",
              "  exit 0",
              "fi",
              "printf 'TAP version 13\\n1..1\\nok 1 - denied\\n' > report.tap",
              "exit 77",
              "",
            ].join("\n"),
          );
          chmodSync(script, 0o755);
          return path;
        },
        destroyVerificationCheckout: async () => undefined,
        treeHash: async (checkout: Workspace) => readFileSync(join(checkout.path, "source.txt"), "utf8"),
      } as unknown as WorkspaceManager;

      const outcome = await new VerificationEngine().run({
        workspace,
        workspaces: manager,
        manifest: [
          {
            ...check({ path: "report.tap", format: "tap" }),
            run: "./mutate-restore.sh",
          },
        ],
        candidateSha: "candidate",
      });

      expect(outcome.mergeReady).toBe(false);
      expect(outcome.results[0]).toMatchObject({ exitCode: 77, status: "failed" });
      expect(readFileSync(join(dir, "candidate", "source.txt"), "utf8")).toBe("trusted");
    },
  );
});

describe("machine-readable report formats", () => {
  it.each([
    ["junit", '<testsuite tests="1"><testcase name="unit"/></testsuite>'],
    ["tap", "TAP version 13\n1..1\nok 1 - unit\n"],
    [
      "go-json",
      '{"Time":"2026-01-01T00:00:00Z","Action":"run","Package":"x","Test":"TestUnit"}\n' +
        '{"Time":"2026-01-01T00:00:01Z","Action":"pass","Package":"x","Test":"TestUnit"}\n',
    ],
  ])("parses %s", (format, source) => {
    expect(validateReportContent(format, source).valid).toBe(true);
  });

  it.each([
    [
      "junit",
      '<testsuite><testcase classname="pkg.C" name="passes"/>' +
        '<testcase classname="pkg.C" name="waits"><skipped/></testcase>' +
        '<testcase classname="pkg.C" name="breaks"><failure/></testcase></testsuite>',
      [
        { id: "pkg.C::passes", status: "passed" },
        { id: "pkg.C::waits", status: "skipped" },
        { id: "pkg.C::breaks", status: "failed" },
      ],
    ],
    [
      "tap",
      "TAP version 13\n1..3\nok 1 - passes\nok 2 - waits # SKIP later\nnot ok 3 - breaks\n",
      [
        { id: "passes", status: "passed" },
        { id: "waits", status: "skipped" },
        { id: "breaks", status: "failed" },
      ],
    ],
    [
      "go-json",
      '{"Action":"pass","Package":"example/a","Test":"TestPasses"}\n' +
        '{"Action":"skip","Package":"example/a","Test":"TestWaits"}\n' +
        '{"Action":"fail","Package":"example/a","Test":"TestBreaks"}\n',
      [
        { id: "example/a::TestPasses", status: "passed" },
        { id: "example/a::TestWaits", status: "skipped" },
        { id: "example/a::TestBreaks", status: "failed" },
      ],
    ],
  ])("extracts exact identities and status from %s", (format, source, expected) => {
    expect(validateReportContent(format, source).tests).toEqual(expected);
  });

  it.each([
    [
      "junit",
      '<testsuite><testcase name="same"/><testcase name="same"/></testsuite>',
    ],
    ["tap", "TAP version 13\n1..2\nok 1 - same\nok 2 - same\n"],
    [
      "go-json",
      '{"Action":"pass","Package":"x","Test":"Same"}\n' +
        '{"Action":"pass","Package":"x","Test":"Same"}\n',
    ],
  ])("rejects duplicate test ids in %s", (format, source) => {
    expect(validateReportContent(format, source)).toMatchObject({ valid: false, tests: [] });
    expect(validateReportContent(format, source).detail).toMatch(/duplicate test id/i);
  });

  it.each([
    ["junit", '<testsuite><testcase name=""/></testsuite>'],
    ["tap", "TAP version 13\n1..1\nok 1\n"],
    ["go-json", '{"Action":"pass","Package":"x","Test":""}\n'],
  ])("rejects empty test ids in %s", (format, source) => {
    expect(validateReportContent(format, source).detail).toMatch(/empty test id/i);
  });

  it.each([
    ["junit", "<testsuite>"],
    ["tap", "TAP version 13\n"],
    ["go-json", "not-json\n"],
  ])("rejects malformed %s", (format, source) => {
    expect(validateReportContent(format, source).valid).toBe(false);
  });

  it("rejects generic JSON because it has no defined test-result schema", () => {
    expect(validateReportContent("json", '{"tests":[{"status":"failed"}]}')).toMatchObject({
      valid: false,
      failed: false,
    });
  });
});
