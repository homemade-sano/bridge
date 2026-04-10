import SysTray from "systray2";
import { exec } from "child_process";
import http from "http";
import path from "path";
import fs from "fs";
import os from "os";
import sharp from "sharp";
import { readConfig, writeConfig } from "./config";

// ---------------------------------------------------------------------------
// Load assets/systray.webp → base64 ICO (Windows systray requires ICO)
// Modern ICO format supports embedded PNG data (Vista+)
// ---------------------------------------------------------------------------
function pngToIco(pngBuffer: Buffer): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: ICO
  header.writeUInt16LE(1, 4); // count: 1

  const entry = Buffer.alloc(16);
  entry[0] = 16;                             // width
  entry[1] = 16;                             // height
  entry[2] = 0;                              // color count
  entry[3] = 0;                              // reserved
  entry.writeUInt16LE(1, 4);                 // planes
  entry.writeUInt16LE(32, 6);                // bit depth
  entry.writeUInt32LE(pngBuffer.length, 8);  // data size
  entry.writeUInt32LE(22, 12);               // data offset (6 + 16)

  return Buffer.concat([header, entry, pngBuffer]);
}

async function loadIcon(): Promise<string> {
  const webpPath = path.join(__dirname, "..", "assets", "systray.webp");
  const png = await sharp(webpPath).resize(16, 16).png().toBuffer();
  return pngToIco(png).toString("base64");
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
function checkHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/health", timeout: 1000 },
      (res) => resolve(res.statusCode === 200)
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// ---------------------------------------------------------------------------
// Windows InputBox via cscript (no extra deps)
// ---------------------------------------------------------------------------
function promptPort(currentPort: number): Promise<number | null> {
  return new Promise((resolve) => {
    const vbs = `WScript.Echo InputBox("Enter new port number:", "Roblox Bridge", "${currentPort}")`;
    const tmp = path.join(os.tmpdir(), "bridge_port_prompt.vbs");
    fs.writeFileSync(tmp, vbs);
    exec(`cscript //NoLogo "${tmp}"`, (err, stdout) => {
      fs.unlinkSync(tmp);
      if (err || !stdout.trim()) return resolve(null);
      const port = parseInt(stdout.trim(), 10);
      resolve(port > 0 && port < 65536 ? port : null);
    });
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
(async () => {
  const icon = await loadIcon();
  let currentPort = readConfig().port || 3000;
  let lastRunning: boolean | null = null;

  const itemStatus = {
    title: "Checking...",
    tooltip: `http://127.0.0.1:${currentPort}`,
    checked: false,
    enabled: false,
  };

  const itemChangePort = {
    title: `Change Port (current: ${currentPort})`,
    tooltip: "",
    checked: false,
    enabled: true,
    async click() {
      const newPort = await promptPort(currentPort);
      if (!newPort || newPort === currentPort) return;

      writeConfig({ port: newPort });
      currentPort = newPort;

      itemChangePort.title = `Change Port (current: ${currentPort})`;
      itemStatus.tooltip = `http://127.0.0.1:${currentPort}`;
      lastRunning = null;

      systray.sendAction({ type: "update-item", item: itemChangePort });
      exec("pm2 restart bridge", () => updateStatus());
    },
  };

  const itemLogs = {
    title: "Open Logs",
    tooltip: "",
    checked: false,
    enabled: true,
    click() { exec(`cmd /c start cmd /k "pm2 logs bridge"`); },
  };

  const itemRestart = {
    title: "Restart Bridge",
    tooltip: "",
    checked: false,
    enabled: true,
    click() { exec("pm2 restart bridge"); },
  };

  const itemQuit = {
    title: "Quit Tray",
    tooltip: "",
    checked: false,
    enabled: true,
    click() { systray.kill(false); process.exit(0); },
  };

  const systray = new SysTray({
    menu: {
      icon,
      title: "",
      tooltip: "Roblox Bridge",
      items: [
        itemStatus,
        SysTray.separator,
        itemChangePort,
        itemLogs,
        itemRestart,
        SysTray.separator,
        itemQuit,
      ],
    },
    debug: false,
    copyDir: false,
  });

  systray.onClick((action) => {
    if (typeof (action.item as typeof itemChangePort).click === "function") {
      (action.item as typeof itemChangePort).click();
    }
  });

  async function updateStatus() {
    const running = await checkHealth(currentPort);
    if (running === lastRunning) return;
    lastRunning = running;
    itemStatus.title = running ? `● Running on :${currentPort}` : "○ Stopped";
    itemStatus.tooltip = `http://127.0.0.1:${currentPort}`;
    systray.sendAction({ type: "update-item", item: itemStatus });
  }

  systray.ready().then(() => {
    updateStatus();
    setInterval(updateStatus, 5000);
  });
})();
