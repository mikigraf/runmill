# The sandbox

> Implemented in [`src/workspace/sandbox.ts`](../src/workspace/sandbox.ts).

The sandbox bounds agent execution during the **Run** stage of Runmill's delivery loop.

runmill runs the coding agent as an **untrusted process**. It gets the source tree and the provider
CLI state needed to authenticate. SSH keys, cloud credentials, GitHub and Linear tokens, API-key
environment variables, and the macOS keychain remain denied. The provider-state exception is a
known developer-preview limitation described below.

The threat model is not "the agent is malicious." It is that an agent reads issue text, repository
contents, dependency source, and CI output — all of which are attacker-reachable in ordinary
projects — and then executes code. A prompt-injected agent and a buggy one need the same
containment, and instructions in a system prompt are not containment.

## Mechanisms

| Platform | Mechanism |
|---|---|
| macOS | Seatbelt (`sandbox-exec`) with a generated deny-by-default profile |
| Linux | bubblewrap with mount, PID, IPC, and UTS namespaces |
| Other | None — `doctor` says so and refuses to run rather than proceeding unprotected |

What each platform can enforce differs, and runmill does not pretend otherwise:

| Control | macOS | Linux |
|---|---|---|
| File scoping | yes | yes |
| Credential denial | yes | yes |
| Network scoping | **no** | yes (`--unshare-net`) |
| Resource limits | **no** | with cgroup v2 |

Seatbelt has no network namespace, and Runmill does not yet ship its planned hostname-filtering
proxy. Today `workspace.network: proxy` permits unrestricted provider egress on both platforms;
`none` disables it. A non-empty `network_allowlist` is rejected rather than silently accepted as a
control that does not exist. `runmill doctor` reports unrestricted egress as a warning.

## The Seatbelt profile

Deny by default, then grant the minimum:

```lisp
(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow file-read* (subpath "/usr") (subpath "/bin") ... (literal "/"))
```

Two entries are load-bearing and non-obvious: `/private/var/db/dyld` and the root literal `"/"`.
Without them the dynamic loader aborts with `SIGABRT` before the target binary starts — every
command appears to *fail* rather than be *restricted*, which looks like a broken sandbox instead
of a working one.

Writable paths are granted per policy. Then credential paths are denied **last**, so the denial
wins over any broader grant:

```
.ssh  .aws  .kube  .netrc  .git-credentials  .npmrc  .pypirc  .docker  .config/gh
```

And one rule that is not a file rule at all:

```lisp
(deny mach-lookup (global-name "com.apple.SecurityServer"))
```

The macOS keychain is reached through a Mach service, not a filesystem path. Denying
`~/Library/Keychains` does nothing, because that is not how a process asks for a secret. Blocking
the file and leaving the service open is the kind of gap that looks airtight in a config review
and is wide open in practice.

### Role-specific write access

Implementers and fixers can write the source tree, but its `.git` directory remains read-only.
Runmill adds a mandatory read-only submount for `.git` after granting the surrounding workspace:

- Seatbelt emits a later `file-write*` denial for the exact path and its descendants.
- bubblewrap emits a non-optional `--ro-bind` after the writable workspace bind.

If that protective path is missing, sandbox construction fails. It is never downgraded to a
writable workspace-only mount. Implementers can still edit ordinary files and use read-only Git
commands; `GIT_OPTIONAL_LOCKS=0` prevents those commands from attempting an optional index refresh.

Local and pull-request reviewers receive the entire workspace read-only. Runmill pre-creates the
reviewer's role-specific JSON output file and grants that exact file—not its parent directory—as
writable. This lets the reviewer return findings while preventing it from changing the candidate,
task packet, or orchestrator-owned PR evidence it is judging.

The checkpoint repeats the boundary in deterministic code. Before staging anything, it rejects a
changed HEAD/current ref, index tree, local config, hooks, Git info controls, object alternates, or
replace refs. Only a successful commit created by the orchestrator becomes the next trusted Git
state.

## Environment

The environment is built by **allowlist**, not by filtering:

```ts
const ENV_ALLOWLIST = [
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "TMPDIR", "USER", "SHELL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "all_proxy", "no_proxy",
];
```

Everything else is dropped, so a variable nobody anticipated is excluded by default rather than
inherited until someone notices.

The TLS and proxy entries let a provider reach its API on managed hosts. Proxy URLs containing
userinfo, such as `http://user:password@proxy`, are stripped because every provider tool would
otherwise inherit the proxy credential. Use a credential-free proxy address until the host-side
network broker exists.

A denylist is then applied on top — defence in depth for the case where a variable is added to the
allowlist, or injected as an explicit extra:

