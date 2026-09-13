#!/bin/sh
# Roblox Bridge watchdog (macOS). Run by launchd at login and every 30s
# (installed by scripts/macos-service.sh). Runs from the deployed copy, never
# from ~/Documents, which launchd jobs cannot read.
#
# Healthy → exit silently. Unhealthy twice in a row → restart the bridge under
# pm2 (the pm2 CLI respawns its daemon if it died); if pm2 lost the process
# (reboot, `pm2 kill`), resurrect it from the saved dump or the ecosystem file.
# Only recovery actions are logged.

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR" || exit 1

LOG_DIR="$HOME/Library/Logs/RobloxBridge"
LOG="$LOG_DIR/watchdog.log"
mkdir -p "$LOG_DIR"
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

PORT=$(node -e 'try{console.log(require("./config.json").port||3000)}catch(e){console.log(3000)}' 2>/dev/null)
PORT=${PORT:-3000}

healthy() { curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; }

healthy && exit 0
sleep 3
healthy && exit 0

if [ ! -f dist/server.js ]; then
  log "dist/server.js missing in $APP_DIR — redeploy"
  exit 1
fi

if pm2 describe bridge >/dev/null 2>&1; then
  log "/health failed on :$PORT — pm2 restart bridge"
  pm2 restart bridge >/dev/null 2>&1
else
  log "bridge not in pm2 — pm2 resurrect"
  pm2 resurrect >/dev/null 2>&1
  if ! pm2 describe bridge >/dev/null 2>&1; then
    log "bridge not in pm2 dump — starting from ecosystem.config.js"
    pm2 start ecosystem.config.js --only bridge >/dev/null 2>&1 && pm2 save >/dev/null 2>&1
  fi
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if healthy; then
    log "recovered"
    exit 0
  fi
  sleep 1
done
log "still unhealthy after recovery attempt (see: pm2 logs bridge)"
exit 1
