#!/usr/bin/env bash
# One-time setup of PlayBet on a fresh Ubuntu 24.04 server. Run as root from the cloned project:
#   bash /opt/playbet/scripts/setup-server.sh
# It installs Docker, a firewall and automatic security updates, asks for the site address and master
# password, starts the site with HTTPS, and switches on automatic updates and nightly backups.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

if [ "$(id -u)" -ne 0 ]; then echo "Please run this as root (or with sudo)."; exit 1; fi

echo "== Installing Docker, firewall and automatic security updates (a few minutes)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io docker-compose-v2 git sqlite3 ufw unattended-upgrades
systemctl enable --now docker
dpkg-reconfigure -f noninteractive unattended-upgrades

ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

if [ -f .env ]; then
  echo "== Keeping the existing settings in $APP_DIR/.env"
else
  echo
  echo "== A few questions"
  read -rp "Site address (e.g. ourbets.duckdns.org): " DOMAIN
  read -rp "Site name shown to players [PlayBet]: " SITE_NAME
  SITE_NAME="${SITE_NAME:-PlayBet}"
  while true; do
    read -rsp "Master password (at least 8 characters, not shown as you type): " ADMIN_PASSWORD; echo
    read -rsp "Type it again: " AGAIN; echo
    if [[ "$ADMIN_PASSWORD" == *"'"* ]]; then echo "Please don't use the ' character. Try again."; continue; fi
    if [ "${#ADMIN_PASSWORD}" -ge 8 ] && [ "$ADMIN_PASSWORD" = "$AGAIN" ]; then break; fi
    echo "Those didn't match or were too short. Try again."
  done
  umask 077
  # Values in single quotes are taken literally by Docker Compose ($, spaces and all).
  cat > .env <<ENV
DOMAIN=$DOMAIN
SITE_NAME='${SITE_NAME//\'/}'
ADMIN_USERNAME=admin
ADMIN_PASSWORD='$ADMIN_PASSWORD'
FOOTBALL_ENABLED=false
RACING_ENABLED=true
RACING_SOURCE=nrc
NRC_TRACKS=CY-NICOSIA-TH
NRC_RACE_DAYS=wed,sun
NRC_PLACES_PAID=2
ENV
  umask 022
fi

echo "== Building and starting the site…"
docker compose up -d --build
git rev-parse HEAD > .deployed-commit

echo "== Switching on automatic updates (every 5 minutes) and nightly backups (03:30)…"
chmod +x scripts/update.sh scripts/backup.sh
cat > /etc/systemd/system/playbet-update.service <<UNIT
[Unit]
Description=Update PlayBet from GitHub
After=docker.service network-online.target
[Service]
Type=oneshot
ExecStart=$APP_DIR/scripts/update.sh
UNIT
cat > /etc/systemd/system/playbet-update.timer <<UNIT
[Unit]
Description=Check GitHub for PlayBet updates every 5 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/playbet-backup.service <<UNIT
[Unit]
Description=Back up the PlayBet database
After=docker.service
[Service]
Type=oneshot
ExecStart=$APP_DIR/scripts/backup.sh
UNIT
cat > /etc/systemd/system/playbet-backup.timer <<UNIT
[Unit]
Description=Back up PlayBet every night
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now playbet-update.timer playbet-backup.timer

DOMAIN_SHOWN="$(grep '^DOMAIN=' .env | cut -d= -f2- | cut -d, -f1)"
echo
echo "=================================================================="
echo " Done. In a minute or two, open:  https://$DOMAIN_SHOWN"
echo " Log in as:  admin   with the master password you chose."
echo " Updates are installed automatically; backups are in /opt/playbet-backups."
echo "=================================================================="
