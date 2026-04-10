"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const systray2_1 = __importDefault(require("systray2"));
const child_process_1 = require("child_process");
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const sharp_1 = __importDefault(require("sharp"));
const config_1 = require("./config");
// ---------------------------------------------------------------------------
// Load assets/systray.webp → base64 ICO (Windows systray requires ICO)
// Modern ICO format supports embedded PNG data (Vista+)
// ---------------------------------------------------------------------------
function pngToIco(pngBuffer) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: ICO
    header.writeUInt16LE(1, 4); // count: 1
    const entry = Buffer.alloc(16);
    entry[0] = 16; // width
    entry[1] = 16; // height
    entry[2] = 0; // color count
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bit depth
    entry.writeUInt32LE(pngBuffer.length, 8); // data size
    entry.writeUInt32LE(22, 12); // data offset (6 + 16)
    return Buffer.concat([header, entry, pngBuffer]);
}
async function loadIcon() {
    const webpPath = path_1.default.join(__dirname, "..", "assets", "systray.webp");
    const png = await (0, sharp_1.default)(webpPath).resize(16, 16).png().toBuffer();
    return pngToIco(png).toString("base64");
}
// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
function checkHealth(port) {
    return new Promise((resolve) => {
        const req = http_1.default.get({ hostname: "127.0.0.1", port, path: "/health", timeout: 1000 }, (res) => resolve(res.statusCode === 200));
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
    });
}
// ---------------------------------------------------------------------------
// Windows InputBox via cscript (no extra deps)
// ---------------------------------------------------------------------------
function promptPort(currentPort) {
    return new Promise((resolve) => {
        const vbs = `WScript.Echo InputBox("Enter new port number:", "Roblox Bridge", "${currentPort}")`;
        const tmp = path_1.default.join(os_1.default.tmpdir(), "bridge_port_prompt.vbs");
        fs_1.default.writeFileSync(tmp, vbs);
        (0, child_process_1.exec)(`cscript //NoLogo "${tmp}"`, (err, stdout) => {
            fs_1.default.unlinkSync(tmp);
            if (err || !stdout.trim())
                return resolve(null);
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
    let currentPort = (0, config_1.readConfig)().port || 3000;
    let lastRunning = null;
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
            if (!newPort || newPort === currentPort)
                return;
            (0, config_1.writeConfig)({ port: newPort });
            currentPort = newPort;
            itemChangePort.title = `Change Port (current: ${currentPort})`;
            itemStatus.tooltip = `http://127.0.0.1:${currentPort}`;
            lastRunning = null;
            systray.sendAction({ type: "update-item", item: itemChangePort });
            (0, child_process_1.exec)("pm2 restart bridge", () => updateStatus());
        },
    };
    const itemLogs = {
        title: "Open Logs",
        tooltip: "",
        checked: false,
        enabled: true,
        click() { (0, child_process_1.exec)(`cmd /c start cmd /k "pm2 logs bridge"`); },
    };
    const itemRestart = {
        title: "Restart Bridge",
        tooltip: "",
        checked: false,
        enabled: true,
        click() { (0, child_process_1.exec)("pm2 restart bridge"); },
    };
    const itemQuit = {
        title: "Quit Tray",
        tooltip: "",
        checked: false,
        enabled: true,
        click() { systray.kill(false); process.exit(0); },
    };
    const systray = new systray2_1.default({
        menu: {
            icon,
            title: "",
            tooltip: "Roblox Bridge",
            items: [
                itemStatus,
                systray2_1.default.separator,
                itemChangePort,
                itemLogs,
                itemRestart,
                systray2_1.default.separator,
                itemQuit,
            ],
        },
        debug: false,
        copyDir: false,
    });
    systray.onClick((action) => {
        if (typeof action.item.click === "function") {
            action.item.click();
        }
    });
    async function updateStatus() {
        const running = await checkHealth(currentPort);
        if (running === lastRunning)
            return;
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
