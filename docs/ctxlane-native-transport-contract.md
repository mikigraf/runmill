# Runmill ↔ ctxlane native transport contract

This document is a deployment contract. It is neither an implementation nor a
qualification result. The repository now contains an optional Linux native
source-build path and reports the contract as `status: implemented-unqualified`.
A missing or incompatible addon is still reported as `unavailable`, and the
newline-delimited Unix stream fixture is still refused for authority-bearing
identity acquisition.

## Required native boundary

The future first-party Runmill controller must connect directly from the
Runmill controller process to the operator-owned ctxlane socket, using all of
the following:

- `AF_UNIX` + `SOCK_SEQPACKET`, with `CLOEXEC` set.
- One bounded JSON record per `sendmsg`/`recvmsg` operation. Stream framing,
  newline framing, and helper-process forwarding do not substitute for this.
- A pathname snapshot taken before connect and checked after connect. It covers
  the device/inode of the socket and of its parent directory, plus ownership,
  type, and private mode.
- Linux peer authentication using `SO_PEERCRED`, `SO_PEERPIDFD`, and
  `SO_PASSCRED` with exactly one matching `SCM_CREDENTIALS` record, and no
  unexpected ancillary descriptors.
- pidfd/process revalidation across receive and send, including the
  executable's device/inode/digest and the protected cgroup-v2/systemd identity.
- The exact `ctxlane.identity-lease-request/v1` acquisition request, answered
  by either `ctxlane.identity-lease/v1` or the correlated
  `ctxlane.automation-error/v1` response. Duplicate JSON members are rejected.
- A separately published private lifecycle response contract for renewal,
  close, and revocation. Capability-free `ctxlane.lease-view/v1` receipts are
  never sufficient to authorize Runmill lifecycle transitions.

The protected deployment must configure the trusted controller executable,
uid/gid, cgroup-v2 path, systemd unit, socket path, and maximum record size,
and bind them to the ctxlane authority. None of these values can be redirected
by repository configuration, `ctxlane use`, PATH lookup, or a child process.

## Current refusal boundary

Node's `node:net` API exposes Unix stream sockets. It does not expose the Linux
`SOCK_SEQPACKET` and peer-pidfd/credential operations this contract requires.
That is why the repository's `native/ctxlane_seqpacket.c` addon is built only
by the explicit Linux source-build script. Linux packages may contain that
source-built artifact. macOS and unsupported builds intentionally leave it out.
No deployment may treat the artifact being available as qualification.

The three clients behave as follows:

- `CtxlaneNativeSeqpacketAutomationClient` refuses when the artifact or the
  operator-pinned executable/cgroup policy is absent.
- `CtxlaneUnixAutomationClient` is still a newline-delimited `SOCK_STREAM`
  fixture and requires the explicit `allowDevelopmentOnlyTransport: true` test
  opt-in. The default stream path refuses before opening the socket.
- `CtxlaneStdioAutomationClient` is still an observation-only bridge. It cannot
  acquire or mutate an identity lease.

No external helper may be used to get around this boundary. ctxlane attests
the process that opened the socket, so a helper would be a different principal
and cannot impersonate Runmill's configured executable/cgroup. A deployment may
claim native transport qualification only after it implements the direct
client, the private lifecycle contract, and the Linux negative tests for: wrong
peer, stale/replaced socket, oversized/truncated/duplicate frames, ancillary
rights, pid reuse, executable replacement, cgroup mismatch, and service
restart/generation change.
