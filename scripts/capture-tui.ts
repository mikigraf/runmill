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
    state: "LOCAL_REVIEW",
    stateVersion: 7,
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

let captureStep = 0;
const server = await DaemonControlServer.start({
  paths,
  repoRoot: "/Users/dev/acme-platform",
  configPath: "/Users/dev/acme-platform/runmill.yaml",
  startedAt: "2026-08-09T19:40:00.000Z",
  handle: (request) => {
    if (request.type === "stop") return { stopping: true };
    if (request.type === "inspect") {
      const run = runs.find((item) => item.runId === request.runId) ?? runs[0]!;
      return {
        run,
        transitions: [
          { from: "IMPLEMENTING", to: "LOCAL_VERIFY", at: "2026-08-09T19:41:12Z" },
          { from: "LOCAL_VERIFY", to: "LOCAL_REVIEW", at: "2026-08-09T19:42:07Z" },
        ],
        events: [
          { seq: 18, type: "check.completed", payload: { check: "typecheck", status: "passed" } },
          { seq: 19, type: "check.completed", payload: { check: "test", status: "passed" } },
          { seq: 20, type: "review.started", payload: { provider: "claude" } },
        ],
        pending: [],
      };
    }
    const logs = [
      { at: "2026-08-09T19:40:00Z", level: "info", message: "sleep inhibitor active: caffeinate" },
      { at: "2026-08-09T19:40:01Z", level: "info", message: "control socket ready; connect with runmill tui" },
      { at: "2026-08-09T19:40:04Z", level: "info", message: "selected ENG-142 from Linear" },
      { at: "2026-08-09T19:40:05Z", level: "info", message: "workspace ready · branch runmill/eng-142-session-cache-1" },
      { at: "2026-08-09T19:41:12Z", level: "info", message: "implementation complete · candidate 7f4c9a1" },
      { at: "2026-08-09T19:42:07Z", level: "info", message: "verification passed · 6 required checks" },
      { at: "2026-08-09T19:42:08Z", level: "info", message: "fresh-context review started with Claude" },
    ] as const;
    return {
      protocolVersion: 1,
      daemon: {
        pid: 48217,
        phase: captureStep < 2 ? "running" : "idle",
        startedAt: "2026-08-09T19:40:00.000Z",
        repoRoot: "/Users/dev/acme-platform",
        configPath: "/Users/dev/acme-platform/runmill.yaml",
        pollSeconds: 30,
        ...(captureStep < 2 ? { activeIssue: "ENG-142" } : {}),
        sleepInhibitor: "caffeinate",
      },
      runs:
        captureStep < 2
          ? runs
          : [{ ...runs[0]!, state: "PR_DELIVERED", stateVersion: 15 }, ...runs.slice(1)],
      pendingEffects: 0,
      activeLeases: captureStep < 2 ? 1 : 0,
      logs: logs.slice(0, 5 + captureStep),
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
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
  await setup.flush();
  for (captureStep = 0; captureStep < 3; captureStep += 1) {
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
