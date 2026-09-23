# The sandbox

> Implemented in [`src/workspace/sandbox.ts`](../src/workspace/sandbox.ts).

The sandbox bounds agent execution during the **Run** stage of Runmill's delivery loop.

runmill runs the coding agent as an **untrusted process**. It gets the source tree and the provider
CLI state it needs to authenticate. SSH keys, cloud credentials, GitHub and Linear tokens, API-key
environment variables, and the macOS keychain stay denied. The provider-state exception is a known
developer-preview limitation, described below.

We don't assume the agent is malicious. The threat model is simpler: an agent reads issue text,
repository contents, dependency source, and CI output (in ordinary projects, an attacker can reach
all of those) and then executes code. A prompt-injected agent and a buggy one need the same
containment. Instructions in a system prompt are not containment.

## Mechanisms

| Platform | Mechanism |
|---|---|
| macOS | No production execution backend. Seatbelt policy is tested, but cannot own escaped-session descendants. |
| Linux | No production execution backend. The bubblewrap harness awaits complete descriptor-bound runtime and policy closure. |
| Other | No execution backend. `doctor` says so and refuses to run instead of proceeding unprotected |

What each platform can enforce differs, and runmill doesn't pretend otherwise:

| Control | macOS | Linux |
|---|---|---|
| File scoping | no production execution | no production execution |
| Credential denial | no production execution | no production execution |
| Network scoping | no production execution | no production execution |
| Resource limits | no production execution | no production execution |

Seatbelt has no lifecycle container. A child can create a new session and survive process-group
termination, so Runmill refuses production native execution on macOS. The Seatbelt profile is
still there as an explicit test-only policy renderer and qualification harness, and its execution
regressions stay pending until cleanup is lifecycle-safe. The factory, config composition, and
doctor never select it.

Runmill also doesn't ship its planned hostname-filtering proxy yet. When an execution backend is
qualified, `workspace.network: proxy` will initially permit unrestricted provider egress; `none`
disables it. A non-empty `network_allowlist` is rejected, because silently accepting it would
advertise a control that doesn't exist. The current doctor reports a categorical
unqualified-backend failure and makes no per-control isolation claims. Once a backend is
qualified, its network probe must report unrestricted egress as a warning.

## The Seatbelt profile

Deny by default, then grant the minimum:

```lisp
(version 1)
(deny default)
(allow process-fork)
(allow process-exec (literal "/exact/qualified/executable"))
(allow file-read* (subpath "/System") (subpath "/usr/lib") ... (literal "/"))
```

Two entries are load-bearing and easy to miss: `/private/var/db/dyld` and the root literal `"/"`.
Without them the dynamic loader aborts with `SIGABRT` before the target binary starts. Every
command then appears to *fail* instead of being *restricted*, and a working sandbox looks like a
broken one.

There is no ambient executable-directory grant. Before starting a child, the backend resolves the
first executable on the configured host PATH, records its canonical identity and SHA-256, follows a
bounded shebang chain, and qualifies explicitly supported subprocesses. The operator-owned coding
tool inventory is small on purpose (`git`, `rg`, `node`, `npm`, and `npx`). The only additions are
the exact installed or absolute executables named by configured verification checks. Installed Node
provider CLIs get their exact package tree and declared platform package. They don't get the
containing global `node_modules` tree or sibling packages. Seatbelt permits `process-exec` only for this qualified
closure. The Linux test harness constructs an empty bubblewrap root and is being hardened around
descriptor-bound original guest paths and immutable runtime manifests. Production selection stays
disabled until ELF loader aliases, libc/NSS behavior, trust/DNS/timezone inputs, every policy mount,
and FD-bind launcher support are proved as one closure. ELF metadata inspection reads bytes and
never executes the target or invokes `ldd` with host authority.

Writable paths are granted per policy. Credential paths are then denied **last**, so the denial
wins over any broader grant:

```
.ssh  .aws  .kube  .netrc  .git-credentials  .npmrc  .pypirc  .docker  .config/gh
```

And one rule that isn't a file rule at all:

```lisp
(deny mach-lookup (global-name "com.apple.SecurityServer"))
```

