import { Request, Response } from "express";
import { readConfig } from "./config";
import { readStudioCookie } from "./robloxAuth";

// POST /deploy
// Downloads the current source place file (using the local Studio session
// cookie) and publishes it to every target place via Open Cloud.
//
// Request body:
//   sourcePlaceId (number, required)
//   targets       (array, required)  - [{ name, universeId, placeId }]
//   versionType   (string)           - "Published" | "Saved", default "Published"
//
// The Open Cloud API key arrives in the x-api-key header (same as /proxy).
// Only pre-flight failures (validation, no cookie, download) use non-200
// codes; per-target publish failures are reported in results[].

interface DeployTarget {
  name: string;
  universeId: number;
  placeId: number;
}

interface DeployRequestBody {
  sourcePlaceId: number;
  targets: DeployTarget[];
  versionType?: string;
}

interface TargetResult {
  name: string;
  placeId: number;
  ok: boolean;
  versionNumber?: number;
  status?: number;
  detail?: string;
}

const VERSION_TYPES = ["Published", "Saved"];

function ts() {
  return new Date().toISOString();
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validate(body: DeployRequestBody): string | null {
  if (!isId(body.sourcePlaceId)) {
    return "sourcePlaceId must be a positive integer";
  }
  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    return "targets must be a non-empty array";
  }
  const seen = new Set<number>();
  for (const target of body.targets) {
    if (!target || !isId(target.universeId) || !isId(target.placeId)) {
      return "every target needs numeric universeId and placeId";
    }
    if (target.placeId === body.sourcePlaceId) {
      return `target placeId ${target.placeId} is the source place`;
    }
    if (seen.has(target.placeId)) {
      return `duplicate target placeId ${target.placeId}`;
    }
    seen.add(target.placeId);
  }
  if (body.versionType !== undefined && !VERSION_TYPES.includes(body.versionType)) {
    return `versionType must be one of: ${VERSION_TYPES.join(", ")}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Download the source place binary (.rbxl)
// ---------------------------------------------------------------------------
class DownloadError extends Error {
  constructor(public status: number, public detail: string) {
    super(`asset download failed (HTTP ${status})`);
  }
}

async function downloadPlace(
  placeId: number,
  cookie: string,
  timeoutMs: number
): Promise<Buffer> {
  const url = `https://assetdelivery.roblox.com/v1/asset/?id=${placeId}`;
  const headers: Record<string, string> = {
    Cookie: `.ROBLOSECURITY=${cookie}`,
  };

  let response = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    // Some asset endpoints reject unknown clients; retry once as Studio
    response = await fetch(url, {
      headers: { ...headers, "User-Agent": "Roblox/WinInet" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  if (!response.ok) {
    const excerpt = (await response.text().catch(() => "")).slice(0, 300);
    throw new DownloadError(response.status, excerpt);
  }

  return Buffer.from(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Publish to one target place via Open Cloud
// ---------------------------------------------------------------------------
function publishFailureDetail(
  status: number,
  universeId: number,
  bodyText: string
): string {
  switch (status) {
    case 401:
      return "Invalid API key";
    case 403:
      return `API key lacks write scope for universe ${universeId}`;
    case 404:
      return "Unknown universe or place id";
    case 429:
      return "Rate limited by Roblox — retry later";
    default:
      return bodyText.slice(0, 200) || `HTTP ${status}`;
  }
}

async function publishToTarget(
  target: DeployTarget,
  file: Buffer,
  apiKey: string,
  versionType: string,
  timeoutMs: number
): Promise<TargetResult> {
  const url =
    `https://apis.roblox.com/universes/v1/${target.universeId}` +
    `/places/${target.placeId}/versions?versionType=${versionType}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(file),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        versionNumber?: number;
      };
      return {
        name: target.name,
        placeId: target.placeId,
        ok: true,
        versionNumber: data.versionNumber,
      };
    }

    const bodyText = await response.text().catch(() => "");
    return {
      name: target.name,
      placeId: target.placeId,
      ok: false,
      status: response.status,
      detail: publishFailureDetail(response.status, target.universeId, bodyText),
    };
  } catch (err) {
    // Network-level errors (timeout, unreachable, etc.)
    return {
      name: target.name,
      placeId: target.placeId,
      ok: false,
      status: 0,
      detail: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function handleDeploy(req: Request, res: Response): Promise<void> {
  const body = req.body as DeployRequestBody;

  const rawApiKey = req.headers["x-api-key"];
  const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;
  if (!apiKey) {
    console.warn(`[${ts()}] [POST /deploy] 400 missing x-api-key`);
    res.status(400).json({ error: "x-api-key header is required" });
    return;
  }

  const validationError = validate(body);
  if (validationError) {
    console.warn(`[${ts()}] [POST /deploy] 400 ${validationError}`);
    res.status(400).json({ error: validationError });
    return;
  }

  const versionType = body.versionType ?? "Published";
  const { downloadTimeoutMs, publishTimeoutMs } = readConfig().deploy;

  const cookie = await readStudioCookie();
  if (!cookie) {
    console.warn(`[${ts()}] [POST /deploy] 409 no Studio session`);
    res.status(409).json({
      error:
        "No Roblox Studio session found on this machine — open Studio and log in.",
    });
    return;
  }

  let file: Buffer;
  try {
    file = await downloadPlace(body.sourcePlaceId, cookie, downloadTimeoutMs);
  } catch (err) {
    if (err instanceof DownloadError) {
      console.error(
        `[${ts()}] [POST /deploy] 502 download of ${body.sourcePlaceId} failed — HTTP ${err.status}`
      );
      res.status(502).json({
        error: `Failed to download source place ${body.sourcePlaceId}`,
        status: err.status,
        detail: err.detail,
      });
    } else {
      console.error(
        `[${ts()}] [POST /deploy] 502 download of ${body.sourcePlaceId} failed — ${(err as Error).message}`
      );
      res.status(502).json({
        error: `Failed to download source place ${body.sourcePlaceId}`,
        status: 0,
        detail: (err as Error).message,
      });
    }
    return;
  }

  const results: TargetResult[] = [];
  for (const target of body.targets) {
    results.push(
      await publishToTarget(target, file, apiKey, versionType, publishTimeoutMs)
    );
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(
    `[${ts()}] [POST /deploy] source=${body.sourcePlaceId} targets=${results.length} ` +
      `ok=${okCount} fail=${results.length - okCount} bytes=${file.length} versionType=${versionType}`
  );

  res.json({
    ok: true,
    sourcePlaceId: body.sourcePlaceId,
    sourceSizeBytes: file.length,
    versionType,
    results,
  });
}
