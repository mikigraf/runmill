/**
 * The developer-facing error contract.
 *
 * The specification's central DX finding was that runmill described what the
 * system knows and never what the developer sees. This type is the fix: every
 * failure mode carries a stable code, what happened, why, an ordered set of
 * fixes, and a docs URL. FR-23 forbids any failure mode presenting as silent.
 */

/** Narrow an unknown thrown value to a message. Written 7 times before this. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface Fix {
  readonly description: string;
  /** An exact command the developer can run, when one exists. */
  readonly command?: string | undefined;
}

export interface ErrorCatalogEntry {
  readonly title: string;
  readonly why: string;
  readonly fixes: readonly Fix[];
  readonly recoverable: boolean;
}

/**
 * Where the Docs line points.
 *
 * Was `runmill.dev`, which does not resolve — so every error in the catalog
 * printed a dead link. Points at the repository, which exists.
 */
export const DOCS_BASE = "https://github.com/mikigraf/runmill/blob/main/docs/errors.md";

/**
 * Every failure mode runmill can present. Adding a throw site without adding
 * an entry here is a contract violation, not a shortcut.
 */
export const ERROR_CATALOG = {
  // -- selection ---------------------------------------------------------
  "RM-SELECT-002": {
    title: "Issue does not map to a repository",
    why:
      "Every issue must resolve to exactly one repository, because the lease " +
      "ref lives in the mapped repository. An unmapped issue has no lease target.",
    fixes: [
      { description: "Add a matching rule under github.repositories" },
      { description: "Inspect which rules were tried", command: "runmill next --dry-run" },
    ],
    recoverable: false,
  },
  "RM-SELECT-003": {
    title: "Issue is too underspecified to build a task packet",
    why:
      "The description does not contain enough detail to derive objective and " +
      "acceptance criteria. Dispatching anyway produces plausible but wrong work.",
    fixes: [
      { description: "Add acceptance criteria to the issue" },
      { description: "See exactly what is missing", command: "runmill prepare <issue>" },
      { description: "Override deliberately by applying the readiness label" },
    ],
    recoverable: false,
  },

  // -- credentials -------------------------------------------------------
  "RM-AUTH-003": {
    title: "Backlog credential expired",
    why: "runmill cannot read or transition issues without a valid backlog credential.",
    fixes: [
      { description: "Re-authenticate", command: "runmill auth login linear" },
      { description: "Verify", command: "runmill doctor --check linear" },
    ],
    recoverable: true,
  },

  // -- sandbox -----------------------------------------------------------
  "RM-SANDBOX-001": {
    title: "Sandbox isolation unavailable",
    why:
      "runmill runs the coding agent inside an OS sandbox so it cannot read " +
      "your SSH keys, cloud credentials, or GitHub token. Without a verified " +
      "sandbox the isolation guarantees do not hold, so no run starts.",
    fixes: [
      {
        description: "Enable unprivileged user namespaces (Linux)",
        command: "sudo sysctl -w kernel.unprivileged_userns_clone=1",
      },
      { description: "Show full sandbox requirements", command: "runmill doctor --explain sandbox" },
    ],
    recoverable: false,
  },
  "RM-SANDBOX-002": {
    title: "Sandbox escape probe succeeded",
    why:
      "doctor attempted a forbidden read or write from inside the sandbox and " +
      "it was permitted. The isolation boundary is not what it claims to be.",
    fixes: [
      { description: "Re-run the probes with detail", command: "runmill doctor --explain sandbox" },
      { description: "Do not run runmill on this host until the probe passes" },
    ],
    recoverable: false,
  },

  // -- lease -------------------------------------------------------------
  "RM-LEASE-001": {
    title: "Lease lost or fencing generation stale",
    why:
      "Another run took ownership of this issue. Continuing would race a live " +
      "worker against the same branch and pull request.",
    fixes: [
      { description: "Inspect the current owner", command: "runmill inspect <run-id>" },
      { description: "No action needed if the other run is legitimate" },
    ],
    recoverable: false,
  },
  "RM-LEASE-002": {
    title: "Could not acquire lease",
    why: "The lease ref already exists, so another run claimed this issue first.",
    fixes: [{ description: "Select a different issue", command: "runmill next --dry-run" }],
    recoverable: true,
  },

  // -- verification ------------------------------------------------------
  "RM-VERIFY-001": {
    title: "Required check is missing",
    why:
      "A check in the resolved manifest has no runnable command and no remote " +
      "result. Merge-readiness fails closed rather than assuming coverage.",
    fixes: [
      { description: "Add the command to .runmill/checks.yaml" },
      { description: "Show the resolved manifest", command: "runmill policy explain <run-id>" },
    ],
    recoverable: true,
  },
  "RM-VERIFY-002": {
    title: "Check ran against a different tree",
    why:
      "The worktree changed between the start and end of a check, so the result " +
      "does not describe the candidate commit and cannot be used as evidence.",
    fixes: [{ description: "Automatic: the check is re-run against a clean detached worktree" }],
    recoverable: true,
  },
  "RM-VERIFY-003": {
    title: "Undeclared test skip",
    why:
      "A test that passed at the base commit is skipped or absent at the " +
      "candidate, and the skip is not declared in the manifest. Silently losing " +
      "a test is indistinguishable from breaking it.",
    fixes: [
      { description: "Restore the test, or declare the skip with a cause and expiry" },
      { description: "See the diff against the baseline inventory", command: "runmill inspect <run-id>" },
    ],
    recoverable: true,
  },

  "RM-VERIFY-004": {
    title: "Check manifest is invalid",
    why:
      "The repository declares its required checks in this file. An unreadable " +
      "manifest must never be treated as 'no checks required', so it fails the " +
      "run instead of being skipped.",
    fixes: [
      { description: "Check the manifest and report every problem at once", command: "runmill config validate" },
      { description: "Write a fresh manifest alongside the existing one", command: "runmill init" },
    ],
    recoverable: false,
  },

  // -- CI ----------------------------------------------------------------
  "RM-CI-002": {
    title: "Required check never reported",
    why:
      "GitHub requires this context but has not scheduled it. Most often a " +
      "workflow paths: filter does not match this diff, so the context will " +
      "never report and the pull request can never merge.",
    fixes: [
      { description: "Add an always-running companion job that reports success" },
      { description: "Inspect branch protection", command: "gh api repos/{owner}/{repo}/rulesets" },
    ],
    recoverable: true,
  },
  "RM-CI-003": {
    title: "Merge queue check name does not match",
    why:
      "A required check reports under a different name in the merge_group " +
      "context than in pull_request, so the queue entry can never be satisfied.",
    fixes: [
      { description: "Declare `on: merge_group` and use a context-invariant job name" },
      { description: "Validate workflows", command: "runmill doctor --check github" },
    ],
    recoverable: true,
  },

  // -- provider ----------------------------------------------------------
  "RM-PROVIDER-001": {
    title: "Unknown provider event shape",
    why:
      "The coding agent emitted an event this adapter version does not " +
      "recognise. Best-effort parsing could misread a tool call or a result, " +
      "so the run is quarantined instead.",
    fixes: [
      { description: "Check supported versions", command: "runmill doctor --check provider" },
      { description: "Pin the provider to a supported version" },
    ],
    recoverable: false,
  },
  "RM-PROVIDER-002": {
    title: "Provider budget exhausted",
    why: "The run reached its turn, time, invocation, or cost ceiling.",
    fixes: [
      { description: "Raise the budget in runmill.yaml" },
      { description: "Resume with approval", command: "runmill resume <run-id>" },
    ],
    recoverable: true,
  },

  // -- review ------------------------------------------------------------
  "RM-REVIEW-001": {
    title: "Review output did not match the schema",
    why:
      "The reviewer returned something that is not a valid findings document. " +
      "A malformed review is never treated as a passing review.",
    fixes: [
      { description: "Automatic: one repair attempt, then escalation" },
      { description: "Validate the review skill", command: "runmill skills validate" },
    ],
    recoverable: true,
  },
  "RM-REVIEW-004": {
    title: "Review needs a human decision",
    why: "The reviewer found an ambiguity that policy cannot resolve deterministically.",
    fixes: [
      { description: "List what is waiting", command: "runmill list --needs-attention" },
      { description: "Answer and continue", command: "runmill resume <run-id> --answer <choice>" },
    ],
    recoverable: true,
  },

  // -- config / state ----------------------------------------------------
  "RM-CONFIG-001": {
    title: "Configuration is invalid",
    why: "runmill.yaml does not satisfy the published schema, so behavior would be undefined.",
    fixes: [
      { description: "Show the specific violations", command: "runmill config validate" },
      { description: "Add the schema header for editor validation" },
    ],
    recoverable: false,
  },
  "RM-CONFIG-002": {
    title: "Referenced file does not exist",
    why:
      "A path in runmill.yaml points at a file that is not present. This is " +
      "checked before any agent is dispatched so it cannot fail after spend.",
    fixes: [
      { description: "Write the built-in review skills", command: "runmill skills eject" },
      { description: "Check which paths are unresolvable", command: "runmill config validate" },
    ],
    recoverable: false,
  },
  "RM-CONFIG-003": {
    title: "No configuration file",
    why:
      "runmill needs a runmill.yaml to know which backlog to read, which " +
      "repositories issues map to, and how much autonomy it has.",
    fixes: [
      { description: "Create one, with the repository inferred from git", command: "runmill init" },
      {
        description: "Or point at one that lives somewhere else",
        command: "runmill --config <path> next",
      },
    ],
    recoverable: false,
  },
  "RM-STATE-001": {
    title: "State database schema is newer than this binary",
    why:
      "The database was migrated by a newer runmill. Reading it with this " +
      "version could corrupt the audit record.",
    fixes: [
      { description: "Upgrade runmill", command: "npm i -g runmill@latest" },
      { description: "Check versions", command: "runmill --version" },
    ],
    recoverable: false,
  },
} as const satisfies Record<string, ErrorCatalogEntry>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface RunmillErrorInit {
  readonly code: string;
  readonly title: string;
  readonly whatHappened: string;
  readonly why: string;
  readonly fixes: readonly Fix[];
  readonly recoverable: boolean;
  readonly runId?: string | undefined;
  readonly resumeFrom?: string | undefined;
  readonly cause?: unknown;
}

