# The sandbox

> Implemented in [`src/workspace/sandbox.ts`](../src/workspace/sandbox.ts).

runmill runs the coding agent as an **untrusted process**. It gets your source tree and nothing
else: no SSH keys, no cloud credentials, no GitHub token, no keychain. That is enforced by the
operating system, not by asking the agent nicely in a prompt.

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

Seatbelt has no network namespace. On macOS, `workspace.network: proxy` is the only enforceable
setting — egress goes through a runmill-operated proxy with a host allowlist rather than being
scoped by the kernel. `runmill doctor` reports this as a warning rather than silently implying
protection it cannot deliver.

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

## Environment

The environment is built by **allowlist**, not by filtering:

```ts
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "TMPDIR", "USER", "SHELL"];
```

Everything else is dropped, so a variable nobody anticipated is excluded by default rather than
inherited until someone notices.

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

## The one credential inside the boundary

The provider's own credential file is readable inside the sandbox, because the CLI cannot
authenticate without it. That is deliberate and it is the only exception — scoped to the provider,
and stated rather than hidden. Every other credential is denied.

## Everything runs inside it

Both the agent **and** every verification check run wrapped:

```ts
const outcome = await this.#sandbox.run({
  command, args,
  cwd: verifyPath,
  policy: { writablePaths: [verifyPath], allowNetwork: false },
});
```

Checks execute with network disabled and only the verification checkout writable. A test suite is
arbitrary code from the same repository the agent just modified; sandboxing the agent while
running its tests unconfined would leave the boundary open at exactly the moment the agent's
output gets executed.

The provider CLI runs with **its own** sandbox disabled inside runmill's, so there is one
enforcement layer rather than two half-configured ones.

## Proof, not assertion

`doctor` does not check whether a sandbox mechanism exists. It builds one, tries to read `~/.ssh`
from inside it, and fails if that succeeds:

```
✓ sandbox:mechanism             sandbox-exec (Seatbelt)
✓ sandbox:deny-credential-read  read denied
! sandbox:network               Seatbelt cannot scope network by host
```

There is no silent downgrade. If isolation cannot be constructed and verified, no run starts —
[`RM-SANDBOX-001`](./errors.md#rm-sandbox-001).

On Linux, `setting up uid map: Permission denied` means unprivileged user namespaces are disabled:

```bash
sudo sysctl -w kernel.unprivileged_userns_clone=1
```

## Output capture

512 KB is retained per stream, keeping the **tail**. The detectors that decide merge-readiness —
zero-tests, focused execution, skip counts — all read summary lines at the end of output. Keeping
the head would discard exactly the lines the verdict depends on.

## Configuration

```yaml
workspace:
  sandbox: native          # native | container | none
  network: proxy           # proxy | none
  network_allowlist:
    - registry.npmjs.org
  allow_unenforced: []     # controls you accept cannot be enforced here
```

`allow_unenforced` is an explicit acknowledgement, per control, that a platform cannot enforce
something. It exists so that running on a limited platform is a decision someone made and can be
audited, rather than a default nobody noticed.

## See also

- [The coverage contract](./verification.md) — what runs inside the sandbox and why it is trusted
- [Run lifecycle](./lifecycle.md) — where isolation is established
- `runmill doctor --explain sandbox`