- **Credentials:** `GITHUB_TOKEN`, `GH_TOKEN`, `LINEAR_API_KEY`, `AWS_*`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `NPM_TOKEN`
- **Code-injection vectors:** `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`,
  `DYLD_LIBRARY_PATH`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `BASH_ENV`, `ENV`,
  `PYTHONSTARTUP`, `PYTHONPATH`
- **Credential agents:** `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `SSH_ASKPASS`

The second group matters as much as the first. `LD_PRELOAD` and `NODE_OPTIONS` turn any later
process launch into arbitrary code execution, which would route around the file rules entirely.

`SSH_AUTH_SOCK` is the subtle one: denying `~/.ssh` is pointless if the agent socket is inherited,
because the forwarded agent will happily *sign with* keys it never has to read.

## The provider credential boundary

Before each authentication probe or agent session, Runmill copies only an allowlist of provider
authentication files into a private disposable `HOME`; history, instructions, plugins, caches,
MCP configuration, and prior sessions are excluded. Symlinks are dereferenced into ordinary private
files, and a nested link that escapes the provider config tree is rejected. The real
`~/.codex` or `~/.claude` directory is never mounted. The provider and its tool children may write
the temporary copy, but Runmill deletes it after an exit, spawn error, cancellation, or timeout.
Changes and refreshed session state are not copied back to the operator's home.

This prevents persistent provider-config tampering, but sandbox-proven subscription authentication
is still **not credential-isolated**. Seatbelt and bubblewrap cannot make the copied credential
visible to the provider parent while hiding it from a tool the provider launches. `runmill doctor`
therefore reports a warning even after authentication succeeds. It also makes one minimal,
one-turn request per distinct configured provider/model to prove actual execution inside this
boundary; that request uses a small number of tokens and may be billable. Use a dedicated provider
session, start in `pr-only`, and assume malicious repository instructions could read or exfiltrate
the copied provider credential. If a provider rotates credentials during a run, the discarded
refresh state may require you to authenticate the host CLI again.

Provider API keys are not a workaround. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are stripped from
the agent environment because tool subprocesses would inherit them directly. A host-side credential
broker is required to remove both forms of provider credential from the agent boundary.

## Everything runs inside it

Both the agent **and** every verification check run wrapped:

```ts
const outcome = await this.#sandbox.run({
  command, args,
  cwd: verifyPath,
  policy: {
    writablePaths: [verifyPath],
    protectedPaths: [join(verifyPath, ".git"), join(verifyPath, "node_modules")],
    allowNetwork: false,
  },
});
```

Checks execute with network disabled and only the verification checkout writable. A test suite is
arbitrary code from the same repository the agent just modified; sandboxing the agent while
running its tests unconfined would leave the boundary open at exactly the moment the agent's
output gets executed. Prepared npm dependencies are content-keyed to the exact lockfile and
hard-linked into the checkout before a check starts; their nested read-only overlay prevents the
test process from unlinking, replacing, or patching its own toolchain.

The provider CLI runs with **its own** sandbox disabled inside runmill's, so there is one
enforcement layer rather than two half-configured ones.

## Proof, not assertion

`doctor` does not check whether a sandbox mechanism exists. It builds one, tries to read `~/.ssh`
from inside it, and fails if that succeeds:

```
✓ sandbox:mechanism             sandbox-exec (Seatbelt)
✓ sandbox:deny-credential-read  read denied
! sandbox:network               provider egress is unrestricted in proxy mode
✓ provider:codex                authenticated inside sandbox
✓ provider:codex:request        one-turn provider request completed inside sandbox
```

There is no silent downgrade. If isolation cannot be constructed and verified, no run starts —
[`RM-SANDBOX-001`](./errors.md#rm-sandbox-001).

On Linux, `setting up uid map: Permission denied` means unprivileged user namespaces are disabled:

```bash
sudo sysctl -w kernel.unprivileged_userns_clone=1
```

## Output capture

512 KB is retained per stream, keeping the **tail**. The zero-test and focused-execution detectors
read runner summaries there. Skip authority never comes from this truncated text: it comes from
the exact identities in the declared machine-readable report.

## Configuration

```yaml
workspace:
  sandbox: native          # native | none (observe mode only)
  network: proxy           # unrestricted provider egress today | none
  network_allowlist: []    # reserved; non-empty values are rejected
  allow_unenforced: []     # reserved; non-empty values are rejected
```

`allow_unenforced` is reserved for a future per-control acknowledgement flow. Runmill rejects a
non-empty value today because recording an acknowledgement that no runtime gate consumes would be
misleading.

## See also

- [The coverage contract](./verification.md) — what runs inside the sandbox and why it is trusted
- [Run lifecycle](./lifecycle.md) — where isolation is established
- `runmill doctor --explain sandbox`
