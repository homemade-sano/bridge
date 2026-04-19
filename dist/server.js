"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const config_1 = require("./config");
const app = (0, express_1.default)();
const PORT = Number(process.env.PORT) || (0, config_1.readConfig)().port || 3000;
app.use(express_1.default.json());
// POST /proxy
// Body mirrors Roblox's HttpService:RequestAsync dictionary:
//   Url      (string, required)  - target URL
//   Method   (string)            - HTTP method, defaults to "GET"
//   Headers  (object)            - request headers
//   Body     (string)            - request body
//   Compress (string)            - "None" | "Gzip"
//   Timeout  (number)            - timeout in seconds
//
// Response mirrors HttpService:RequestAsync response dictionary:
//   Success       (bool)
//   StatusCode    (number)
//   StatusMessage (string)
//   Headers       (object)
//   Body          (string)
function ts() {
    return new Date().toISOString();
}
app.post("/proxy", async (req, res) => {
    const { Url, Method = "GET", Headers = {}, Body, Compress, Timeout } = req.body;
    if (!Url) {
        console.warn(`[${ts()}] [POST /proxy] 400 missing Url`);
        res.status(400).json({ error: "Url is required" });
        return;
    }
    console.log(`[${ts()}] [POST /proxy] → ${Method} ${Url}`);
    try {
        const axiosConfig = {
            url: Url,
            method: Method,
            headers: Headers,
            // Return raw string so Body is always a string (matching Roblox's response)
            responseType: "text",
            validateStatus: () => true, // never throw on HTTP error codes
        };
        if (Body !== undefined && Body !== null) {
            axiosConfig.data = Body;
        }
        if (Timeout && Timeout > 0) {
            axiosConfig.timeout = Timeout * 1000;
        }
        if (Compress === "Gzip") {
            axiosConfig.decompress = true;
        }
        const response = await (0, axios_1.default)(axiosConfig);
        const statusCode = response.status;
        console.log(`[${ts()}] [POST /proxy] ← ${statusCode} ${Url}`);
        res.json({
            Success: statusCode >= 200 && statusCode <= 299,
            StatusCode: statusCode,
            StatusMessage: response.statusText,
            Headers: response.headers,
            Body: response.data,
        });
    }
    catch (err) {
        // Network-level errors (timeout, unreachable, etc.)
        console.error(`[${ts()}] [POST /proxy] error ${Url} — ${err.message}`);
        res.status(500).json({
            Success: false,
            StatusCode: 0,
            StatusMessage: err.message,
            Headers: {},
            Body: "",
        });
    }
});
app.get("/health", (_req, res) => res.sendStatus(200));
const startTime = Date.now();
app.get("/status", (_req, res) => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    console.log(`[${ts()}] [GET /status] uptime: ${uptime}s`);
    res.json({
        status: "ok",
        port: PORT,
        uptimeSeconds: uptime,
    });
});
app.listen(PORT, "127.0.0.1", () => {
    console.log(`Bridge running on http://127.0.0.1:${PORT}`);
});
