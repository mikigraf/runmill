# Security policy

Runmill controls repository writes, pull requests, and (when explicitly enabled) merge decisions.
We treat security reports as product-safety reports rather than ordinary bugs.

## Supported versions

Runmill is a developer preview and has not published its first npm release.

| Version | Security fixes |
| --- | --- |
| Current `main` branch | Yes |
| Unreleased snapshots and older commits | No |
| npm releases | None published |

Start with `pr-only`. Automatic merge modes are experimental. Before you use one, test it against
your repositories, rulesets, classic branch protection, and CI behavior.

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
The coding agent proposes code. Deterministic orchestration code performs the side effects and
decides whether the evidence lets the run continue. Missing, stale, contradictory, or unreadable
evidence must fail closed.

The main trust boundaries are:

- **Operator policy.** Authority is configured outside the repository. Check manifests and review
  instructions in the repository describe what evidence is required. They grant no authority.
- **Agent execution.** Each issue runs in an isolated workspace under Seatbelt on macOS or
  bubblewrap on Linux. If the enforcement mechanism is missing, that is an error. Runmill does not
  fall back to running without it.
- **Verification.** Checks and reviews apply to the exact candidate commit. A rebase or amend
  invalidates any earlier evidence.
- **External effects.** The orchestrator performs branch writes, pull requests, backlog changes,
  and merges behind a lease fence. Model output never does. If an outcome is ambiguous, all new
  work is blocked until a person checks the remote system and records what happened.
- **Durable state.** Leases prevent duplicate claims, and the recorded intent of each operation
  survives an ambiguous failure or a restart. Cleaning up leases after a hard crash is manual in
  this preview.

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

Provider API-key authentication is not supported yet. Runmill removes `OPENAI_API_KEY` and
`ANTHROPIC_API_KEY` from the agent environment, because every tool process the provider spawns
would otherwise inherit them. Use a dedicated CLI subscription session and have `runmill doctor`
prove it works inside the real sandbox. Signing in successfully in an ordinary terminal is not
enough evidence. Each invocation gets its own throwaway copy of the subscription config. The real
provider directory is not mounted, and nothing the sandbox writes is copied back. Tool
subprocesses can still read the copied credential, and provider egress is unrestricted in `proxy`
mode. Doctor reports both as warnings, and Runmill makes no claim to isolate provider credentials.
Closing that gap needs a host-side credential and network broker. Linear and GitHub credentials
stay in adapters the orchestrator owns and are never given to the coding agent. Commit signing
also happens on the host. Before the agent runs, Runmill records the source checkout's Git
identity and signing settings, but it does not copy them into the clone the agent can see. The
signing key or signing-agent credential stays outside the coding-agent process.

## Credential guidance

- Provider API keys are not a supported way to authenticate the coding agent. Don't work around the
  environment denylist.
- Use a dedicated provider subscription and start in `pr-only`. Throwaway home directories stop
  config changes from persisting. The copied subscription credential and open network egress are
  still developer-preview limitations.
- Prefer short-lived or revocable Linear and GitHub credentials dedicated to Runmill.
- Limit GitHub access to the repositories Runmill works on. `pr-only` does not need merge
  authority. Don't grant admin permissions just to make a check pass.
- Limit Linear access to the teams Runmill reads from and writes to.
- Never commit credentials, `.env` files, support bundles, or `.runmill/state/`.
- Rotate a credential immediately if it appears in logs, Git history, an issue, or agent output.

## Out of scope for private disclosure

Feature requests, setup problems with no security impact, and refusals that are working as
intended belong in the public issue templates. If you find a vulnerability in Codex, Claude Code,
GitHub, Linear, npm, Node.js, or the operating system, report it to that upstream project as well.
