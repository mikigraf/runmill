/**
 * The real provider adapter.
 *
 * Everything here is parsing output from a program runmill does not control,
 * which updates itself independently. The load-bearing property is that an
 * unrecognised shape STOPS the run: misreading a tool call or a terminal
 * result is worse than stopping, so nothing gets a best-effort interpretation.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CliProviderAdapter,
  CODEX_DIALECT,
  CLAUDE_DIALECT,
  BASE_CAPABILITIES,
  defaultPrompt,
} from "../../src/agent/cli-provider.js";
import { ResumeNotPermittedError } from "../../src/agent/adapter.js";
import { UnknownEventError } from "../../src/agent/events.js";
import { outputPathFor } from "../../src/agent/output-contract.js";
import type { AgentRunRequest } from "../../src/agent/adapter.js";

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    runId: "run_1",
    issueId: "ENG-101",
    role: "implementer",
    attempt: 1,
    workingDirectory: "/tmp/ws",
    taskPacketPath: "/tmp/ws/.runmill/run/task.json",
    allowedPaths: ["src/"],
    forbiddenPaths: [".runmill/**"],
    allowedCommands: [],
    network: "none",
    maxTurns: 40,
    timeoutMs: 60_000,
    ...overrides,
  };
}

describe("dialect definitions", () => {
  it("declares capabilities per dialect rather than switching on a name", () => {
    // The adapter must never branch on "is this codex"; behavior differences
    // belong in the dialect, where they are visible and testable.
    expect(CODEX_DIALECT.capabilities.sessionResume).toBe(false);
    expect(CLAUDE_DIALECT.capabilities.sessionResume).toBe(true);
    expect(CLAUDE_DIALECT.capabilities.costReporting).toBe(true);
    expect(BASE_CAPABILITIES.structuredOutput).toBe(true);
  });

  it("declares the config paths each provider needs to authenticate", () => {
    // Guessed from the name, a wrong path is an auth failure inside a sandbox
    // with nothing pointing at the profile as the cause.
    expect(CODEX_DIALECT.configPaths("/home/x")).toContain("/home/x/.codex");
    expect(CLAUDE_DIALECT.configPaths("/home/x")).toContain("/home/x/.claude");
  });

  it("never passes --dangerously-skip-permissions", () => {
    // Permissions are granted explicitly and narrowly; runmill's sandbox is the
    // enforcement layer, and disabling the provider's own guard outside it
    // would remove the only backstop.
    const args = CLAUDE_DIALECT.buildArgs(request(), "do the thing").join(" ");
    expect(args).not.toContain("dangerously-skip-permissions");
    expect(args).toContain("--allowedTools");
  });

  it("passes the turn limit through to the provider", () => {
    const args = CLAUDE_DIALECT.buildArgs(request({ maxTurns: 7 }), "p");
    expect(args).toContain("7");
  });

  it("does not ask codex to sandbox itself, because runmill already did", () => {
    // Seatbelt does not nest. Codex's own profile inside runmill's leaves it
    // unable to write anywhere while still exiting 0, so runmill saw a
    // successful agent that had changed nothing and spent every fix iteration
    // re-running it. runmill's sandbox is the mandatory enforcement layer.
    const args = CODEX_DIALECT.buildArgs(request(), "p");

    expect(args).not.toContain("workspace-write");
    expect(args.join(" ")).toContain("-s danger-full-access");
  });

  it("runs codex in the workspace it was given", () => {
    const args = CODEX_DIALECT.buildArgs(request({ workingDirectory: "/ws/abc" }), "p");
    expect(args).toContain("/ws/abc");
    expect(args).toContain("--json");
  });
});

describe("authentication detection", () => {
  it("treats codex exit 0 without a 'not logged in' message as authenticated", () => {
    expect(CODEX_DIALECT.isAuthenticated("Logged in as x", "", 0)).toBe(true);
  });

  it("treats an explicit codex 'not logged in' as unauthenticated even on exit 0", () => {
    // Exit codes are not a reliable auth signal across provider versions.
    expect(CODEX_DIALECT.isAuthenticated("not logged in", "", 0)).toBe(false);
    expect(CODEX_DIALECT.isAuthenticated("", "unauthenticated", 0)).toBe(false);
  });

  it("treats a nonzero codex exit as unauthenticated", () => {
    expect(CODEX_DIALECT.isAuthenticated("", "", 1)).toBe(false);
  });

  it("detects claude auth failures by message", () => {
    expect(CLAUDE_DIALECT.isAuthenticated("", "invalid api key", 1)).toBe(false);
    expect(CLAUDE_DIALECT.isAuthenticated("", "not logged in", 1)).toBe(false);
    expect(CLAUDE_DIALECT.isAuthenticated("pong", "", 0)).toBe(true);
  });
});

describe("mapLine — codex", () => {
  it("normalizes session start, message, and completion", () => {
    expect(CODEX_DIALECT.mapLine({ type: "task_started" })).toEqual({ type: "session.started" });
    expect(CODEX_DIALECT.mapLine({ msg: { type: "agent_message", message: "hi" } })).toEqual({
      type: "assistant.message",
      text: "hi",
    });
    expect(CODEX_DIALECT.mapLine({ type: "task_complete" })).toMatchObject({
      type: "result",
      status: "success",
    });
  });

  it("maps a provider error to a non-retryable internal error", () => {
    expect(CODEX_DIALECT.mapLine({ type: "error" })).toMatchObject({
      type: "error",
      class: "provider_internal",
      retryable: false,
    });
  });

  it("returns undefined for a line with no normalized meaning", () => {
    // Undefined means "carries nothing", which is different from "unknown and
    // therefore dangerous" — the stream is full of noise lines.
    expect(CODEX_DIALECT.mapLine({ type: "token_count" })).toBeUndefined();
    expect(CODEX_DIALECT.mapLine({})).toBeUndefined();
  });

  it("prefers the nested msg discriminant over the outer type", () => {
    expect(CODEX_DIALECT.mapLine({ type: "item", msg: { type: "task_started" } })).toEqual({
      type: "session.started",
    });
  });
});

describe("mapLine — claude", () => {
  it("treats only the init subtype as a session start", () => {
    expect(CLAUDE_DIALECT.mapLine({ type: "system", subtype: "init" })).toEqual({
      type: "session.started",
    });
    expect(CLAUDE_DIALECT.mapLine({ type: "system", subtype: "other" })).toBeUndefined();
  });

  it("concatenates the text blocks of an assistant message and drops non-text", () => {
    expect(
      CLAUDE_DIALECT.mapLine({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "part one " },
            { type: "tool_use" },
            { type: "text", text: "part two" },
          ],
        },
      }),
    ).toEqual({ type: "assistant.message", text: "part one part two" });
  });

  it("ignores an assistant message with no text at all", () => {
    expect(
      CLAUDE_DIALECT.mapLine({ type: "assistant", message: { content: [{ type: "tool_use" }] } }),
    ).toBeUndefined();
  });

  it("carries is_error through to the result status", () => {
    // A failed run reported as success would let verification run against a
    // tree the agent never finished.
    expect(CLAUDE_DIALECT.mapLine({ type: "result", is_error: true })).toMatchObject({
      status: "failure",
    });
    expect(CLAUDE_DIALECT.mapLine({ type: "result" })).toMatchObject({ status: "success" });
  });

  it("maps usage, including cost when the provider reports it", () => {
    expect(
      CLAUDE_DIALECT.mapLine({
        type: "usage",
        usage: { input_tokens: 100, output_tokens: 20 },
        total_cost_usd: 0.42,
      }),
    ).toMatchObject({ type: "usage.updated", inputTokens: 100, outputTokens: 20, costUsd: 0.42 });
  });

  it("defaults token counts rather than emitting NaN", () => {
    expect(CLAUDE_DIALECT.mapLine({ type: "usage", usage: {} })).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("defaultPrompt", () => {
  it("points the agent at the task packet rather than inlining the issue", () => {
    // The packet is the bounded context; a prompt that restates it invites
    // divergence between what the agent reads and what runmill verified.
    const prompt = defaultPrompt(request());
    expect(prompt).toContain("/tmp/ws/.runmill/run/task.json");
  });

  it("names the role, so the same binary behaves differently per stage", () => {
    expect(defaultPrompt(request({ role: "local-reviewer" }))).toMatch(/review/i);
  });
});

describe("CliProviderAdapter", () => {
  const adapter = (dialect = CODEX_DIALECT): CliProviderAdapter =>
    new CliProviderAdapter({ dialect });

  it("takes its name from the dialect", () => {
    expect(adapter().name).toBe("codex");
    expect(adapter(CLAUDE_DIALECT).name).toBe("claude");
  });

  it("reports not-installed for a binary that does not exist", async () => {
    const missing = { ...CODEX_DIALECT, binary: "definitely-not-installed-xyz" };
    expect(await new CliProviderAdapter({ dialect: missing }).detect()).toEqual({
      installed: false,
    });
  });

  it("reports unauthenticated, with detail, when the binary is absent", async () => {
    const missing = { ...CODEX_DIALECT, binary: "definitely-not-installed-xyz" };
    const status = await new CliProviderAdapter({ dialect: missing }).authStatus();
    expect(status.authenticated).toBe(false);
  });

  it("exposes the dialect's capabilities", async () => {
    expect((await adapter(CLAUDE_DIALECT).capabilities()).sessionResume).toBe(true);
  });

  it("refuses to resume any role but the implementer", async () => {
    // Resume replays prior context, which would silently destroy reviewer
    // independence — the property the whole review stage depends on.
    for (const role of ["local-reviewer", "pr-reviewer", "fixer"] as const) {
      await expect(
        adapter().resume({ ...request({ role }), sessionId: "s1" }),
      ).rejects.toBeInstanceOf(ResumeNotPermittedError);
    }
  });

  it("names the offending role in the resume refusal", async () => {
    const err = await adapter()
      .resume({ ...request({ role: "pr-reviewer" }), sessionId: "s1" })
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain("pr-reviewer");
    expect((err as Error).message).toMatch(/reviewer independence/);
  });
});

describe("detect against a real binary", () => {
  it("reads the first line of --version output", async () => {
    // Providers print banners and update notices; only the first line is the
    // version, and keeping the rest would make the doctor line unreadable.
    const dir = mkdtempSync(join(tmpdir(), "runmill-fakebin-"));
    const bin = join(dir, "fakeprovider");
    writeFileSync(bin, "#!/bin/sh\necho 'fake-cli 9.9.9'\necho 'update available'\n");
    chmodSync(bin, 0o755);

    try {
      const dialect = { ...CODEX_DIALECT, binary: bin };
      const installation = await new CliProviderAdapter({ dialect }).detect();
      expect(installation.installed).toBe(true);
      expect(installation.version).toBe("fake-cli 9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks the version on every invocation, because these CLIs self-update", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runmill-fakebin-"));
    const bin = join(dir, "fakeprovider");
    writeFileSync(bin, "#!/bin/sh\necho 'v1'\n");
    chmodSync(bin, 0o755);
    try {
      const dialect = { ...CODEX_DIALECT, binary: bin };
      const a = new CliProviderAdapter({ dialect });
      expect((await a.detect()).version).toBe("v1");

      writeFileSync(bin, "#!/bin/sh\necho 'v2'\n");
      expect((await a.detect()).version).toBe("v2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The streaming path, against a real subprocess.
 *
 * A fake binary emits the JSONL a provider would, so this exercises spawn,
 * chunked parsing, the sandbox wrapper, timeout handling, and result
 * classification rather than mocking them away.
 */
