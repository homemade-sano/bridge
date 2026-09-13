#!/bin/sh
# Roblox Bridge — macOS always-on setup.
#
#   sh scripts/macos-service.sh install    # deploy + pm2-logrotate + watchdog LaunchAgent
#   sh scripts/macos-service.sh deploy     # build, copy to APP_DIR, restart under pm2
#   sh scripts/macos-service.sh status
#   sh scripts/macos-service.sh uninstall  # remove LaunchAgent, stop bridge (APP_DIR kept)
#
# Why a copy: launchd jobs cannot read ~/Documents (TCC → "Operation not
# permitted"), so after a reboot a bridge running from the repo would never
# come back. pm2 and the watchdog run the copy in APP_DIR instead.

set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$HOME/Library/Application Support/RobloxBridge/app"
LOG_DIR="$HOME/Library/Logs/RobloxBridge"
LABEL="com.robloxbridge.watchdog"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

port() {
  node -e 'try{console.log(require(process.argv[1]).port||3000)}catch(e){console.log(3000)}' \
    "$APP_DIR/config.json"
}

wait_healthy() {
  p=$(port)
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$p/health" 2>/dev/null; then
      echo "bridge healthy on http://127.0.0.1:$p"
      return 0
    fi
    sleep 0.5
  done
  echo "bridge NOT healthy on :$p — check: pm2 logs bridge" >&2
  return 1
}

deploy() {
  command -v pm2 >/dev/null || { echo "pm2 not on PATH" >&2; exit 1; }

  # Clean build so files removed from src/ don't linger in dist/
  rm -rf "$REPO/dist"
  (cd "$REPO" && npm run build)

  mkdir -p "$APP_DIR"
  rsync -a --delete "$REPO/dist" "$REPO/assets" "$REPO/scripts" "$REPO/node_modules" "$APP_DIR/"
  cp "$REPO/package.json" "$REPO/ecosystem.config.js" "$APP_DIR/"

  # config.json lives in APP_DIR from now on; seed it once from the repo
  if [ ! -f "$APP_DIR/config.json" ] && [ -f "$REPO/config.json" ]; then
    cp "$REPO/config.json" "$APP_DIR/config.json"
  fi

  # Menu bar item (tray). Recompiled only when the Swift source changed.
  if xcrun --find swiftc >/dev/null 2>&1; then
    mkdir -p "$APP_DIR/bin"
    if [ ! "$APP_DIR/bin/bridge-menu" -nt "$REPO/macos/BridgeMenu.swift" ]; then
      echo "compiling menu bar item…"
      xcrun swiftc -O -swift-version 5 "$REPO/macos/BridgeMenu.swift" -o "$APP_DIR/bin/bridge-menu"
    fi
  else
    echo "swiftc not found (xcode-select --install) — skipping menu bar item" >&2
  fi

  # delete + start (not restart) so script path and ecosystem options always apply
  pm2 delete bridge >/dev/null 2>&1 || true
  pm2 delete bridge-tray >/dev/null 2>&1 || true
  (cd "$APP_DIR" && pm2 start ecosystem.config.js >/dev/null)
  pm2 save >/dev/null
  wait_healthy
}

install() {
  deploy

  if ! pm2 describe pm2-logrotate >/dev/null 2>&1; then
    pm2 install pm2-logrotate
    pm2 set pm2-logrotate:max_size 10M >/dev/null
    pm2 set pm2-logrotate:retain 10 >/dev/null
    pm2 save >/dev/null
  fi

  # Explicit PATH: launchd gives jobs a bare one. Never include repo paths.
  svc_path="$(dirname "$(command -v pm2)"):$(dirname "$(command -v node)")"
  svc_path="$svc_path:/opt/homebrew/bin:/usr/local/bin:$HOME/.rokit/bin:$HOME/.aftman/bin"
  svc_path="$svc_path:/usr/bin:/bin:/usr/sbin:/sbin"

  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$APP_DIR/scripts/watchdog.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>30</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$svc_path</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/watchdog.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/watchdog.launchd.log</string>
</dict>
</plist>
EOF

  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "watchdog LaunchAgent loaded ($PLIST)"
}

uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  pm2 delete bridge >/dev/null 2>&1 || true
  pm2 delete bridge-tray >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
  echo "watchdog removed, bridge + menu bar item stopped. Deployed copy kept in: $APP_DIR"
}

status() {
  echo "== launchd"
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "^\s*(state|runs|last exit code)" || echo "watchdog not loaded"
  echo "== pm2"
  pm2 describe bridge 2>/dev/null | grep -E "│ (status|restarts|uptime|script path|exec cwd) " || echo "bridge not in pm2"
  pm2 describe bridge-tray 2>/dev/null | grep -E "│ status " | sed 's/status /tray   /' || echo "menu bar item not in pm2"
  echo "== health"
  wait_healthy || true
  echo "== last watchdog actions"
  tail -n 5 "$LOG_DIR/watchdog.log" 2>/dev/null || echo "(none)"
}

case "${1:-}" in
  install) install ;;
  deploy) deploy ;;
  status) status ;;
  uninstall) uninstall ;;
  *) echo "usage: $0 install|deploy|status|uninstall" >&2; exit 2 ;;
esac
