#!/usr/bin/env bun
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { CapturedFrame } from "@opentui/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonControlServer, type RuntimePaths } from "../src/daemon/control.js";
import { runTui } from "../src/tui/app.js";
import type { RunRow } from "../src/state/store.js";

const output = resolve("assets/tui");
mkdirSync(output, { recursive: true });
const runtimeDirectory = mkdtempSync(join(tmpdir(), "runmill-tui-capture-"));
const paths: RuntimePaths = {
  directory: runtimeDirectory,
  registry: join(runtimeDirectory, "daemon.json"),
  socket: join(runtimeDirectory, "daemon.sock"),
};

const runs: RunRow[] = [
  {
    runId: "run_m2k9p3",
    issueId: "ENG-142",
    repo: "acme/platform",
    provider: "codex",
    state: "DISCOVERED",
    stateVersion: 1,
    attempt: 1,
    baseCommit: "8cb01d2",
    candidateSha: "7f4c9a1",
    branch: "runmill/eng-142-session-cache-1",
  },
  {
    runId: "run_m2j8d1",
    issueId: "ENG-139",
    repo: "acme/platform",
    provider: "claude",
    state: "PR_DELIVERED",
    stateVersion: 15,
    attempt: 1,
    baseCommit: "7d02b8a",
    candidateSha: "f114e8c",
    branch: "runmill/eng-139-health-endpoint-1",
  },
  {
    runId: "run_m2h4w7",
    issueId: "ENG-133",
    repo: "acme/web",
    provider: "codex",
    state: "COMPLETED",
    stateVersion: 18,
    attempt: 1,
    baseCommit: "118a0df",
    candidateSha: "95bd7c0",
    branch: "runmill/eng-133-empty-state-1",
  },
];

interface CaptureStage {
  readonly phase: "idle" | "running";
  readonly state: string;
  readonly stateVersion: number;
  readonly transitions: readonly { from: string; to: string; at: string }[];
  readonly events: readonly { seq: number; type: string; payload: unknown }[];
  readonly logs: readonly { at: string; level: "info"; message: string }[];
}