A process reaches the macOS keychain through a Mach service. It doesn't go through a filesystem
path, so denying `~/Library/Keychains` does nothing. Blocking the file and leaving the service open
is the kind of gap that looks airtight in a config review and is wide open in practice.

### Role-specific write access

Implementers and fixers can write the source tree, but its `.git` directory stays read-only.
Runmill adds a mandatory read-only submount for `.git` after granting the surrounding workspace:

- Seatbelt emits a later `file-write*` denial for the exact path and its descendants.
- bubblewrap emits a non-optional `--ro-bind` after the writable workspace bind.

If that protective path is missing, sandbox construction fails. It is never downgraded to a
writable workspace-only mount. Implementers can still edit ordinary files and use read-only Git
commands, and `GIT_OPTIONAL_LOCKS=0` stops those commands from attempting an optional index refresh.

Local and pull-request reviewers get the entire workspace read-only. Runmill pre-creates the
reviewer's role-specific JSON output file and grants that exact file as writable (the file only,
never its parent directory). The reviewer can return findings, but it can't change the candidate,
task packet, or orchestrator-owned PR evidence it is judging.

The checkpoint enforces the same boundary again in deterministic code. Before staging anything, it rejects a
changed HEAD/current ref, index tree, local config, hooks, Git info controls, object alternates, or
replace refs. Only a successful commit created by the orchestrator becomes the next trusted Git
state.

## Environment

The environment is built from an **allowlist**. We don't filter the inherited one:

```ts
const ENV_ALLOWLIST = [
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "TMPDIR", "USER", "SHELL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "all_proxy", "no_proxy",
];
```

Everything else is dropped. A variable nobody anticipated is excluded by default, instead of being
inherited until someone notices.

The inherited `PATH` is used only during host-side qualification. The child receives a private PATH
containing symlinks to the qualified executable closure (the fixed guest path
`/runmill/runtime/bin` under bubblewrap), so an ambient later PATH entry cannot replace the program
that was qualified. A configured TLS trust root is canonicalized and rejected if it is root, the
operator home, a workspace ancestor, or another over-broad grant.

Qualification records two separate hashes. The runtime digest covers the canonical executable,
runtime-path, and launcher identities. The effective-policy digest covers that runtime plus the
actual immutable executable snapshots, host/guest layout, mount access and purpose, protected and
prepared paths, network mode, and limits. In the pending harness, executable and launcher
identities are checked again right before each spawn. The current doctor can't report a
production launcher identity because no production backend is qualified. Any future activation
must report the exact identity it executes.

The TLS and proxy entries let a provider reach its API on managed hosts. Proxy URLs containing
userinfo, such as `http://user:password@proxy`, are stripped, since otherwise every provider tool
would inherit the proxy credential. Use a credential-free proxy address until the host-side
network broker exists.

A denylist then goes on top. It's defence in depth for when a variable gets added to the
allowlist or injected as an explicit extra:

- **Credentials:** `GITHUB_TOKEN`, `GH_TOKEN`, `LINEAR_API_KEY`, `AWS_*`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `NPM_TOKEN`
- **Code-injection vectors:** `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`,
  `DYLD_LIBRARY_PATH`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `BASH_ENV`, `ENV`,
  `PYTHONSTARTUP`, `PYTHONPATH`
