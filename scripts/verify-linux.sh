#!/usr/bin/env bash
#
# Run the suite on Linux, with bubblewrap, in Docker.
#
# Half of runmill's supported platforms are Linux, and the sandbox there is a
# completely different mechanism from macOS Seatbelt — different flags,
# different failure modes, different things it can enforce. Developing on a Mac
# means that half is unexercised until CI says otherwise, and CI is not always
# available (a private repository with exhausted Actions minutes reports a
# billing error rather than running).
#
# So this exists to make the Linux path verifiable from a developer's machine,
# on demand, with no account state involved.
#
#   ./scripts/verify-linux.sh              # full suite
#   ./scripts/verify-linux.sh sandbox      # just the sandbox enforcement tests
#
# --privileged is required for bubblewrap to create user namespaces inside the
# container. That is a property of nested containerization, not of runmill: the
# sandbox needs the same kernel feature it needs on a real host.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-all}"
IMAGE="${RUNMILL_LINUX_IMAGE:-node:22}"

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running. Start Docker and try again." >&2
  exit 1
fi

case "$TARGET" in
  sandbox) VITEST_ARGS="test/workspace/sandbox.test.ts" ;;
  all)     VITEST_ARGS="" ;;
  *)       VITEST_ARGS="$TARGET" ;;
esac

# The repository is mounted read-only and copied inside: node_modules built on
# macOS contains darwin-native binaries (esbuild, rollup, better-sqlite3) that
# cannot load on Linux, so the container must install its own.
docker run --rm --privileged \
  -v "$REPO_ROOT":/src:ro \
  -e "VITEST_ARGS=$VITEST_ARGS" \
  "$IMAGE" bash -euo pipefail -c '
    apt-get update -qq >/dev/null
    apt-get install -y -qq bubblewrap git rsync >/dev/null
    echo "bwrap:  $(bwrap --version)"
    echo "node:   $(node --version)"

    mkdir -p /build && cd /build
    rsync -a --exclude node_modules --exclude .git --exclude dist /src/ /build/

    # git-lease and workspace tests need a repository with an initial commit.
    git init -q -b main .
    git config user.email verify@runmill.local
    git config user.name  "runmill linux verify"
    git add -A >/dev/null 2>&1
    git commit -q -m "linux verification baseline"

    npm ci --silent
    npx tsc --noEmit
    echo "typecheck OK"

    echo "──── doctor ────"
    npx tsx src/cli/main.ts doctor 2>&1 | grep sandbox || true

    echo "──── vitest ────"
    npx vitest run $VITEST_ARGS
  '