const captureStages: readonly CaptureStage[] = [
  {
    phase: "idle",
    state: "DISCOVERED",
    stateVersion: 1,
    transitions: [],
    events: [{ seq: 1, type: "issue.discovered", payload: { source: "linear", issue: "ENG-142" } }],
    logs: [
      { at: "2026-08-09T19:40:00Z", level: "info", message: "sleep inhibitor active: caffeinate" },
      { at: "2026-08-09T19:40:01Z", level: "info", message: "control socket ready; connect with runmill tui" },
      { at: "2026-08-09T19:40:02Z", level: "info", message: "watching Linear · next poll in 30s" },
    ],
  },
  {
    phase: "running",
    state: "CLAIMED",
    stateVersion: 3,
    transitions: [
      { from: "DISCOVERED", to: "ELIGIBILITY_CHECKED", at: "2026-08-09T19:40:04Z" },
      { from: "ELIGIBILITY_CHECKED", to: "CLAIMED", at: "2026-08-09T19:40:05Z" },
    ],
    events: [
      { seq: 1, type: "issue.discovered", payload: { source: "linear", issue: "ENG-142" } },
      { seq: 2, type: "lease.acquired", payload: { owner: "runmill", ttl: "30m" } },
    ],
    logs: [
      { at: "2026-08-09T19:40:00Z", level: "info", message: "sleep inhibitor active: caffeinate" },
      { at: "2026-08-09T19:40:01Z", level: "info", message: "control socket ready; connect with runmill tui" },
      { at: "2026-08-09T19:40:04Z", level: "info", message: "selected ENG-142 · Add bounded session cache" },
      { at: "2026-08-09T19:40:05Z", level: "info", message: "lease acquired · issue moved to In Progress" },
    ],
  },
  {
    phase: "running",
    state: "IMPLEMENTING",
    stateVersion: 6,
    transitions: [
      { from: "CLAIMED", to: "WORKSPACE_READY", at: "2026-08-09T19:40:08Z" },
      { from: "WORKSPACE_READY", to: "TASK_PACKET_READY", at: "2026-08-09T19:40:10Z" },
      { from: "TASK_PACKET_READY", to: "IMPLEMENTING", at: "2026-08-09T19:40:12Z" },
    ],
    events: [
      { seq: 3, type: "workspace.created", payload: { branch: "runmill/eng-142-session-cache-1" } },
      { seq: 4, type: "agent.started", payload: { provider: "codex", context: "new" } },
      { seq: 8, type: "agent.progress", payload: { filesChanged: 3, testsAdded: 4 } },
    ],
    logs: [
      { at: "2026-08-09T19:40:04Z", level: "info", message: "selected ENG-142 · Add bounded session cache" },
      { at: "2026-08-09T19:40:05Z", level: "info", message: "lease acquired · issue moved to In Progress" },
      { at: "2026-08-09T19:40:08Z", level: "info", message: "workspace ready · isolated git worktree" },
      { at: "2026-08-09T19:40:12Z", level: "info", message: "Codex implementing from a clean task packet" },
      { at: "2026-08-09T19:40:47Z", level: "info", message: "agent progress · 3 files changed · 4 tests added" },
    ],
  },
  {
    phase: "running",
    state: "LOCAL_VERIFY",
    stateVersion: 7,
    transitions: [
      { from: "TASK_PACKET_READY", to: "IMPLEMENTING", at: "2026-08-09T19:40:12Z" },
      { from: "IMPLEMENTING", to: "LOCAL_VERIFY", at: "2026-08-09T19:41:12Z" },
    ],
    events: [
      { seq: 9, type: "agent.completed", payload: { candidate: "7f4c9a1" } },
      { seq: 10, type: "check.completed", payload: { check: "typecheck", status: "passed" } },
      { seq: 11, type: "check.completed", payload: { check: "test", status: "passed", tests: 677 } },
      { seq: 12, type: "scope.checked", payload: { status: "passed", changedPaths: 3 } },
    ],
    logs: [
      { at: "2026-08-09T19:40:12Z", level: "info", message: "Codex implementing from a clean task packet" },
      { at: "2026-08-09T19:41:12Z", level: "info", message: "implementation complete · candidate 7f4c9a1" },
      { at: "2026-08-09T19:41:14Z", level: "info", message: "typecheck passed" },
      { at: "2026-08-09T19:41:38Z", level: "info", message: "677 tests passed" },
      { at: "2026-08-09T19:41:39Z", level: "info", message: "diff scope passed · 3 changed paths allowed" },
    ],
  },
  {
    phase: "running",
    state: "LOCAL_REVIEW",
    stateVersion: 8,
    transitions: [
      { from: "IMPLEMENTING", to: "LOCAL_VERIFY", at: "2026-08-09T19:41:12Z" },
      { from: "LOCAL_VERIFY", to: "LOCAL_REVIEW", at: "2026-08-09T19:42:07Z" },
    ],
    events: [
      { seq: 10, type: "check.completed", payload: { check: "typecheck", status: "passed" } },
      { seq: 11, type: "check.completed", payload: { check: "test", status: "passed", tests: 677 } },
      { seq: 13, type: "review.started", payload: { provider: "claude", context: "fresh" } },
      { seq: 14, type: "acceptance.checked", payload: { met: 4, total: 4 } },
    ],
    logs: [
      { at: "2026-08-09T19:41:14Z", level: "info", message: "typecheck passed" },
      { at: "2026-08-09T19:41:38Z", level: "info", message: "677 tests passed" },
      { at: "2026-08-09T19:41:39Z", level: "info", message: "diff scope passed · 3 changed paths allowed" },
      { at: "2026-08-09T19:42:07Z", level: "info", message: "fresh-context review started with Claude" },
      { at: "2026-08-09T19:42:44Z", level: "info", message: "review approved · 4/4 acceptance criteria met" },
    ],
  },
  {
    phase: "running",
    state: "PR_OPEN",
    stateVersion: 12,
    transitions: [
      { from: "LOCAL_REVIEW", to: "PR_READY", at: "2026-08-09T19:42:45Z" },
      { from: "PUSHED", to: "PR_OPEN", at: "2026-08-09T19:42:50Z" },
    ],
    events: [
      { seq: 14, type: "acceptance.checked", payload: { met: 4, total: 4 } },
      { seq: 15, type: "branch.pushed", payload: { sha: "7f4c9a1" } },
      { seq: 16, type: "pr.created", payload: { number: 284, url: "github.com/acme/platform/pull/284" } },
      { seq: 17, type: "ci.started", payload: { checks: 6 } },
    ],
    logs: [
      { at: "2026-08-09T19:42:07Z", level: "info", message: "fresh-context review started with Claude" },
      { at: "2026-08-09T19:42:44Z", level: "info", message: "review approved · 4/4 acceptance criteria met" },
      { at: "2026-08-09T19:42:47Z", level: "info", message: "pushed runmill/eng-142-session-cache-1" },
      { at: "2026-08-09T19:42:50Z", level: "info", message: "opened GitHub PR #284" },
      { at: "2026-08-09T19:42:51Z", level: "info", message: "waiting for 6 required CI checks" },
    ],
  },
  {
    phase: "idle",
    state: "PR_DELIVERED",
    stateVersion: 15,
    transitions: [
      { from: "PR_OPEN", to: "CI_WAIT", at: "2026-08-09T19:42:51Z" },
      { from: "CI_WAIT", to: "PR_DELIVERED", at: "2026-08-09T19:44:18Z" },
    ],
    events: [
      { seq: 16, type: "pr.created", payload: { number: 284 } },
      { seq: 18, type: "ci.completed", payload: { status: "passed", checks: 6 } },
      { seq: 19, type: "issue.updated", payload: { state: "In Review", pr: 284 } },
      { seq: 20, type: "run.completed", payload: { outcome: "pr_delivered" } },
    ],
    logs: [
      { at: "2026-08-09T19:42:50Z", level: "info", message: "opened GitHub PR #284" },
      { at: "2026-08-09T19:42:51Z", level: "info", message: "waiting for 6 required CI checks" },
      { at: "2026-08-09T19:44:18Z", level: "info", message: "CI passed · PR #284 delivered for human merge" },
      { at: "2026-08-09T19:44:19Z", level: "info", message: "ENG-142 moved to In Review · lease released" },
      { at: "2026-08-09T19:44:20Z", level: "info", message: "run summary appended · RUNMILL_LOG.md" },
      { at: "2026-08-09T19:44:21Z", level: "info", message: "backlog empty · watching Linear for new issues" },
    ],
  },
];

