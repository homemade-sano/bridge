import fs from "fs";
import path from "path";
import { Request, Response } from "express";
import { readConfig } from "./config";
import { readStudioCookie } from "./robloxAuth";
import {
  VersionKind,
  VERSION_KINDS,
  PlaceFetchError,
  downloadPlace,
  fetchPlaceVersion,
  runLuneScript,
  asArray,
  withTempDir,
} from "./placeFiles";

// POST /deploy (v1 — see "POST /deploy v2" below for per-target code/map)
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

function respondNoCookie(res: Response): void {
  console.warn(
    `[${ts()}] [POST /deploy] 409 no Studio session cookie ` +
      `(check the [cookie/*] warnings above — often lune missing or an expired session)`
  );
  res.status(409).json({
    error:
      "No Roblox Studio session cookie available. Make sure Studio is installed " +
      "and logged in, and that 'lune' is installed and on PATH (or set studio.lunePath in config.json).",
  });
}

// ---------------------------------------------------------------------------
// POST /deploy v2 — the targets carry "code" (and "map"). A body without any
// target "code" is v1 (above) and behaves exactly as before.
//
//   versionType  "Published" | "Saved" — how the TARGET receives it
//   targets      [{ name, universeId, placeId,
//                   code: { placeId, version: "saved"|"published" } | "keep",
//                   map:  { placeId, version: "saved"|"published" } | "keep" | "none" }]
//
// "keep" = the target's own current published version. The base is the code
// place; unless map is "none", the map place's Workspace + Terrain are grafted
// in (scripts/assemble.luau). Downloads are deduplicated by (placeId, version)
// and ALL downloads + assemblies finish before the first publish. A failed
// download/assembly only fails the targets that need it.
// ---------------------------------------------------------------------------
interface PlaceRef {
  placeId: number;
  version: VersionKind;
}

interface DeployV2Target extends DeployTarget {
  code: PlaceRef | "keep";
  map: PlaceRef | "keep" | "none";
}

interface DeployV2RequestBody {
  versionType?: string;
  targets: DeployV2Target[];
}

type ResolvedRef = PlaceRef & { resolved?: number };

interface TargetV2Result extends TargetResult {
  code: ResolvedRef | "keep";
  map: ResolvedRef | "keep" | "none";
  assembled: boolean;
  outputSizeBytes?: number;
  mapClassTagged?: number;
  warnings: string[];
}

interface Download {
  ref: PlaceRef;
  resolved?: number;
  file?: Buffer;
  path?: string;
  status?: number;
  detail?: string;
}

interface AssembleResult {
  hasContents: boolean;
  assembled: boolean;
  tagged: number;
  warnings: unknown;
}

function isV2(body: DeployRequestBody): boolean {
  return (
    Array.isArray(body?.targets) &&
    body.targets.some((t) => typeof t === "object" && t !== null && "code" in t)
  );
}

function isPlaceRef(value: unknown): value is PlaceRef {
  const ref = value as PlaceRef;
  return (
    typeof ref === "object" &&
    ref !== null &&
    isId(ref.placeId) &&
    VERSION_KINDS.includes(ref.version)
  );
}

function validateV2(body: DeployV2RequestBody): string | null {
  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    return "targets must be a non-empty array";
  }

  const seen = new Set<number>();
  for (const [i, target] of body.targets.entries()) {
    if (!target || !isId(target.universeId) || !isId(target.placeId)) {
      return `targets[${i}] needs numeric universeId and placeId`;
    }
    if (seen.has(target.placeId)) {
      return `duplicate target placeId ${target.placeId}`;
    }
    seen.add(target.placeId);

    if (target.code !== "keep" && !isPlaceRef(target.code)) {
      return `targets[${i}].code must be "keep" or { placeId, version: "saved"|"published" }`;
    }
    if (target.map !== "keep" && target.map !== "none" && !isPlaceRef(target.map)) {
      return `targets[${i}].map must be "keep", "none" or { placeId, version: "saved"|"published" }`;
    }
    if (target.code === "keep" && typeof target.map === "string") {
      return `targets[${i}]: code "keep" with map "${target.map}" would republish the live version unchanged`;
    }
  }

  if (body.versionType !== undefined && !VERSION_TYPES.includes(body.versionType)) {
    return `versionType must be one of: ${VERSION_TYPES.join(", ")}`;
  }

  return null;
}

const refKey = (ref: PlaceRef) => `${ref.placeId}:${ref.version}`;

// "keep" = the target's own current published version
function sourceRef(spec: PlaceRef | "keep", target: DeployTarget): PlaceRef {
  return spec === "keep" ? { placeId: target.placeId, version: "published" } : spec;
}

async function downloadAll(
  refs: PlaceRef[],
  cookie: string,
  timeoutMs: number
): Promise<Map<string, Download>> {
  const unique = new Map<string, PlaceRef>();
  for (const ref of refs) unique.set(refKey(ref), ref);

  const downloads = new Map<string, Download>();
  await Promise.all(
    [...unique].map(async ([key, ref]) => {
      try {
        const { resolved, file } = await fetchPlaceVersion(
          ref.placeId,
          ref.version,
          cookie,
          timeoutMs
        );
        downloads.set(key, { ref, resolved, file });
      } catch (err) {
        const status = err instanceof PlaceFetchError ? err.status : 0;
        const detail = err instanceof PlaceFetchError ? err.detail : (err as Error).message;
        console.error(
          `[${ts()}] [POST /deploy] download ${ref.placeId} (${ref.version}) failed — HTTP ${status}: ${detail}`
        );
        downloads.set(key, { ref, status, detail });
      }
    })
  );
  return downloads;
}

