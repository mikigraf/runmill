# Security policy

Runmill controls repository writes, pull requests, and—when explicitly enabled—merge decisions.
Security reports are treated as product-safety reports, not ordinary bugs.

## Supported versions

Runmill is a developer preview and has not published its first npm release.

| Version | Security fixes |
| --- | --- |
| Current `main` branch | Yes |
| Unreleased snapshots and older commits | No |
| npm releases | None published |

Start with `pr-only`. Automatic merge modes are experimental and should be evaluated against your
repositories, rulesets, classic branch protection, and CI behavior before use.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting form](https://github.com/mikigraf/runmill/security/advisories/new).
Include:

- the affected commit and operating system;
- the configured autonomy mode and sandbox mechanism;
- a minimal reproduction or proof of concept;
- the authority, credential, repository, or data that could be affected; and
- whether you believe exploitation is active.

Remove access tokens, provider keys, source code, and customer data from the report. We aim to
acknowledge reports within three business days, coordinate validation and remediation privately,
and credit reporters who want attribution. Please allow time for a fix before public disclosure.

If private vulnerability reporting is unavailable, contact the repository owner privately before
sharing details. Enabling private vulnerability reporting, secret scanning, and push protection is
part of the repository's external launch checklist.

## Security model

Runmill treats repository content, issue text, agent output, and remote API responses as untrusted.
The coding agent proposes code. Deterministic orchestration owns side effects and decides whether
the evidence permits the run to continue. Missing, stale, contradictory, or unreadable evidence
must fail closed.

The main trust boundaries are:

- **Operator policy:** authority is configured outside the repository. Repository-owned check
  manifests and review instructions describe required evidence; they do not grant authority.
- **Agent execution:** each issue runs in an isolated workspace under Seatbelt on macOS or
  bubblewrap on Linux. A missing enforcement mechanism is an error, not a permissive fallback.
- **Verification:** checks and reviews apply to the exact candidate commit. A rebase or amendment
  invalidates earlier evidence.
- **External effects:** branch writes, pull requests, backlog mutations, and merges are performed by
  the orchestrator behind a lease fence—not by model output. An ambiguous outcome blocks all new
  work until a person verifies the remote system and records what happened.
- **Durable state:** leases prevent duplicate claims, and recorded operation intent survives an
  ambiguous failure or restart. Hard-crash lease cleanup is manual in this preview.

## Threats we explicitly consider

| Threat | Expected response |
| --- | --- |
| Sandbox escape or unsupported platform enforcement | Stop the run; never silently execute unsandboxed |
| Prompt injection in source, issue text, or tool output | Treat agent output as a proposal with no direct authority |
| Provider credential inheritance or exfiltration | Strip provider API keys; warn that subscription config and unrestricted provider egress remain inside the boundary until a broker exists |
| Over-scoped GitHub credentials | Grant only the repository and operations required by the selected autonomy mode |
| Classic branch protection, rulesets, or merge queues read incorrectly | Treat protection as unknown and refuse automatic merge |
| Unreadable protection or policy configuration | Fail closed and name the missing evidence |
| Duplicate, expired, or stale leases | Fence every effect; require explicit remote/local reconciliation after process death |
| Retried side effects after timeouts | Block new work until an operator verifies and records the remote outcome |
| Repository-controlled instruction tampering | Treat checks and review instructions as evidence requirements, never authority grants |
| Symlink or path traversal outside the workspace | Reject paths that escape the resolved workspace boundary |
| Stale verification evidence after commit changes | Bind evidence to the candidate SHA and invalidate it on change |
| Sensitive support-bundle content | Redact credentials, source, and absolute paths; review before sharing |
| Platform-specific gaps | Test Seatbelt and bubblewrap independently; do not infer one from the other |

Provider API-key authentication is currently unsupported. Runmill strips `OPENAI_API_KEY` and
`ANTHROPIC_API_KEY` from the agent environment because every tool process spawned by a provider
would inherit them. Use a dedicated CLI subscription session and require `runmill doctor` to prove
it works inside the real sandbox; successful authentication in an ordinary terminal is not
sufficient evidence. Each invocation receives a private disposable copy of subscription config;
the real provider directory is not mounted and sandbox writes are never copied back. Tool
subprocesses can still read the copied credential, and provider egress is unrestricted in `proxy`
mode. Doctor reports both as warnings, and Runmill does not claim provider credential isolation. A
host-side credential and network broker is required before that boundary can be closed. Linear and
GitHub credentials stay in orchestrator-owned adapters and are never given to the coding agent.
Commit signing is also host-side: Runmill snapshots the source checkout's selected Git identity and
signing settings before agent execution, but does not copy them into the agent-visible clone. The
signing key or signing-agent credential stays outside the coding-agent process.

## Credential guidance

- Provider API keys are not a supported coding-agent authentication method. Do not work around the
  environment denylist.
- Use a dedicated provider subscription and start in `pr-only`. Disposable homes prevent persistent
  config changes, but the copied subscription credential and network egress remain developer-preview
  limitations.
- Prefer short-lived or revocable Linear and GitHub credentials dedicated to Runmill.
- Restrict GitHub access to the repositories Runmill operates on. `pr-only` does not need merge
  authority. Do not grant administrative permissions merely to make a check pass.
- Restrict Linear access to the teams Runmill consumes and mutates.
- Never commit credentials, `.env` files, support bundles, or `.runmill/state/`.
- Rotate a credential immediately if it appears in logs, Git history, an issue, or agent output.

## Out of scope for private disclosure

Feature requests, setup problems without a security impact, and expected refusal behavior belong in
the public issue templates. Vulnerabilities in Codex, Claude Code, GitHub, Linear, npm, Node.js, or
the operating system should also be reported to the affected upstream project.
