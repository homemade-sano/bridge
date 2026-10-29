import fs from "fs";
import path from "path";
import { Request, Response } from "express";
import { readConfig } from "./config";
import { readStudioCookie, csrfFetch } from "./robloxAuth";
import {
  VersionKind,
  VERSION_KINDS,
  PlaceFetchError,
  getPlaceVersions,
  fetchPlaceVersion,
  runLuneScript,
  asArray,
  withTempDir,
} from "./placeFiles";

// GET  /places/list?universeId={id}   — list places of a universe
// POST /places/create                 — create a place in a universe
//
// Listing goes through Open Cloud v2 (x-api-key). That endpoint is not yet
// public for all keys (as of 2026-07, scope universe.place:read "releasing
// soon" per Roblox staff), so a 404 falls back to the legacy
// develop.roblox.com list endpoint using the local Studio cookie.
//
// Creation has NO Open Cloud equivalent — it uses the legacy endpoint Mantle
// uses (apis.roblox.com/universes/v1/user/universes/{id}/places, the
// replacement Roblox staff named after ide/places/createV2 was removed in
// July 2024), authenticated with the local Studio session cookie + CSRF
// token. Places cannot be deleted via any API, so every creation is logged
// and duplicate names are refused when a list lookup is possible.

interface PlaceInfo {
  placeId: number;
  name: string;
  description: string;
  updateTime?: string;
}

class RobloxApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}

