#!/usr/bin/env bash
# Run nightly by playbet-backup.timer: a consistent copy of the database (accounts, bets, master log),
# keeping the last 14 days in /opt/playbet-backups.
set -euo pipefail
DEST=/opt/playbet-backups
mkdir -p "$DEST"
VOLUME="$(docker volume ls -q | grep -E '_playbet-data$' | head -n1)"
SRC="$(docker volume inspect -f '{{ .Mountpoint }}' "$VOLUME")/playbet.db"
sqlite3 "$SRC" ".backup '$DEST/playbet-$(date +%F).db'"
find "$DEST" -name 'playbet-*.db' -mtime +14 -delete
