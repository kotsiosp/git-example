#!/usr/bin/env bash
# Run every 5 minutes by playbet-update.timer: if GitHub has newer code than what is running, rebuild
# and restart the site. If the new version fails to build, the running site is left as it is and the
# build is tried again on the next run.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
LOG=/var/log/playbet-update.log
DEPLOYED=.deployed-commit   # the commit the running site was built from

git fetch --quiet origin
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
TARGET="$(git rev-parse "origin/$BRANCH")"
if [ "$TARGET" = "$(cat "$DEPLOYED" 2>/dev/null)" ]; then exit 0; fi

{
  echo "== $(date -Is) updating to ${TARGET:0:7}"
  git merge --ff-only --quiet "origin/$BRANCH"
  if docker compose build app; then
    docker compose up -d
    echo "$TARGET" > "$DEPLOYED"
    echo "== updated"
  else
    echo "== build failed; the previous version keeps running, and the build will be tried again"
    exit 1
  fi
} >>"$LOG" 2>&1