function ts() {
  return new Date().toISOString();
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function cloudFailureDetail(
  status: number,
  universeId: number,
  bodyText: string
): string {
  switch (status) {
    case 401:
      return "Invalid API key";
    case 403:
      return `API key lacks the required scope for universe ${universeId}`;
    case 404:
      return "Unknown universe (or endpoint not available for this key)";
    case 429:
      return "Rate limited by Roblox — retry later";
    default:
      return bodyText.slice(0, 200) || `HTTP ${status}`;
  }
}

// ---------------------------------------------------------------------------
// List places — Open Cloud v2, full pagination
// ---------------------------------------------------------------------------
async function listPlacesCloud(
  universeId: number,
  apiKey: string,
  timeoutMs: number
): Promise<PlaceInfo[]> {
  const places: PlaceInfo[] = [];
  let pageToken: string | undefined;

  do {
    const url =
      `https://apis.roblox.com/cloud/v2/universes/${universeId}/places?maxPageSize=50` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");

    const response = await fetch(url, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new RobloxApiError(
        response.status,
        cloudFailureDetail(response.status, universeId, bodyText)
      );
    }

    const data = (await response.json()) as {
      places?: Array<{
        path?: string;
        displayName?: string;
        description?: string;
        updateTime?: string;
      }>;
      nextPageToken?: string;
    };

    for (const item of data.places ?? []) {
      const match = (item.path ?? "").match(/places\/(\d+)/);
      if (!match) continue;
      places.push({
        placeId: Number(match[1]),
        name: item.displayName ?? "",
        description: item.description ?? "",
        updateTime: item.updateTime,
      });
    }

    pageToken = data.nextPageToken || undefined;
  } while (pageToken);

  return places;
}

// ---------------------------------------------------------------------------
// List places — legacy develop.roblox.com fallback (cursor pagination).
// Works with the Studio cookie (or unauthenticated for public universes).
// ---------------------------------------------------------------------------
async function listPlacesLegacy(
  universeId: number,
  cookie: string | null,
  timeoutMs: number
): Promise<PlaceInfo[]> {
  const places: PlaceInfo[] = [];
  let cursor: string | undefined;

  do {
    const url =
      `https://develop.roblox.com/v1/universes/${universeId}/places` +
      (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");

    const response = await fetch(url, {
      headers: cookie ? { Cookie: `.ROBLOSECURITY=${cookie}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new RobloxApiError(
        response.status,
        cloudFailureDetail(response.status, universeId, bodyText)
      );
    }

    const data = (await response.json()) as {
      nextPageCursor?: string | null;
      data?: Array<{ id?: number; name?: string; description?: string }>;
    };

    for (const item of data.data ?? []) {
      if (!isId(item.id)) continue;
      places.push({
        placeId: item.id,
        name: item.name ?? "",
        description: item.description ?? "",
      });
    }

    cursor = data.nextPageCursor || undefined;
  } while (cursor);

  return places;
}

// Cloud first; on 404 (endpoint not public for this key, or bad universe id)
// retry via the legacy endpoint — a legacy success disambiguates the two.
async function listPlaces(
  universeId: number,
  apiKey: string | undefined,
  timeoutMs: number
): Promise<{ places: PlaceInfo[]; source: "cloud" | "legacy" }> {
  let cloudError: RobloxApiError | null = null;

  if (apiKey) {
    try {
      return {
        places: await listPlacesCloud(universeId, apiKey, timeoutMs),
        source: "cloud",
      };
    } catch (err) {
      if (err instanceof RobloxApiError && err.status === 404) {
        cloudError = err;
      } else {
        throw err;
      }
    }
  }

  try {
    const cookie = await readStudioCookie();
    return {
      places: await listPlacesLegacy(universeId, cookie, timeoutMs),
      source: "legacy",
    };
  } catch (err) {
    throw cloudError ?? err;
  }
}

// ---------------------------------------------------------------------------
// GET /places/list
// ---------------------------------------------------------------------------
export async function handleListPlaces(req: Request, res: Response): Promise<void> {
  const apiKey = headerValue(req.headers["x-api-key"]);
  if (!apiKey) {
    console.warn(`[${ts()}] [GET /places/list] 400 missing x-api-key`);
    res.status(400).json({ error: "x-api-key header is required" });
    return;
  }

  const universeId = Number(req.query.universeId);
  if (!isId(universeId)) {
    console.warn(`[${ts()}] [GET /places/list] 400 bad universeId`);
    res.status(400).json({ error: "universeId query param must be a positive integer" });
    return;
  }

  const { createTimeoutMs } = readConfig().places;

  try {
    const { places, source } = await listPlaces(universeId, apiKey, createTimeoutMs);
    console.log(
      `[${ts()}] [GET /places/list] universe=${universeId} places=${places.length} source=${source}`
    );
    res.json({ universeId, places, source });
  } catch (err) {
    if (err instanceof RobloxApiError) {
      console.warn(
        `[${ts()}] [GET /places/list] ${err.status} universe=${universeId} — ${err.detail}`
      );
      res.status(err.status).json({ error: err.detail });
    } else {
      console.error(`[${ts()}] [GET /places/list] error — ${(err as Error).message}`);
      res.status(502).json({ error: (err as Error).message });
    }
  }
}

// ---------------------------------------------------------------------------
// POST /places/create
// ---------------------------------------------------------------------------
interface CreateRequestBody {
  universeId: number;
  name: string;
  description?: string;
  templatePlaceId?: number;
}

export async function handleCreatePlace(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateRequestBody;
  const apiKey = headerValue(req.headers["x-api-key"]);
  const { createTimeoutMs, defaultTemplatePlaceId } = readConfig().places;

  if (!isId(body.universeId)) {
    console.warn(`[${ts()}] [POST /places/create] 400 bad universeId`);
    res.status(400).json({ error: "universeId must be a positive integer" });
    return;
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    console.warn(`[${ts()}] [POST /places/create] 400 empty name`);
    res.status(400).json({ error: "name must be a non-empty string" });
    return;
  }
  if (body.templatePlaceId !== undefined && !isId(body.templatePlaceId)) {
    console.warn(`[${ts()}] [POST /places/create] 400 bad templatePlaceId`);
    res.status(400).json({ error: "templatePlaceId must be a positive integer" });
    return;
  }
  const description = typeof body.description === "string" ? body.description : "";
  const templatePlaceId = body.templatePlaceId ?? defaultTemplatePlaceId;

  const cookie = await readStudioCookie();
  if (!cookie) {
    console.warn(`[${ts()}] [POST /places/create] 409 no Studio session`);
    res.status(409).json({
      error: "No Roblox Studio session found — open Studio and log in.",
    });
    return;
  }

  // Creation is permanent (no delete API) — refuse duplicate names when a
  // list lookup is possible; otherwise proceed with a logged warning.
  try {
    const { places } = await listPlaces(body.universeId, apiKey, createTimeoutMs);
    const clash = places.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
    if (clash) {
      console.warn(
        `[${ts()}] [POST /places/create] 409 duplicate name in universe=${body.universeId}`
      );
      res.status(409).json({
        error: `A place named ${name} already exists in this universe.`,
      });
      return;
    }
  } catch (err) {
    console.warn(
      `[${ts()}] [POST /places/create] duplicate-name check skipped — ${(err as Error).message}`
    );
  }

  // Legacy create endpoint (cookie + CSRF). No Open Cloud equivalent.
  let placeId: number;
  try {
    const response = await csrfFetch(
      `https://apis.roblox.com/universes/v1/user/universes/${body.universeId}/places`,
      {
        method: "POST",
        headers: {
          Cookie: `.ROBLOSECURITY=${cookie}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ templatePlaceId }),
        signal: AbortSignal.timeout(createTimeoutMs),
      }
    );

    const bodyText = await response.text().catch(() => "");
    const looksLikeHtml =
      (response.headers.get("content-type") ?? "").includes("text/html") ||
      bodyText.trimStart().startsWith("<");

    if (!response.ok || looksLikeHtml) {
      console.error(
        `[${ts()}] [POST /places/create] 502 create failed — HTTP ${response.status}`
      );
      res.status(502).json({
        error: "Failed to create place",
        status: response.status,
        detail: looksLikeHtml
          ? "Legacy create endpoint failed — check bridge version / Roblox changes"
          : bodyText.slice(0, 200) || `HTTP ${response.status}`,
      });
      return;
    }

    const data = JSON.parse(bodyText) as { placeId?: number; PlaceId?: number };
    const id = data.placeId ?? data.PlaceId;
    if (!isId(id)) {
      // Unexpected shape — log the raw body (contains no secrets) to debug
      console.error(
        `[${ts()}] [POST /places/create] 502 unexpected create response: ${bodyText.slice(0, 300)}`
      );
      res.status(502).json({
        error: "Failed to create place",
        status: response.status,
        detail: "Legacy create endpoint failed — check bridge version / Roblox changes",
      });
      return;
    }
    placeId = id;
  } catch (err) {
    console.error(`[${ts()}] [POST /places/create] 502 — ${(err as Error).message}`);
    res.status(502).json({
      error: "Failed to create place",
      status: 0,
      detail: (err as Error).message,
    });
    return;
  }

  // Permanent action — always log it
  console.log(
    `[${ts()}] [POST /places/create] created placeId=${placeId} universe=${body.universeId} name="${name}"`
  );

  // Best-effort rename via Open Cloud (legacy create ignores the name)
  let renamed = false;
  let renameDetail: string | undefined;
  if (apiKey) {
    try {
      const response = await fetch(
        `https://apis.roblox.com/cloud/v2/universes/${body.universeId}/places/${placeId}?updateMask=displayName,description`,
        {
          method: "PATCH",
          headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: name, description }),
          signal: AbortSignal.timeout(createTimeoutMs),
        }
      );
      if (response.ok) {
        renamed = true;
      } else {
        const bodyText = await response.text().catch(() => "");
        renameDetail = cloudFailureDetail(response.status, body.universeId, bodyText);
      }
    } catch (err) {
      renameDetail = (err as Error).message;
    }
  } else {
    renameDetail = "no x-api-key provided — rename skipped";
  }

  res.json({
    ok: true,
    universeId: body.universeId,
    placeId,
    name,
    renamed,
    ...(renameDetail ? { renameDetail } : {}),
  });
}

// ---------------------------------------------------------------------------
// GET /places/versions?placeId={id}
// → { placeId, saved: { version, updated }, published?: { version, updated } }
// Studio cookie (develop.roblox.com version history).
// ---------------------------------------------------------------------------
export async function handlePlaceVersions(req: Request, res: Response): Promise<void> {
  const placeId = Number(req.query.placeId);
  if (!isId(placeId)) {
    console.warn(`[${ts()}] [GET /places/versions] 400 bad placeId`);
    res.status(400).json({ error: "placeId query param must be a positive integer" });
    return;
  }

  const cookie = await readStudioCookie();
  if (!cookie) {
    console.warn(`[${ts()}] [GET /places/versions] 409 no Studio session`);
    res.status(409).json({ error: "No Roblox Studio session found — open Studio and log in." });
    return;
  }

  try {
    const { saved, published } = await getPlaceVersions(
      placeId,
      cookie,
      readConfig().deploy.downloadTimeoutMs
    );
    console.log(
      `[${ts()}] [GET /places/versions] place=${placeId} saved=${saved?.version} published=${published?.version}`
    );
    res.json({ placeId, saved, ...(published ? { published } : {}) });
  } catch (err) {
    if (err instanceof PlaceFetchError) {
      console.warn(`[${ts()}] [GET /places/versions] ${err.status} place=${placeId} — ${err.detail}`);
      res.status(err.status).json({ error: err.detail });
    } else {
      console.error(`[${ts()}] [GET /places/versions] error — ${(err as Error).message}`);
      res.status(502).json({ error: (err as Error).message });
    }
  }
}

// ---------------------------------------------------------------------------
// POST /places/extract
// Body: { placeId, version: "saved"|"published", paths: ["ReplicatedStorage.Contents", ...] }
// → { placeId, resolved, items: [{ path, ok, dataBase64?, sizeBytes?, detail? }] }
// Each found path is serialized to a binary .rbxm (scripts/extract.luau).
// ---------------------------------------------------------------------------
interface ExtractRequestBody {
  placeId: number;
  version: VersionKind;
  paths: string[];
}

interface ExtractItem {
  path: string;
  ok: boolean;
  file?: string;
  detail?: string;
}

export async function handleExtract(req: Request, res: Response): Promise<void> {
  const body = req.body as ExtractRequestBody;

  const fail = (error: string) => {
    console.warn(`[${ts()}] [POST /places/extract] 400 ${error}`);
    res.status(400).json({ error });
  };
  if (!isId(body.placeId)) return fail("placeId must be a positive integer");
  if (!VERSION_KINDS.includes(body.version)) {
    return fail(`version must be one of: ${VERSION_KINDS.join(", ")}`);
  }
  if (
    !Array.isArray(body.paths) ||
    body.paths.length === 0 ||
    !body.paths.every((p) => typeof p === "string" && p.length > 0)
  ) {
    return fail("paths must be a non-empty array of non-empty strings");
  }

  const cookie = await readStudioCookie();
  if (!cookie) {
    console.warn(`[${ts()}] [POST /places/extract] 409 no Studio session`);
    res.status(409).json({ error: "No Roblox Studio session found — open Studio and log in." });
    return;
  }

  const { downloadTimeoutMs, luneTimeoutMs } = readConfig().deploy;

  let resolved: number;
  let file: Buffer;
  try {
    ({ resolved, file } = await fetchPlaceVersion(body.placeId, body.version, cookie, downloadTimeoutMs));
  } catch (err) {
    const status = err instanceof PlaceFetchError ? err.status : 0;
    const detail = err instanceof PlaceFetchError ? err.detail : (err as Error).message;
    console.error(`[${ts()}] [POST /places/extract] 502 download of ${body.placeId} failed — ${detail}`);
    res.status(502).json({ error: `Failed to download place ${body.placeId}`, status, detail });
    return;
  }

  try {
    const items = await withTempDir(async (dir) => {
      const placePath = path.join(dir, "place.rbxl");
      await fs.promises.writeFile(placePath, file);
      const extracted = await runLuneScript<ExtractItem[]>(
        "extract.luau",
        [placePath, dir, ...body.paths],
        luneTimeoutMs
      );
      return Promise.all(
        asArray<ExtractItem>(extracted).map(async (item) => {
          if (!item.ok || !item.file) {
            return { path: item.path, ok: false, detail: item.detail };
          }
          const data = await fs.promises.readFile(item.file);
          return { path: item.path, ok: true, dataBase64: data.toString("base64"), sizeBytes: data.length };
        })
      );
    });

    console.log(
      `[${ts()}] [POST /places/extract] place=${body.placeId} ${body.version} v${resolved} ` +
        items.map((i) => `${i.path}=${i.ok ? `${i.sizeBytes}B` : "missing"}`).join(" ")
    );
    res.json({ placeId: body.placeId, resolved, items });
  } catch (err) {
    console.error(`[${ts()}] [POST /places/extract] 500 extraction failed — ${(err as Error).message}`);
    res.status(500).json({ error: `extraction failed: ${(err as Error).message}` });
  }
}
