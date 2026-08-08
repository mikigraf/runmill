import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BacklogIssue } from "../domain/types.js";

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** DD/MM/YYYY with European 24-hour time, in the host's local timezone. */
export function formatRunTimestamp(date: Date): string {
  return `${two(date.getDate())}/${two(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}`;
}

export interface RunLogEntry {
  readonly at: Date;
  readonly issue: BacklogIssue;
  readonly outcome: "PR_DELIVERED" | "COMPLETED";
  readonly runId: string;
  readonly prNumber?: number | undefined;
  readonly prUrl?: string | undefined;
  readonly mergeSha?: string | undefined;
  readonly costUsd: number;
}

export class RunLog {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  append(entry: RunLogEntry): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    if (!existsSync(this.#path)) {
      writeFileSync(
        this.#path,
        "# runmill activity\n\nCompleted and delivered issues, recorded in local time.\n\n",
      );
    }
    const title = entry.issue.title.replace(/[\r\n]+/g, " ").trim();
    const result = entry.outcome === "COMPLETED" ? "merged" : "pull request delivered";
    const pr = entry.prUrl === undefined ? "" : ` · [PR #${entry.prNumber ?? "?"}](${entry.prUrl})`;
    const sha = entry.mergeSha === undefined ? "" : ` · merge ${entry.mergeSha.slice(0, 12)}`;
    appendFileSync(
      this.#path,
      `- ${formatRunTimestamp(entry.at)} · **${entry.issue.identifier}** ${title} · ${result}` +
        `${pr}${sha} · $${entry.costUsd.toFixed(2)} · run \`${entry.runId}\`\n`,
    );
  }
}