let captureStep = 0;
const server = await DaemonControlServer.start({
  paths,
  repoRoot: "/Users/dev/acme-platform",
  configPath: "/Users/dev/acme-platform/runmill.yaml",
  startedAt: "2026-08-09T19:40:00.000Z",
  handle: (request) => {
    const stage = captureStages[captureStep] ?? captureStages.at(-1)!;
    const featuredRun = { ...runs[0]!, state: stage.state, stateVersion: stage.stateVersion };
    if (request.type === "stop") return { stopping: true };
    if (request.type === "inspect") {
      const run = request.runId === featuredRun.runId
        ? featuredRun
        : runs.find((item) => item.runId === request.runId) ?? featuredRun;
      return {
        run,
        transitions: request.runId === featuredRun.runId ? stage.transitions : [],
        events: request.runId === featuredRun.runId ? stage.events : [],
        pending: [],
      };
    }
    return {
      protocolVersion: 1,
      daemon: {
        pid: 48217,
        phase: stage.phase,
        startedAt: "2026-08-09T19:40:00.000Z",
        repoRoot: "/Users/dev/acme-platform",
        configPath: "/Users/dev/acme-platform/runmill.yaml",
        pollSeconds: 30,
        ...(stage.phase === "running" ? { activeIssue: "ENG-142" } : {}),
        sleepInhibitor: "caffeinate",
      },
      runs: [featuredRun, ...runs.slice(1)],
      pendingEffects: 0,
      activeLeases: stage.phase === "running" ? 1 : 0,
      logs: stage.logs,
    };
  },
});

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cssColor(color: { toInts(): [number, number, number, number] }): string {
  const [red, green, blue, alpha] = color.toInts();
  return `rgba(${red},${green},${blue},${(alpha / 255).toFixed(3)})`;
}

function frameToSvg(frame: CapturedFrame): string {
  const cellWidth = 9;
  const cellHeight = 18;
  const padding = 24;
  const width = frame.cols * cellWidth + padding * 2;
  const height = frame.rows * cellHeight + padding * 2;
  const rectangles: string[] = [];
  const text: string[] = [];
  for (let row = 0; row < frame.lines.length; row += 1) {
    let column = 0;
    for (const span of frame.lines[row]?.spans ?? []) {
      const x = padding + column * cellWidth;
      const spanWidth = span.width * cellWidth;
      rectangles.push(
        `<rect x="${x}" y="${padding + row * cellHeight}" width="${spanWidth}" ` +
          `height="${cellHeight}" fill="${cssColor(span.bg)}"/>`,
      );
      if (span.text.trim().length > 0) {
        text.push(
          `<text x="${x}" y="${padding + row * cellHeight + 14}" ` +
            `fill="${cssColor(span.fg)}">${escapeXml(span.text)}</text>`,
        );
      }
      column += span.width;
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" rx="12" fill="#070a0f"/>`,
    `<g font-family="Menlo, Monaco, 'DejaVu Sans Mono', monospace" font-size="14" xml:space="preserve">`,
    ...rectangles,
    ...text,
    `</g>`,
    `</svg>`,
  ].join("\n");
}

let setupReady: ((setup: TestRendererSetup) => void) | undefined;
const ready = new Promise<TestRendererSetup>((resolveReady) => {
  setupReady = resolveReady;
});
const tui = runTui({
  registryPath: paths.registry,
  pollMs: 60_000,
  rendererFactory: async (config) => {
    const setup = await createTestRenderer({ ...config, width: 118, height: 38 });
    setupReady?.(setup);
    return setup.renderer;
  },
});

const setup = await ready;
let tuiClosed = false;
try {
  for (let index = 1; index <= 12; index += 1) {
    rmSync(join(output, `frame-${String(index).padStart(2, "0")}.svg`), { force: true });
  }
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
  await setup.flush();
  for (captureStep = 0; captureStep < captureStages.length; captureStep += 1) {
    if (captureStep > 0) {
      setup.mockInput.pressKey("r");
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    await setup.flush();
    writeFileSync(
      join(output, `frame-${String(captureStep + 1).padStart(2, "0")}.svg`),
      frameToSvg(setup.captureSpans()),
    );
  }
  setup.mockInput.pressKey("q");
  await tui;
  tuiClosed = true;
} finally {
  if (!tuiClosed) {
    setup.mockInput.pressKey("q");
    await tui.catch(() => undefined);
  }
  await server.close();
  rmSync(runtimeDirectory, { recursive: true, force: true });
}
