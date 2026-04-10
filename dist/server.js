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
app.post("/proxy", async (req, res) => {
    const { Url, Method = "GET", Headers = {}, Body, Compress, Timeout } = req.body;
    if (!Url) {
        res.status(400).json({ error: "Url is required" });
        return;
    }
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
app.listen(PORT, "127.0.0.1", () => {
    console.log(`Bridge running on http://127.0.0.1:${PORT}`);
});
