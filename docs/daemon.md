# Daemon operation

The background process is the **Repeat** step in Runmill's backlog-to-PR loop. It watches the
configured backlog, does one engineering run at a time, and waits when nothing is eligible. Add a
new eligible issue and the next poll picks it up.

```bash
runmill start
runmill status
runmill tui
runmill stop
```

`start`, `status`, and `stop` are what you use day to day. `status` and `stop` talk to the
user-private control socket, so they work from any directory and don't need a configuration path.
`stop` asks for shutdown at the next safe orchestration boundary. It won't abandon a lease or a
partially recorded external operation.

On startup the daemon acquires an atomic user-private ownership record before it touches the
control socket or registry. A second starter refuses while that owner is live or can't be
identified, and reclaims the paths only once the recorded PID is definitely gone. Invalid registries
and ownership records are kept for diagnosis instead of being overwritten.

When autonomy is `observe`, `start` and `daemon` refuse to create a delivery loop. That mode may
inspect backlog state but may not execute work. `start` and `daemon --detach` still check for and
report a daemon that's already running, so changing configuration can't hide older automation that
is still active.

The default idle poll interval is 30 seconds. You can change it when you start the background
process:

```bash
runmill start --poll-seconds 60
```

`runmill daemon` is still there as the advanced foreground interface, for service supervisors,
bounded runs, and draining the queue:

```bash
runmill daemon
runmill daemon --poll-seconds 60
runmill daemon --once
runmill daemon --once --max-runs 5
runmill daemon --detach     # lower-level equivalent of runmill start
```

`--once` does not mean one issue. It processes everything currently eligible, then exits. Use
`--max-runs 1` when you want exactly one run.

## Idle and stop behavior

An empty queue is just idle. It isn't an error. Runmill prints the next poll time once, then stays
quiet until work shows up or you stop it. Selection runs again after every poll, so state, labels,
priorities, leases, and repository routing are never cached across the idle period.

The daemon stops when:

- it receives `SIGINT` or `SIGTERM`;
- `--max-runs` is reached;
- a circuit breaker opens; or
- the queue drains in `--once` mode.

A signal takes effect between runs. Runmill lets the active orchestration boundary finish so it
doesn't abandon a lease or a half-recorded side effect.

## Keeping the host awake

Runmill holds a native sleep inhibitor for the complete daemon session and for individual
`runmill run` executions:

- macOS: `caffeinate` display, idle-sleep, disk, system-sleep, and user-active assertions tied to
  the exact Runmill process with `-w`
- Linux: a `systemd-inhibit` block for idle, sleep, suspend/hibernate, and lid-switch handling,
  backed by a shell-free watcher for the exact Runmill process

That keeps the display from idling and the system from idle-sleeping or suspending while work may
be running. On a normal shutdown Runmill terminates the whole inhibitor process group. If Runmill is
killed abruptly, `caffeinate` or the Linux parent watcher exits when its Runmill process disappears,
so the inhibitor can't be left orphaned. There's no giant timeout, infinite sleep, or persistent
power setting involved.

If the native command is missing, Runmill prints a warning and carries on. That's what you want on
a headless host where suspend is already disabled, and on a laptop the warning makes the weaker
guarantee visible.

## Reviews start clean

The reviewer is a separate agent invocation with a new context. It gets the issue, acceptance
criteria, diff, and verification evidence. It doesn't get the implementer's conversation or
reasoning. If you also want an independent model, configure a different CLI or model under
`providers.reviewer`.

Review can send the change back through a bounded fix loop. New code from a fixer is verified and
reviewed again. We never accept it because the fixer says it's fine.

## Operations and DevEx

Before leaving a daemon unattended:

```bash
runmill config validate
runmill doctor
runmill next
```

During and after operation:

```bash
runmill status
runmill tui
runmill list
runmill list --needs-attention
runmill inspect <run-id>
runmill state
runmill stop
```

### OpenTUI dashboard

`runmill tui` connects to the active daemon over a user-private Unix socket. You can launch it
from any directory, because configuration discovery, repository paths, and SQLite access all stay
inside the daemon.

![Runmill OpenTUI with recent runs, transition history, agent events, and live daemon logs](https://raw.githubusercontent.com/mikigraf/runmill/main/assets/runmill-tui.png)

The CLI hands the TUI process to Bun automatically. The
[OpenTUI native renderer](https://opentui.com/docs/getting-started/) currently needs Bun, or Node
26.4+ with experimental FFI; Runmill supports Node 22 and 24 for the daemon and all non-TUI
commands. If Bun is missing, `runmill tui` exits with an installation hint instead of opening a
broken screen.

The dashboard includes:

- current daemon phase, process ID, repository, sleep inhibitor, and active issue;
- recent runs with state, repository, and provider;
- the selected issue's progress from claim through merge policy;
- transition history, normalized agent events, and pending external effects for the selected run;
- a live daemon activity log; and
- a safe stop action that takes effect at the next orchestration boundary.

Keyboard controls:

| Key | Action |
|---|---|
| `↑` / `↓` | Select a run |
| `r` | Refresh immediately |
| `s` | Ask the daemon to stop safely |
| `q` or `Ctrl-C` | Close the TUI without stopping the daemon |

The registry is stored in `$XDG_RUNTIME_DIR/runmill/daemon.json` when available and otherwise in
`~/.runmill/daemon.json`. Both the registry and socket are mode `0600`. Only one active Runmill
daemon is registered per user session. A policy may use several routing rules, but every rule must
target the same local GitHub repository in this release. One active daemon manages one checkout,
so stop it before switching the session to another repository. Cross-repo checkout and delivery
aren't implemented.

Run state and evidence live outside the repository under
`$XDG_STATE_HOME/runmill/projects/<project-id>/` on Linux, falling back to
`~/.local/state/runmill/projects/<project-id>/`. On macOS the default is
`~/Library/Application Support/runmill/projects/<project-id>/`. `RUNMILL_DATA_DIR` overrides the
location. Completed deliveries are also appended to `log.md` in that same project-state directory,
with local `DD/MM/YYYY HH:mm` timestamps, issue and PR links, result, cost, and run ID. The Markdown
file is an activity journal. SQLite is still the source of truth for recovery.

Use `--json` for supervisors and scripts. Runmill uses stable exit codes and writes non-essential
human output only when `--quiet` is not set.

## Backlog support

Internally the daemon doesn't care which backlog it talks to, but Linear is the only live issue
adapter today. GitHub handles repositories, pull requests, CI, branch protection, and merges.
Unsupported backlog providers are rejected during configuration validation, so they fail before the
daemon starts instead of after.

## Running in the background or as a service

`runmill start` starts the same daemon in the background and writes its standard output and errors
to `daemon.log` in the project state directory described above. The control registry makes it
discoverable by `runmill status`, `runmill stop`, and `runmill tui` regardless of the client's
working directory.

Foreground mode works fine under launchd, systemd, or a container supervisor. Runmill doesn't
generate native service units yet.

Whichever supervisor you use, give `SIGTERM` enough time for an in-flight issue to reach a safe
boundary. Don't configure the supervisor to restart a circuit-breaker exit immediately. That
defeats the breaker. Daily spend is reconstructed from the durable budget ledger. Quarantine,
consecutive-failure, and escalation-rate counters and trips are also durable in SQLite, so a daemon
restart cannot reset an opened breaker.
