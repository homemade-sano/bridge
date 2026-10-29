import express, { Request, Response } from "express";
import axios, { AxiosRequestConfig } from "axios";
import { readConfig } from "./config";
import { handleDeploy } from "./deploy";
import {
  handleListPlaces,
  handleCreatePlace,
  handlePlaceVersions,
  handleExtract,
} from "./places";
import { handleClipboard } from "./clipboard";
import {
  handleSetApiKey,
  handleGetApiKey,
  handleDeleteApiKey,
  handleListApiKeys,
} from "./apikeys";

const app = express();
const PORT = Number(process.env.PORT) || readConfig().port || 3000;

// 20mb: clipboard payloads, proxied bodies and base64 multipart files exceed the 100kb default
app.use(express.json({ limit: "20mb" }));

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

// Bridge-level x-api-key (sent by the plugin on the hop to the bridge) is
// injected upstream; inner Headers win on conflict.
function upstreamHeaders(req: Request, headers: Record<string, string>): Record<string, string> {
  const rawApiKey = req.headers["x-api-key"];
  const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;
  return {
    ...(apiKey ? { "x-api-key": apiKey } : {}),
    ...headers,
  };
}

// Sends the upstream request and replies with the RequestAsync-shaped envelope.
async function forward(
  route: string,
  res: Response,
  axiosConfig: AxiosRequestConfig & { url: string; method: string }
): Promise<void> {
  const { url, method } = axiosConfig;
  console.log(`[${ts()}] [POST ${route}] → ${method} ${url}`);

  try {
    const response = await axios({
      ...axiosConfig,
      // Return raw string so Body is always a string (matching Roblox's response)
      responseType: "text",
      validateStatus: () => true, // never throw on HTTP error codes
    });
    const statusCode = response.status;

    console.log(`[${ts()}] [POST ${route}] ← ${statusCode} ${url}`);

    res.json({
      Success: statusCode >= 200 && statusCode <= 299,
      StatusCode: statusCode,
      StatusMessage: response.statusText,
      Headers: response.headers,
      Body: response.data,
    });
  } catch (err) {
    // Network-level errors (timeout, unreachable, etc.)
    console.error(`[${ts()}] [POST ${route}] error ${url} — ${(err as Error).message}`);

    res.status(500).json({
      Success: false,
      StatusCode: 0,
      StatusMessage: (err as Error).message,
      Headers: {},
      Body: "",
    });
  }
}

app.post("/proxy", async (req: Request, res: Response) => {
  const { Url, Method = "GET", Headers = {}, Body, Compress, Timeout } =
    req.body as ProxyRequestBody;

  if (!Url) {
    console.warn(`[${ts()}] [POST /proxy] 400 missing Url`);
    res.status(400).json({ error: "Url is required" });
    return;
  }

  const axiosConfig: AxiosRequestConfig & { url: string; method: string } = {
    url: Url,
    method: Method,
    headers: upstreamHeaders(req, Headers),
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

  await forward("/proxy", res, axiosConfig);
});

interface MultipartFile {
  name: string;
  filename: string;
  contentType?: string;
  dataBase64: string;
}

interface MultipartRequestBody {
  Url: string;
  Method?: string;
  Headers?: Record<string, string>;
  Fields?: Record<string, string | number | boolean>;
  Files?: MultipartFile[];
  Timeout?: number;
}

// POST /proxy/multipart
// Like /proxy, but the bridge builds a multipart/form-data body itself so
// binary file parts survive (Roblox strings can't carry raw bytes to /proxy).
//   Url, Method (default "POST"), Headers, Timeout - as /proxy
//   Fields  { [name]: string|number|boolean }      - text parts
//   Files   [{ name, filename, contentType?, dataBase64 }] - binary parts
// Any Content-Type in Headers is dropped: the boundary is generated here.
// Response: same envelope as /proxy.
app.post("/proxy/multipart", async (req: Request, res: Response) => {
  const { Url, Method = "POST", Headers = {}, Fields = {}, Files = [], Timeout } =
    req.body as MultipartRequestBody;

  const fail = (error: string) => {
    console.warn(`[${ts()}] [POST /proxy/multipart] 400 ${error}`);
    res.status(400).json({ error });
  };

  if (!Url) return fail("Url is required");
  if (typeof Fields !== "object" || Array.isArray(Fields)) {
    return fail("Fields must be an object");
  }
  if (!Array.isArray(Files)) return fail("Files must be an array");

  const form = new FormData();
  for (const [name, value] of Object.entries(Fields)) {
    if (!["string", "number", "boolean"].includes(typeof value)) {
      return fail(`Fields.${name} must be a string, number or boolean`);
    }
    form.append(name, String(value));
  }
  for (const [i, file] of Files.entries()) {
    if (!file || typeof file.name !== "string" || typeof file.filename !== "string") {
      return fail(`Files[${i}] needs string name and filename`);
    }
    if (typeof file.dataBase64 !== "string" || file.dataBase64.length === 0) {
      return fail(`Files[${i}].dataBase64 must be a non-empty base64 string`);
    }
    const bytes = Buffer.from(file.dataBase64, "base64");
    const type = file.contentType || "application/octet-stream";
    form.append(file.name, new Blob([bytes], { type }), file.filename);
  }

  const headers = Object.fromEntries(
    Object.entries(Headers).filter(([k]) => k.toLowerCase() !== "content-type")
  );

  const axiosConfig: AxiosRequestConfig & { url: string; method: string } = {
    url: Url,
    method: Method,
    headers: upstreamHeaders(req, headers),
    data: form,
  };

  if (Timeout && Timeout > 0) {
    axiosConfig.timeout = Timeout * 1000;
  }

  await forward("/proxy/multipart", res, axiosConfig);
});

app.post("/deploy", handleDeploy);

app.get("/places/list", handleListPlaces);
app.post("/places/create", handleCreatePlace);
app.get("/places/versions", handlePlaceVersions);
app.post("/places/extract", handleExtract);

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