export class RunmillError extends Error {
  readonly code: string;
  readonly title: string;
  readonly whatHappened: string;
  readonly why: string;
  readonly fixes: readonly Fix[];
  readonly recoverable: boolean;
  readonly runId?: string | undefined;
  readonly resumeFrom?: string | undefined;

  constructor(init: RunmillErrorInit) {
    super(`${init.code} ${init.title}`, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "RunmillError";
    this.code = init.code;
    this.title = init.title;
    this.whatHappened = init.whatHappened;
    this.why = init.why;
    this.fixes = init.fixes;
    this.recoverable = init.recoverable;
    this.runId = init.runId;
    this.resumeFrom = init.resumeFrom;
  }

  get docsUrl(): string {
    // Anchor into the generated reference rather than a per-code page: one
    // file that CI keeps in sync beats twenty that drift.
    return `${DOCS_BASE}#${this.code.toLowerCase()}`;
  }

  static fromCatalog(
    code: ErrorCode,
    context: {
      whatHappened: string;
      runId?: string | undefined;
      resumeFrom?: string | undefined;
      cause?: unknown;
    },
  ): RunmillError {
    const entry = ERROR_CATALOG[code];
    return new RunmillError({
      code,
      title: entry.title,
      why: entry.why,
      fixes: entry.fixes,
      recoverable: entry.recoverable,
      whatHappened: context.whatHappened,
      runId: context.runId,
      resumeFrom: context.resumeFrom,
      cause: context.cause,
    });
  }

  /** Shape persisted to the events table and emitted by `--json`. */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      title: this.title,
      whatHappened: this.whatHappened,
      why: this.why,
      fixes: this.fixes,
      docsUrl: this.docsUrl,
      recoverable: this.recoverable,
      runId: this.runId,
      resumeFrom: this.resumeFrom,
    };
  }
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

/** The terminal rendering: what happened, why, how to fix it, where to read more. */
export function renderError(err: RunmillError): string {
  const lines: string[] = [];
  lines.push(`✗ ${err.title}  [${err.code}]`);
  lines.push("");
  lines.push("  What happened");
  lines.push(indent(err.whatHappened, "    "));
  lines.push("");
  lines.push("  Why");
  lines.push(indent(err.why, "    "));
  lines.push("");
  lines.push(err.fixes.length === 1 ? "  Fix" : "  Fix (pick one)");
  for (const fix of err.fixes) {
    lines.push(fix.command === undefined ? `    → ${fix.description}` : `    → ${fix.command}`);
    if (fix.command !== undefined) lines.push(`        ${fix.description}`);
  }
  lines.push("");
  lines.push(`  Docs  ${err.docsUrl}`);
  return lines.join("\n");
}
