import { platform, release, homedir } from "node:os";
import type { CheckResult } from "../doctor/checks.js";
import packageJson from "../../package.json" with { type: "json" };

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

runmill runs the coding agent as an untrusted process. SSH keys, cloud
credentials, GitHub and Linear tokens, API-key environment variables, and the
macOS keychain are denied. Provider subscription config is a known exception
inside the boundary until a credential broker exists.

  macOS   Seatbelt (sandbox-exec) with a generated deny-by-default profile
  Linux   bubblewrap with mount and user namespaces

What each platform can enforce differs, and runmill does not pretend otherwise:

  control              macOS        Linux
  file scoping         yes          yes
  credential denial    yes          yes
  network scoping      NO           yes (--unshare-net)
  resource limits      NO           with cgroup v2

The \`proxy\` value currently permits provider network access; the
hostname-filtering proxy is not implemented yet. \`network_allowlist\` is
therefore rejected rather than silently ignored, and doctor reports unrestricted
provider egress as a warning on both platforms.

doctor does not ask whether a sandbox exists. It builds one, tries to read
~/.ssh from inside it, and fails if that succeeds.

If the Linux probe fails with "setting up uid map: Permission denied", your
kernel has unprivileged user namespaces disabled:

    sudo sysctl -w kernel.unprivileged_userns_clone=1

There is no silent downgrade. If isolation cannot be constructed and verified,
no run starts.

Full reference: docs/sandbox.md`,

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
nothing to satisfy.

Full reference: docs/autonomy.md`,

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

For each probe or agent session, runmill copies the provider config into a
private disposable HOME. The real ~/.codex or ~/.claude directory is not
mounted, provider and tool writes are discarded at exit, and refresh state is
not copied back. Tool processes can still read the subscription credential in
that temporary copy. This prevents persistent config tampering; it is not
credential isolation. Use a dedicated subscription, keep runs in pr-only, and
treat that credential as exposed until a host-side broker exists. GitHub,
Linear, cloud, and API-key credentials remain denied to the agent process.

Full reference: docs/lifecycle.md`,

  linear: `Backlog access

runmill reads issues, transitions their state, and comments. It never uses the
backlog to decide ownership — a git ref does that, because the backlog API has
no compare-and-swap and two workers would both conclude they had claimed the
same issue.

    export LINEAR_API_KEY
    printenv LINEAR_API_KEY | runmill auth login linear

Or explore with no credential at all:

    RUNMILL_FAKE_BACKLOG=examples/quickstart/issues.json runmill next --dry-run

Priority is read raw, including the encoding where 0 means "no priority" rather
than "most urgent". Sorting on the raw value would point the agent at the least
specified work in the backlog first.

Full reference: docs/configuration.md`,
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
  const home = homedir();
  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const redact = (text: string): string => {
    let safe = text;
    if (repoRoot !== "") safe = safe.replace(new RegExp(escapeRegExp(repoRoot), "g"), "<repo>");
    if (home !== "") safe = safe.replace(new RegExp(escapeRegExp(home), "g"), "~");

    // A Git remote can contain both a private repository name and URL
    // userinfo (`https://user:token@host/...`). Keep neither in an artifact the
    // operator is invited to paste into a public issue.
    safe = safe.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s,;()[\]{}"'`]+/gi, "<url>");
    safe = safe.replace(/\bgit@[A-Za-z0-9.-]+:[^\s,;()[\]{}"'`]+/g, "<git-remote>");

    // Doctor observations may name an explicit config under /tmp, /work, or
    // another mount outside HOME. A public support bundle must not reveal it.
    // URLs are deliberately excluded: a slash preceded by ':' or '/' is not a
    // filesystem path. Paths already generalized as ~/... or <repo>/... stay
    // useful without naming the machine.
    safe = safe.replace(/(?<![:\/~>])\/(?:[^\s,;()[\]{}"'`]+\/?)+/g, "<path>");
    safe = safe.replace(/\b[A-Za-z]:\\(?:[^\s,;()[\]{}"'`]+\\?)+/g, "<path>");
    return safe;
  };

  const data = {
    runmill: packageJson.version,
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