- **Credential agents:** `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `SSH_ASKPASS`

The second group matters as much as the first. `LD_PRELOAD` and `NODE_OPTIONS` turn any later
process launch into arbitrary code execution, and that routes around the file rules entirely.

`SSH_AUTH_SOCK` is the subtle one. Denying `~/.ssh` is pointless if the agent socket is inherited,
because the forwarded agent will happily *sign with* keys it never has to read.

## The provider credential boundary

Before each authentication probe or agent session, Runmill copies an allowlist of provider
authentication files into a private disposable `HOME`, and nothing else. History, instructions,
plugins, caches, MCP configuration, and prior sessions stay out. Symlinks are dereferenced into ordinary private
files, and a nested link that escapes the provider config tree is rejected. The real
`~/.codex` or `~/.claude` directory is never mounted. The provider and its tool children may write
the temporary copy, but Runmill deletes it after an exit, spawn error, cancellation, or timeout.
Changes and refreshed session state are not copied back to the operator's home.

Provider discovery and authentication probes use this same sandbox. Runmill never executes an
ambient provider binary just to ask for its version or authentication status.

That stops persistent tampering with provider config. Sandbox-proven subscription authentication
is still **not credential-isolated**, though. Seatbelt and bubblewrap can't make the copied
credential visible to the provider parent while hiding it from a tool the provider launches, so
`runmill doctor` reports a warning even after authentication succeeds. It also makes one minimal,
one-turn request per distinct configured provider/model to prove actual execution inside this
boundary. That request uses a small number of tokens and may be billable. Use a dedicated provider
session, start in `pr-only`, and assume malicious repository instructions could read or exfiltrate
the copied provider credential. If a provider rotates credentials during a run, the discarded
refresh state may require you to authenticate the host CLI again.

Provider API keys don't get around this. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are stripped from
the agent environment because tool subprocesses would inherit them directly. Getting both forms of
provider credential out of the agent boundary needs a host-side credential broker.

## One backend contract

When a backend is production-qualified, both the agent **and** every verification check use the
same injected lifecycle-owning instance. No backend currently satisfies that qualification:

```ts
const outcome = await this.#sandbox.run({
  command, args,
  cwd: verifyPath,
  policy: {
    writablePaths: [],
    writableFiles: [reportPath],
    readablePaths: [verifyPath],
    protectedPaths: [join(verifyPath, ".git"), join(verifyPath, "node_modules")],
    allowNetwork: false,
  },
});
```

Checks run with network disabled, the verification checkout read-only, and only a pre-created
declared report file writable. A test suite is arbitrary code from the repository the agent just
modified. Sandbox the agent but run its tests unconfined, and the boundary is open at exactly the
moment the agent's output gets executed. Prepared npm dependencies are content-keyed to the exact lockfile and
hard-linked into the checkout before a check starts. The exact prepared tree is also materialized
read-only for provider sessions. Declared local npm scripts work, and sibling packages or an
ambient package root are not granted. Its nested read-only overlay prevents the process from
unlinking, replacing, or patching its own toolchain.

The backend contract exposes `start()`, a completion promise, and an awaited idempotent `abort()`.
It is not a wrapper command. No production implementation is selected until its kernel-owned
containment resource and cleanup semantics are proved. The test harnesses are not that proof, and
`doctor` categorically refuses to certify Seatbelt or the incomplete bubblewrap harness.

The provider CLI runs with **its own** sandbox disabled inside runmill's. One enforcement layer
beats two half-configured ones.

## Proof, not assertion

Today `doctor` refuses the unqualified backend before it builds a planted-resource probe. Once a
lifecycle-owning backend exists, the planted denial probe becomes mandatory evidence. Checking that
the mechanism is present won't be enough:

```
✗ sandbox:mechanism             RM-SANDBOX-001 (no production-qualified local backend)
```

There is no silent downgrade. If isolation can't be constructed and verified, no run starts
([`RM-SANDBOX-001`](./errors.md#rm-sandbox-001)).

On macOS and Linux this check currently fails with `RM-SANDBOX-001`. Real Seatbelt and bubblewrap
mechanism execution tests are kept as pending qualifications. They won't be required-green CI
checks until backend-empty lifecycle acknowledgement makes their cleanup safe.

## Output capture

Runmill keeps 512 KB per stream, and it keeps the **tail**. The zero-test and focused-execution
detectors read runner summaries there. Skip authority never comes from this truncated text. It
comes from the exact identities in the declared machine-readable report.

## Configuration

```yaml
workspace:
  sandbox: native          # native | none (observe mode only)
  network: proxy           # unrestricted provider egress today | none
  network_allowlist: []    # reserved; non-empty values are rejected
  allow_unenforced: []     # reserved; non-empty values are rejected
```

`allow_unenforced` is reserved for a future per-control acknowledgement flow. Runmill rejects a
non-empty value today, because recording an acknowledgement that no runtime gate reads would be
misleading.

## See also

- [The coverage contract](./verification.md): what runs inside the sandbox and why it is trusted
- [Run lifecycle](./lifecycle.md): where isolation is established
- `runmill doctor --explain sandbox`
