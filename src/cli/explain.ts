import { platform, release, homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "../doctor/checks.js";

/**
 * Long-form answers to "what does this check actually require, and why".
 *
 * A doctor line has room for an observation and a one-line fix. When the fix
 * is "enable a kernel feature" or "scope a token", the developer needs the
 * reasoning too, and going to find it elsewhere costs the context switch that
 * loses them.
 */
export const EXPLANATIONS: Readonly<Record<string, string>> = {
  sandbox: `Sandbox isolation

runmill runs the coding agent as an untrusted process. It has your source tree
and nothing else: no SSH keys, no cloud credentials, no GitHub token, no
keychain. That is enforced by the operating system, not by asking the agent
nicely.

  macOS   Seatbelt (sandbox-exec) with a generated deny-by-default profile
  Linux   bubblewrap with mount and user namespaces

What each platform can enforce differs, and runmill does not pretend otherwise:

  control              macOS        Linux
  file scoping         yes          yes
  credential denial    yes          yes
  network scoping      NO           yes (--unshare-net)
  resource limits      NO           with cgroup v2

Seatbelt has no network namespace, so \`workspace.network: proxy\` is the only
enforceable setting on macOS: egress goes through a runmill-operated proxy with
a host allowlist rather than being scoped by the kernel.

doctor does not ask whether a sandbox exists. It builds one, tries to read
~/.ssh from inside it, and fails if that succeeds.

If the Linux probe fails with "setting up uid map: Permission denied", your
kernel has unprivileged user namespaces disabled:

    sudo sysctl -w kernel.unprivileged_userns_clone=1

There is no silent downgrade. If isolation cannot be constructed and verified,
no run starts.`,

  github: `GitHub access

runmill needs two different things from GitHub, and conflating them is how a
governance system becomes decorative.

  1. Enough access to push a branch and open a pull request.
  2. Provably NOT enough access to edit the rules that constrain it.

If the credential that merges can also rewrite branch protection, then "no
merge bypassed protection" is unverifiable — not because runmill would do it,
but because nothing proves it could not. So before any merge mode unlocks,
doctor runs a negative capability test: it checks whether the credential could
write branch protection, and keeps merging locked if it could.

  pr-only          an ordinary \`gh auth login\` session is fine.
                   Opening a pull request cannot bypass anything.

  guarded-merge    a GitHub App installation token scoped to
  continuous       contents:write + pull_requests:write, and explicitly NOT
                   administration.

Branch protection is often unreadable — the classic endpoint needs admin and
org-level rulesets are invisible to repo-scoped calls. runmill treats unreadable
rules as unknown, not as absent, and refuses rather than assuming there is
nothing to satisfy.`,

  provider: `Coding agent provider

runmill dispatches implementation to Codex or Claude Code. It does not
reimplement them, and it does not trust them: the agent runs inside the sandbox
with a bounded task packet, and everything it produces is verified independently.

  codex    codex login status
  claude   an authenticated Claude Code install

Both CLIs update themselves, so the version is checked on every invocation
rather than only at doctor time. An event shape this adapter does not recognise
quarantines the run instead of being parsed best-effort: misreading a tool call
or a terminal result is worse than stopping.

The provider's own credential file is readable inside the sandbox, because the
CLI cannot authenticate without it. That is the one credential inside the
boundary and it is scoped to the provider. Every other credential is denied.`,

  linear: `Backlog access

runmill reads issues, transitions their state, and comments. It never uses the
backlog to decide ownership — a git ref does that, because the backlog API has
no compare-and-swap and two workers would both conclude they had claimed the
same issue.

    export LINEAR_API_KEY=lin_api_...
    runmill auth login linear --token lin_api_...

Or explore with no credential at all:

    RUNMILL_FAKE_BACKLOG=examples/quickstart/issues.json runmill next --dry-run

Priority is read raw, including the encoding where 0 means "no priority" rather
than "most urgent". Sorting on the raw value would point the agent at the least
specified work in the backlog first.`,
};

export interface SupportBundle {
  readonly human: string;
  readonly data: Record<string, unknown>;
}

/**
 * One artifact a developer can attach to an issue.
 *
 * Replaces "describe your environment" with a paste. Deliberately contains no
 * credential values, no repository contents, and no file paths beyond the
 * repository root.
 */
export function buildSupportBundle(
  checks: readonly CheckResult[],
  repoRoot: string,
  funnel: { milestones: Readonly<Record<string, string>>; doctorFailures: Readonly<Record<string, number>>; tthwSeconds?: number | undefined } = {
    milestones: {},
    doctorFailures: {},
  },
): SupportBundle {
  let version = "unknown";
  try {
    const pkg = join(repoRoot, "package.json");
    if (existsSync(pkg)) {
      version = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "unknown";
    }
  } catch {
    // A missing or unreadable package.json is not worth failing a report over.
  }

  const home = homedir();
  const redact = (text: string): string => (home === "" ? text : text.split(home).join("~"));

  const data = {
    runmill: version,
    node: process.version,
    platform: `${platform()} ${release()}`,
    checks: checks.map((c) => ({
      id: c.id,
      status: c.status,
      observed: redact(c.observed),
      ...(c.code === undefined ? {} : { code: c.code }),
    })),
    onboarding: {
      ...(funnel.tthwSeconds === undefined ? {} : { tthwSeconds: funnel.tthwSeconds }),
      reached: Object.keys(funnel.milestones),
      doctorFailures: funnel.doctorFailures,
    },
  };

  const human = [
    "Support bundle — paste this into an issue.",
    "No credentials, source, or absolute paths are included.",
    "",
    "```",
    `runmill   ${data.runmill}`,
    `node      ${data.node}`,
    `platform  ${data.platform}`,
    "",
    ...data.checks.map((c) => `${c.status === "pass" ? "✓" : c.status === "warn" ? "!" : "✗"} ${c.id.padEnd(28)} ${c.observed}`),
    ...(data.onboarding.reached.length === 0
      ? []
      : [
          "",
          `onboarding  ${data.onboarding.reached.join(" → ")}`,
          ...(funnel.tthwSeconds === undefined ? [] : [`tthw        ${funnel.tthwSeconds}s`]),
          ...(Object.keys(data.onboarding.doctorFailures).length === 0
            ? []
            : [`doctor failures  ${JSON.stringify(data.onboarding.doctorFailures)}`]),
        ]),
    "```",
    "",
    "File at: https://github.com/mikigraf/runmill/issues/new",
  ].join("\n");

  return { human, data };
}
