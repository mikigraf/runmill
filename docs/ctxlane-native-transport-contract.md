# Runmill ↔ ctxlane native transport contract

This document is a deployment contract, not an implementation or a
qualification result. The repository now contains an optional Linux native
source-build path and reports the contract as
`status: implemented-unqualified`; a missing or incompatible addon remains
`unavailable`, and the newline-delimited Unix stream fixture is still refused
for authority-bearing identity acquisition.

## Required native boundary

The future first-party Runmill controller must connect directly from the
Runmill controller process to the operator-owned ctxlane socket using:

- `AF_UNIX` + `SOCK_SEQPACKET`, with `CLOEXEC` set;
- one bounded JSON record per `sendmsg`/`recvmsg` operation; stream framing,
  newline framing, and helper-process forwarding are not substitutes;
- a pathname snapshot taken before connect and checked after connect, covering
  socket and parent-directory device/inode, ownership, type, and private mode;
- Linux peer authentication using `SO_PEERCRED`, `SO_PEERPIDFD`, and
  `SO_PASSCRED`/exactly one matching `SCM_CREDENTIALS` record, with no
  unexpected ancillary descriptors;
- pidfd/process revalidation across receive and send, including executable
  device/inode/digest and protected cgroup-v2/systemd identity;
- the exact `ctxlane.identity-lease-request/v1` acquisition request and either
  `ctxlane.identity-lease/v1` or the correlated
  `ctxlane.automation-error/v1` response, with duplicate JSON members rejected;
- a separately published private lifecycle response contract for renewal,
  close, and revocation. Capability-free `ctxlane.lease-view/v1` receipts are
  never sufficient to authorize Runmill lifecycle transitions.

The trusted controller executable, uid/gid, cgroup-v2 path, systemd unit,
socket path, and maximum record size must be configured by the protected
deployment and bound to the ctxlane authority. Repository configuration,
`ctxlane use`, PATH lookup, and a child process cannot redirect any of these
values.

## Current refusal boundary

Node's `node:net` API exposes Unix stream sockets, not the required Linux
`SOCK_SEQPACKET` plus peer-pidfd/credential operations. The repository's
`native/ctxlane_seqpacket.c` addon is therefore built only by the explicit
Linux source-build script. Linux packages may contain that source-built
artifact; macOS and unsupported builds intentionally omit it, and no
deployment may treat artifact availability as qualification.
`CtxlaneNativeSeqpacketAutomationClient` refuses when the artifact or
operator-pinned executable/cgroup policy is absent. The
`CtxlaneUnixAutomationClient` remains a newline-delimited `SOCK_STREAM` fixture
and requires the explicit `allowDevelopmentOnlyTransport: true` test opt-in.
The default stream path refuses before opening the socket.
`CtxlaneStdioAutomationClient` remains an observation-only bridge and cannot
acquire or mutate an identity lease.

No external helper may be used to bypass this boundary: ctxlane attests the
process that opened the socket, so a helper would be a different principal
and cannot impersonate Runmill's configured executable/cgroup. A deployment
may claim native transport qualification only after implementing the direct
client, private lifecycle contract, and the Linux negative tests for wrong
peer, stale/replaced socket, oversized/truncated/duplicate frames, ancillary
rights, pid reuse, executable replacement, cgroup mismatch, and service
restart/generation change.