function echo(spec: PlaceRef | "keep" | "none", download?: Download) {
  return typeof spec === "string" ? spec : { ...spec, resolved: download?.resolved };
}

async function handleDeployV2(
  body: DeployV2RequestBody,
  apiKey: string,
  res: Response
): Promise<void> {
  const validationError = validateV2(body);
  if (validationError) {
    console.warn(`[${ts()}] [POST /deploy] 400 ${validationError}`);
    res.status(400).json({ error: validationError });
    return;
  }

  const versionType = body.versionType ?? "Published";
  const { downloadTimeoutMs, publishTimeoutMs, luneTimeoutMs } = readConfig().deploy;

  const cookie = await readStudioCookie();
  if (!cookie) {
    respondNoCookie(res);
    return;
  }

  const refs: PlaceRef[] = [];
  for (const target of body.targets) {
    refs.push(sourceRef(target.code, target));
    if (target.map !== "none") refs.push(sourceRef(target.map, target));
  }
  const downloads = await downloadAll(refs, cookie, downloadTimeoutMs);

  const results = await withTempDir(async (dir) => {
    for (const download of downloads.values()) {
      if (!download.file) continue;
      download.path = path.join(
        dir,
        `${download.ref.placeId}_${download.ref.version}.rbxl`
      );
      await fs.promises.writeFile(download.path, download.file);
    }

    // Phase 1: assemble every target (no publish yet)
    const prepared: { target: DeployV2Target; result: TargetV2Result; outPath?: string }[] = [];
    for (const target of body.targets) {
      const code = downloads.get(refKey(sourceRef(target.code, target)))!;
      const map =
        target.map === "none" ? undefined : downloads.get(refKey(sourceRef(target.map, target)))!;
      const result: TargetV2Result = {
        name: target.name,
        placeId: target.placeId,
        ok: false,
        code: echo(target.code, code) as TargetV2Result["code"],
        map: echo(target.map, map),
        assembled: false,
        warnings: [],
      };
      const entry: (typeof prepared)[number] = { target, result };
      prepared.push(entry);

      const failed: [string, Download] | null = !code.file
        ? ["code", code]
        : map && !map.file
          ? ["map", map]
          : null;
      if (failed) {
        const [role, d] = failed;
        result.status = d.status;
        result.detail = `${role} download failed (place ${d.ref.placeId}, ${d.ref.version}): ${d.detail}`;
        continue;
      }

      const outPath = path.join(dir, `out_${target.placeId}.rbxl`);
      let assembly: AssembleResult;
      try {
        assembly = await runLuneScript<AssembleResult>(
          "assemble.luau",
          [code.path!, map ? map.path! : "-", outPath],
          luneTimeoutMs
        );
      } catch (err) {
        console.error(
          `[${ts()}] [POST /deploy] assembly for ${target.placeId} failed — ${(err as Error).message}`
        );
        result.status = 500;
        result.detail = `assembly failed: ${(err as Error).message}`;
        continue;
      }

      result.warnings = asArray<string>(assembly.warnings);
      if (!assembly.hasContents) {
        result.status = 422;
        result.detail =
          `base (place ${code.ref.placeId}, ${code.ref.version} v${code.resolved}) ` +
          `has no ReplicatedStorage.Contents`;
        continue;
      }

      result.assembled = assembly.assembled;
      if (assembly.assembled) result.mapClassTagged = assembly.tagged;
      entry.outPath = assembly.assembled ? outPath : code.path;
    }

    // Phase 2: publish
    for (const { target, result, outPath } of prepared) {
      if (!outPath) continue;
      const file = await fs.promises.readFile(outPath);
      result.outputSizeBytes = file.length;
      Object.assign(
        result,
        await publishToTarget(target, file, apiKey, versionType, publishTimeoutMs)
      );
    }

    return prepared.map((p) => p.result);
  });

  const okCount = results.filter((r) => r.ok).length;
  console.log(
    `[${ts()}] [POST /deploy] v2 targets=${results.length} ok=${okCount} ` +
      `fail=${results.length - okCount} downloads=${downloads.size} versionType=${versionType}`
  );

  res.json({
    ok: true,
    versionType,
    downloads: [...downloads.values()].map((d) => ({
      placeId: d.ref.placeId,
      version: d.ref.version,
      ok: d.file !== undefined,
      resolved: d.resolved,
      sizeBytes: d.file?.length,
      status: d.status,
      detail: d.detail,
    })),
    results,
  });
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

  if (isV2(body)) {
    await handleDeployV2(body as unknown as DeployV2RequestBody, apiKey, res);
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
    respondNoCookie(res);
    return;
  }

  let file: Buffer;
  try {
    file = await downloadPlace(body.sourcePlaceId, cookie, downloadTimeoutMs);
  } catch (err) {
    if (err instanceof PlaceFetchError) {
      console.error(
        `[${ts()}] [POST /deploy] 502 download of ${body.sourcePlaceId} failed — HTTP ${err.status}: ${err.detail}`
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