describe("sandbox policy", () => {
  /** Captures the policy the adapter asks for, without running anything. */
  function capturingSandbox(): { calls: { command: string; policy: Record<string, unknown> }[]; wrap: unknown } {
    const calls: { command: string; policy: Record<string, unknown> }[] = [];
    return {
      calls,
      wrap: (input: { command: string; args: string[]; cwd: string; policy: Record<string, unknown> }) => {
        calls.push({ command: input.command, policy: input.policy });
        return { command: "/usr/bin/true", args: [], cwd: input.cwd, env: {}, cleanup: () => undefined };
      },
    };
  }

  /** A HOME that actually has the provider's config directory in it. */
  function withProviderHome<T>(run: () => Promise<T>): Promise<T> {
    const home = mkdtempSync(join(tmpdir(), "runmill-home-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    const previous = process.env["HOME"];
    process.env["HOME"] = home;
    return run().finally(() => {
      if (previous === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previous;
      rmSync(home, { recursive: true, force: true });
    });
  }

  it("gives the provider write access to its own config directory", async () => {
    // codex and claude keep session state and history there and refuse to
    // start without write access. Read-only made codex fail with "failed to
    // initialize in-process app-server client" before emitting any event.
    const sandbox = capturingSandbox();
    await withProviderHome(async () => {
      const adapter = new CliProviderAdapter({
        dialect: CODEX_DIALECT,
        sandbox: { wrap: sandbox.wrap } as never,
      });
      await adapter.start(request({ workingDirectory: "/tmp/ws" }));
    });

    const writable = sandbox.calls[0]?.policy["writablePaths"] as string[];
    expect(writable.some((p) => p.endsWith("/.codex"))).toBe(true);
  });

  it("omits a config directory that is not installed, rather than binding it", async () => {
    // A writable bind is strict: bubblewrap aborts on a source that is not
    // there. A developer running only Codex has no ~/.claude, and naming it
    // would stop the run before the agent started.
    const sandbox = capturingSandbox();
    const home = mkdtempSync(join(tmpdir(), "runmill-home-"));
    const previous = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const adapter = new CliProviderAdapter({
        dialect: CODEX_DIALECT,
        sandbox: { wrap: sandbox.wrap } as never,
      });
      await adapter.start(request({ workingDirectory: "/tmp/ws" }));
    } finally {
      if (previous === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previous;
      rmSync(home, { recursive: true, force: true });
    }

    const writable = sandbox.calls[0]?.policy["writablePaths"] as string[];
    expect(writable).toEqual(["/tmp/ws"]);
  });

  it("still confines writes to the workspace and that directory", async () => {
    const sandbox = capturingSandbox();
    await withProviderHome(async () => {
      const adapter = new CliProviderAdapter({
        dialect: CODEX_DIALECT,
        sandbox: { wrap: sandbox.wrap } as never,
      });
      await adapter.start(request({ workingDirectory: "/tmp/ws" }));
    });

    const writable = sandbox.calls[0]?.policy["writablePaths"] as string[];
    expect(writable).toContain("/tmp/ws");
    expect(writable.every((p) => p === "/tmp/ws" || p.includes("/.codex"))).toBe(true);
  });
});

describe("start — streaming from a real process", () => {
  function fakeProvider(script: string): { dir: string; bin: string } {
    const dir = mkdtempSync(join(tmpdir(), "runmill-stream-"));
    const bin = join(dir, "fakeprovider");
    writeFileSync(bin, script);
    chmodSync(bin, 0o755);
    return { dir, bin };
  }

  /** A dialect wired to a fake binary, passing the prompt through unused. */
  function dialectFor(bin: string, overrides: Record<string, unknown> = {}) {
    return {
      ...CODEX_DIALECT,
      binary: bin,
      buildArgs: () => [],
      ...overrides,
    };
  }

  it("normalizes a JSONL stream into ordered events and a success result", async () => {
    const { dir, bin } = fakeProvider(
      `#!/bin/sh
echo '{"type":"task_started"}'
echo '{"msg":{"type":"agent_message","message":"working"}}'
echo '{"type":"task_complete"}'
exit 0
`,
    );
    try {
      const adapter = new CliProviderAdapter({ dialect: dialectFor(bin) });
      const session = await adapter.start(request({ workingDirectory: dir }));
      const result = await session.result;

      expect(result.status).toBe("success");
      expect(result.events.map((e) => e.type)).toEqual([
        "session.started",
        "assistant.message",
        "result",
      ]);
      // Sequence numbers are monotonic, so the log has a defined order.
      expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(await session.sessionId).toContain("run_1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("ignores interleaved human-readable output rather than treating it as an event", async () => {
    // Providers print banners and progress text alongside JSONL.
    const { dir, bin } = fakeProvider(
      `#!/bin/sh
echo 'Welcome to fake-cli!'
echo '{"type":"task_started"}'
echo 'thinking...'
echo '{"type":"task_complete"}'
exit 0
`,
    );
    try {
      const adapter = new CliProviderAdapter({ dialect: dialectFor(bin) });
      const result = await (await adapter.start(request({ workingDirectory: dir }))).result;
      expect(result.status).toBe("success");
      expect(result.events).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("reassembles events split across chunk boundaries", async () => {
    // stdout arrives in arbitrary chunks; a JSON object split mid-line must not
    // be dropped or half-parsed.
    const { dir, bin } = fakeProvider(
      `#!/bin/sh
printf '{"type":"task_st'
sleep 0.2
printf 'arted"}\\n{"type":"task_complete"}\\n'
exit 0
`,
    );
    try {
      const adapter = new CliProviderAdapter({ dialect: dialectFor(bin) });
      const result = await (await adapter.start(request({ workingDirectory: dir }))).result;
      expect(result.events.map((e) => e.type)).toEqual(["session.started", "result"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("FAILS CLOSED on an event shape the dialect does not recognise", async () => {
    // The load-bearing guarantee. Misreading a tool call or a terminal result
    // is worse than stopping, so an unknown discriminant quarantines the run
    // even though the process itself exited 0.
    const { dir, bin } = fakeProvider(
      `#!/bin/sh
echo '{"type":"task_started"}'
echo '{"type":"some_future_event"}'
echo '{"type":"task_complete"}'
exit 0
`,
    );
    try {
      const dialect = dialectFor(bin, {
        mapLine: (line: unknown) => {
          const l = line as { type?: string };
          if (l.type === "some_future_event") throw new UnknownEventError(l.type);
          return CODEX_DIALECT.mapLine(line);
        },
      });
      const result = await (
        await new CliProviderAdapter({ dialect }).start(request({ workingDirectory: dir }))
      ).result;

      expect(result.status).toBe("failure");
      expect(result.error?.class).toBe("provider_internal");
      // Not retryable: replaying will produce the same unknown shape.
      expect(result.error?.retryable).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("classifies a rate limit from stderr as retryable", async () => {
    const { dir, bin } = fakeProvider(
      `#!/bin/sh
echo 'rate limit exceeded, retry later' >&2
exit 1
`,
    );
    try {
      const result = await (
        await new CliProviderAdapter({ dialect: dialectFor(bin) }).start(
          request({ workingDirectory: dir }),
        )
      ).result;
      expect(result.status).toBe("failure");
      expect(result.error?.class).toBe("rate_limit");
      expect(result.error?.retryable).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("classifies an auth failure as NOT retryable", async () => {
    // Retrying an expired credential burns budget to reach the same answer.
    const { dir, bin } = fakeProvider(
      `#!/bin/sh
echo 'unauthorized: please login' >&2
exit 1
`,
    );
    try {
      const result = await (
        await new CliProviderAdapter({ dialect: dialectFor(bin) }).start(
          request({ workingDirectory: dir }),
        )
      ).result;
      expect(result.error?.class).toBe("auth");
      expect(result.error?.retryable).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports a timeout rather than a failure when the deadline expires", async () => {
    const { dir, bin } = fakeProvider(`#!/bin/sh\nsleep 30\n`);
    try {
      const result = await (
        await new CliProviderAdapter({ dialect: dialectFor(bin) }).start(
          request({ workingDirectory: dir, timeoutMs: 1_000 }),
        )
      ).result;
      expect(result.status).toBe("timeout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails, never succeeds, when the binary cannot be executed", async () => {
    // Note the shape: because the command is sandbox-wrapped, a missing binary
    // is a nonzero exit from the sandbox rather than a spawn error, so it lands
    // in the close handler and is classified from stderr. What matters is that
    // it never resolves as success — `detect()` is what turns "not installed"
    // into an actionable message before a run ever starts.
    const dialect = dialectFor("/nonexistent/provider/binary");
    const dir = mkdtempSync(join(tmpdir(), "runmill-stream-"));
    try {
      const result = await (
        await new CliProviderAdapter({ dialect }).start(request({ workingDirectory: dir }))
      ).result;
      expect(result.status).toBe("failure");
      expect(result.error).toBeDefined();
      expect(result.outputRef).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("resolves the session id even when the run fails before starting", async () => {
    // Callers await sessionId for logging; leaving it pending would hang them.
    const dialect = dialectFor("/nonexistent/provider/binary");
    const dir = mkdtempSync(join(tmpdir(), "runmill-stream-"));
    try {
      const session = await new CliProviderAdapter({ dialect }).start(
        request({ workingDirectory: dir }),
      );
      await session.result;
      expect(await session.sessionId).toContain("run_1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("replays the event stream through the async iterator", async () => {
    const { dir, bin } = fakeProvider(
      `#!/bin/sh\necho '{"type":"task_started"}'\necho '{"type":"task_complete"}'\nexit 0\n`,
    );
    try {
      const session = await new CliProviderAdapter({ dialect: dialectFor(bin) }).start(
        request({ workingDirectory: dir }),
      );
      const seen: string[] = [];
      for await (const event of session.events) seen.push(event.type);
      expect(seen).toEqual(["session.started", "result"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("cancels on an abort signal, even before the session has started", async () => {
    // The process handle is captured at spawn rather than derived from a
    // session id, so cancellation does not depend on the provider announcing
    // itself first.
    const { dir, bin } = fakeProvider(`#!/bin/sh\nsleep 30\n`);
    const controller = new AbortController();
    try {
      const session = await new CliProviderAdapter({ dialect: dialectFor(bin) }).start(
        request({ workingDirectory: dir, signal: controller.signal, timeoutMs: 20_000 }),
      );
      controller.abort();
      const result = await session.result;
      expect(result.status).toBe("cancelled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("picks up structured output written by a role whose contract expects it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runmill-stream-"));
    const bin = join(dir, "fakeprovider");
    const outPath = outputPathFor(dir, "local-reviewer") as string;
    writeFileSync(
      bin,
      `#!/bin/sh
mkdir -p "$(dirname '${outPath}')"
echo '{"verdict":"approved"}' > '${outPath}'
echo '{"type":"task_complete"}'
exit 0
`,
    );
    chmodSync(bin, 0o755);
    try {
      const result = await (
        await new CliProviderAdapter({ dialect: dialectFor(bin) }).start(
          request({ workingDirectory: dir, role: "local-reviewer" }),
        )
      ).result;
      expect(result.outputRef).toBe(outPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("leaves outputRef undefined when a role that owes output produced none", async () => {
    // The orchestrator turns this into RM-REVIEW-001 rather than treating a
    // missing review as an approval.
    const { dir, bin } = fakeProvider(`#!/bin/sh\necho '{"type":"task_complete"}'\nexit 0\n`);
    try {
      const result = await (
        await new CliProviderAdapter({ dialect: dialectFor(bin) }).start(
          request({ workingDirectory: dir, role: "local-reviewer" }),
        )
      ).result;
      expect(result.outputRef).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("model selection", () => {
  it("passes the model using each CLI's own flag", () => {
    // codex and claude spell it differently, so it belongs in the dialect
    // rather than in a branch inside the adapter.
    expect(CODEX_DIALECT.modelArgs("m1")).toEqual(["-m", "m1"]);
    expect(CLAUDE_DIALECT.modelArgs("m1")).toEqual(["--model", "m1"]);
  });

  it("reports the model in the adapter name, so two adapters are tellable apart", () => {
    const plain = new CliProviderAdapter({ dialect: CODEX_DIALECT });
    const pinned = new CliProviderAdapter({ dialect: CODEX_DIALECT, model: "m1" });
    expect(plain.name).toBe("codex");
    expect(pinned.name).toBe("codex:m1");
    expect(pinned.model).toBe("m1");
  });

  it("omits the flag entirely when no model is configured", async () => {
    // An empty or absent model must not become `-m ""`, which the CLI would
    // reject with a message about the wrong thing.
    const dir = mkdtempSync(join(tmpdir(), "runmill-model-"));
    const bin = join(dir, "fakeprovider");
    // The fake records the argv it received so the assertion is on real args.
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "argv")}"\necho '{"type":"task_complete"}'\n`);
    chmodSync(bin, 0o755);
    try {
      const dialect = { ...CODEX_DIALECT, binary: bin, buildArgs: () => ["exec"] };
      await (
        await new CliProviderAdapter({ dialect, model: "" }).start(
          request({ workingDirectory: dir }),
        )
      ).result;
      const argv = readFileSync(join(dir, "argv"), "utf8");
      expect(argv).not.toContain("-m");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
