import {
  BoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type CliRendererConfig,
} from "@opentui/core";
import {
  requestDaemon,
  type DaemonSnapshot,
  type RunDetail,
} from "../daemon/control.js";
import type { RunRow } from "../state/store.js";

const COLORS = {
  background: "#0b0f14",
  panel: "#111821",
  border: "#2d3b4f",
  accent: "#54d2d2",
  text: "#dbe7f3",
  muted: "#7f91a6",
  selected: "#183a46",
  warning: "#f0b35a",
} as const;

function runName(run: RunRow): string {
  return `${run.issueId}  ${run.state}`;
}

export function formatRunDetail(detail: RunDetail | undefined): string {
  if (detail === undefined) return "Select a run to inspect its history and events.";
  const { run } = detail;
  const transitions = detail.transitions.slice(-10).map((item) =>
    `${item.at.slice(0, 19).replace("T", " ")}  ${item.from} → ${item.to}`,
  );
  const events = detail.events.slice(-12).map((item) => {
    const payload = JSON.stringify(item.payload);
    const suffix = payload === undefined || payload === "{}" ? "" : `  ${payload.slice(0, 100)}`;
    return `${String(item.seq).padStart(3)}  ${item.type}${suffix}`;
  });
  return [
    `${run.issueId} · ${run.state}`,
    `run       ${run.runId}`,
    `repo      ${run.repo}`,
    `provider  ${run.provider}`,
    `branch    ${run.branch ?? "—"}`,
    `commit    ${run.candidateSha ?? "—"}`,
    "",
    "Transitions",
    ...(transitions.length === 0 ? ["  none yet"] : transitions),
    "",
    "Events",
    ...(events.length === 0 ? ["  none yet"] : events),
    ...(detail.pending.length === 0
      ? []
      : [
          "",
          "Pending effects",
          ...detail.pending.map((item) => `${item.status}  ${item.operation} → ${item.target}`),
        ]),
  ].join("\n");
}

function formatLogs(snapshot: DaemonSnapshot): string {
  if (snapshot.logs.length === 0) return "Waiting for daemon activity…";
  return snapshot.logs
    .slice(-8)
    .map((line) =>
      `${line.at.slice(11, 19)}  ${line.level === "info" ? "" : `${line.level.toUpperCase()}  `}` +
      line.message,
    )
    .join("\n");
}

export interface TuiOptions {
  readonly registryPath?: string | undefined;
  readonly pollMs?: number | undefined;
  /** Test/capture seam; production always uses OpenTUI's native renderer. */
  readonly rendererFactory?:
    | ((config: CliRendererConfig) => Promise<CliRenderer>)
    | undefined;
}

