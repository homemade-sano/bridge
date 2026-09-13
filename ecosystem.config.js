const fs = require("fs");
const path = require("path");

// Native menu bar item, compiled by scripts/macos-service.sh deploy
const MAC_MENU = path.join(__dirname, "bin", "bridge-menu");

// Restart policy shared by both apps: crash → restart with exponential backoff
// (100ms doubling up to 15s) so a crash loop never ends in pm2's "errored"
// state; leak → restart past 300MB.
const resilience = {
  cwd: __dirname,
  autorestart: true,
  watch: false,
  exp_backoff_restart_delay: 100,
  min_uptime: "10s",
  max_restarts: 1000,
  max_memory_restart: "300M",
  kill_timeout: 5000,
};

module.exports = {
  apps: [
    { name: "bridge", script: "dist/server.js", ...resilience },
    // Tray: dist/tray.js is Windows-only (ICO icon, cscript prompt, cmd log
    // window); macOS uses the native binary from macos/BridgeMenu.swift
    ...(process.platform === "win32"
      ? [{ name: "bridge-tray", script: "dist/tray.js", ...resilience }]
      : []),
    ...(process.platform === "darwin" && fs.existsSync(MAC_MENU)
      ? // Relative script: pm2 wraps a script path containing spaces
        // ("Application Support") in `bash -c`, which then splits it
        [{ name: "bridge-tray", script: "bin/bridge-menu", interpreter: "none", ...resilience }]
      : []),
  ],
};
