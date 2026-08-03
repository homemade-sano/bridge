import express, { Request, Response } from "express";
import axios, { AxiosRequestConfig } from "axios";
import { readConfig } from "./config";
import { handleDeploy } from "./deploy";
import { handleListPlaces, handleCreatePlace } from "./places";
import { handleClipboard } from "./clipboard";
import {
  handleSetApiKey,
  handleGetApiKey,
  handleDeleteApiKey,
  handleListApiKeys,
} from "./apikeys";

const app = express();
const PORT = Number(process.env.PORT) || readConfig().port || 3000;

// 5mb: clipboard payloads and proxied bodies can exceed the 100kb default
app.use(express.json({ limit: "5mb" }));

interface ProxyRequestBody {
  Url: string;
  Method?: string;
  Headers?: Record<string, string>;
  Body?: string;
  Compress?: "None" | "Gzip";
  Timeout?: number;
}

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

app.post("/proxy", async (req: Request, res: Response) => {
  const { Url, Method = "GET", Headers = {}, Body, Compress, Timeout } =
    req.body as ProxyRequestBody;

  if (!Url) {
    console.warn(`[${ts()}] [POST /proxy] 400 missing Url`);
    res.status(400).json({ error: "Url is required" });
    return;
  }

  console.log(`[${ts()}] [POST /proxy] → ${Method} ${Url}`);

  // Extract API key sent by plugin as a bridge-level header, inject into outgoing request
  const rawApiKey = req.headers["x-api-key"];
  const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;
  const outgoingHeaders: Record<string, string> = {
    ...(apiKey ? { "x-api-key": apiKey } : {}),
    ...Headers,
  };

  try {
    const axiosConfig: AxiosRequestConfig = {
      url: Url,
      method: Method,
      headers: outgoingHeaders,
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

    const response = await axios(axiosConfig);
    const statusCode = response.status;

    console.log(`[${ts()}] [POST /proxy] ← ${statusCode} ${Url}`);

    res.json({
      Success: statusCode >= 200 && statusCode <= 299,
      StatusCode: statusCode,
      StatusMessage: response.statusText,
      Headers: response.headers,
      Body: response.data,
    });
  } catch (err) {
    // Network-level errors (timeout, unreachable, etc.)
    console.error(`[${ts()}] [POST /proxy] error ${Url} — ${(err as Error).message}`);

    res.status(500).json({
      Success: false,
      StatusCode: 0,
      StatusMessage: (err as Error).message,
      Headers: {},
      Body: "",
    });
  }
});

app.post("/deploy", handleDeploy);

app.get("/places/list", handleListPlaces);
app.post("/places/create", handleCreatePlace);

app.post("/clipboard", handleClipboard);

app.get("/api-key/list", handleListApiKeys);
app.get("/api-key", handleGetApiKey);
app.post("/api-key", handleSetApiKey);
app.delete("/api-key", handleDeleteApiKey);

app.get("/health", (_req: Request, res: Response) => res.sendStatus(200));

const startTime = Date.now();

app.get("/status", (_req: Request, res: Response) => {
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