/** Full-screen OpenTUI client. All state comes through the daemon socket. */
export async function runTui(options: TuiOptions = {}): Promise<void> {
  const request = <T>(payload: Parameters<typeof requestDaemon>[0]): Promise<T> =>
    requestDaemon<T>(payload, options.registryPath);
  let snapshot = await request<DaemonSnapshot>({ type: "snapshot" });
  let detail: RunDetail | undefined;
  let selectedRunId = snapshot.runs[0]?.runId;

  const renderer = await (options.rendererFactory ?? createCliRenderer)({
    exitOnCtrlC: false,
    targetFps: 20,
    screenMode: "alternate-screen",
  });

  const root = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: COLORS.background,
  });
  const header = new TextRenderable(renderer, {
    id: "header",
    height: 3,
    paddingLeft: 2,
    paddingTop: 1,
    fg: COLORS.text,
  });
  const body = new BoxRenderable(renderer, {
    id: "body",
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
    paddingX: 1,
  });
  const runsPanel = new BoxRenderable(renderer, {
    id: "runs-panel",
    width: 39,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.border,
    focusedBorderColor: COLORS.accent,
    title: " Runs ",
    padding: 1,
    backgroundColor: COLORS.panel,
  });
  const runSelect = new SelectRenderable(renderer, {
    id: "runs",
    width: "100%",
    height: "100%",
    options: [],
    showDescription: true,
    wrapSelection: true,
    textColor: COLORS.text,
    descriptionColor: COLORS.muted,
    selectedBackgroundColor: COLORS.selected,
    selectedTextColor: COLORS.accent,
  });
  const detailPanel = new BoxRenderable(renderer, {
    id: "detail-panel",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.border,
    title: " Run detail ",
    padding: 1,
    backgroundColor: COLORS.panel,
  });
  const detailText = new TextRenderable(renderer, {
    id: "detail",
    width: "100%",
    height: "100%",
    content: formatRunDetail(undefined),
    fg: COLORS.text,
    selectable: true,
  });
  const logPanel = new BoxRenderable(renderer, {
    id: "logs-panel",
    height: 11,
    marginX: 1,
    marginTop: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.border,
    title: " Live daemon log ",
    padding: 1,
    backgroundColor: COLORS.panel,
  });
  const logText = new TextRenderable(renderer, {
    id: "logs",
    content: "",
    fg: COLORS.muted,
  });
  const footer = new TextRenderable(renderer, {
    id: "footer",
    height: 2,
    paddingLeft: 2,
    paddingTop: 1,
    content: "↑/↓ select   r refresh   s stop daemon   q quit",
    fg: COLORS.muted,
  });

  runsPanel.add(runSelect);
  detailPanel.add(detailText);
  body.add(runsPanel);
  body.add(detailPanel);
  logPanel.add(logText);
  root.add(header);
  root.add(body);
  root.add(logPanel);
  root.add(footer);
  renderer.root.add(root);

  let detailRequest = 0;
  const loadDetail = async (): Promise<void> => {
    const runId = selectedRunId;
    const sequence = ++detailRequest;
    if (runId === undefined) {
      detail = undefined;
      detailText.content = formatRunDetail(detail);
      return;
    }
    try {
      const next = await request<RunDetail | null>({ type: "inspect", runId });
      if (sequence !== detailRequest || runId !== selectedRunId) return;
      detail = next ?? undefined;
      detailText.content = formatRunDetail(detail);
    } catch (error) {
      if (sequence !== detailRequest) return;
      detailText.content = error instanceof Error ? error.message : String(error);
    }
  };

  const renderSnapshot = (): void => {
    const active = snapshot.daemon.activeIssue === undefined ? "" : ` · ${snapshot.daemon.activeIssue}`;
    header.content =
      `RUNMILL  ${snapshot.daemon.phase.toUpperCase()}${active}\n` +
      `${snapshot.daemon.repoRoot} · pid ${snapshot.daemon.pid} · ${snapshot.daemon.sleepInhibitor}` +
      ` · ${snapshot.activeLeases} lease(s) · ${snapshot.pendingEffects} pending effect(s)`;
    const previous = selectedRunId;
    runSelect.options = snapshot.runs.map((run) => ({
      name: runName(run),
      description: `${run.repo} · ${run.provider}`,
      value: run.runId,
    }));
    const nextIndex = Math.max(0, snapshot.runs.findIndex((run) => run.runId === previous));
    if (snapshot.runs.length > 0) {
      runSelect.setSelectedIndex(nextIndex);
      selectedRunId = snapshot.runs[nextIndex]?.runId;
    } else {
      selectedRunId = undefined;
    }
    logText.content = formatLogs(snapshot);
    renderer.requestRender();
  };

  runSelect.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
    selectedRunId = runSelect.getSelectedOption()?.value as string | undefined;
    void loadDetail();
  });

  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearInterval(timer);
    renderer.destroy();
    finish?.();
  };

  const refresh = async (): Promise<void> => {
    try {
      snapshot = await request<DaemonSnapshot>({ type: "snapshot" });
      renderSnapshot();
      await loadDetail();
    } catch (error) {
      footer.content =
        `${error instanceof Error ? error.message : String(error)}   r retry   q quit`;
      footer.fg = COLORS.warning;
      renderer.requestRender();
    }
  };

  renderer.addInputHandler((sequence) => {
    if (sequence === "q" || sequence === "\x03") {
      close();
      return true;
    }
    if (sequence === "r") {
      void refresh();
      return true;
    }
    if (sequence === "s") {
      footer.content = "Stop requested. The daemon will exit at the next safe boundary.";
      footer.fg = COLORS.warning;
      void request({ type: "stop" });
      return true;
    }
    return false;
  });

  renderSnapshot();
  await loadDetail();
  runSelect.focus();
  timer = setInterval(() => void refresh(), options.pollMs ?? 1_000);
  await done;
}
