import fs from "fs";
import os from "os";
import path from "path";
import { readConfig } from "./config";
import { runProcess } from "./proc";

// Shared helpers for endpoints that work on place FILES: version lookup,
// download (Studio session cookie), and Lune scripts run on the downloaded
// files (scripts/*.luau). The cookie never reaches Lune — only file paths do.

export type VersionKind = "saved" | "published";

export const VERSION_KINDS: VersionKind[] = ["saved", "published"];

export interface VersionInfo {
  version: number;
  updated: string;
}

export interface PlaceVersions {
  saved: VersionInfo | null;
  published: VersionInfo | null;
}

export class PlaceFetchError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}

// ---------------------------------------------------------------------------
// Version history (develop.roblox.com, cookie). Deprecated by Roblox in favor
// of the Open Cloud Assets API ("roblox-deprecation-message" header) but
// still the only way to tell saved from published for places.
// ---------------------------------------------------------------------------
interface VersionEntry {
  assetVersionNumber?: number;
  created?: string;
  isEqualToCurrentPublishedVersion?: boolean;
}

async function fetchVersionPage(
  placeId: number,
  list: "saved-versions" | "published-versions",
  cookie: string,
  timeoutMs: number
): Promise<VersionEntry[]> {
  const url =
    `https://develop.roblox.com/v1/assets/${placeId}/${list}?limit=100&sortOrder=Desc`;
  const response = await fetch(url, {
    headers: { Cookie: `.ROBLOSECURITY=${cookie}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const excerpt = (await response.text().catch(() => "")).slice(0, 200);
    let detail = `version history of place ${placeId} failed (HTTP ${response.status}). ${excerpt}`.trim();
    if (response.status === 401 || response.status === 403) {
      detail =
        `Studio cookie rejected (HTTP ${response.status}) — the session is expired, ` +
        `or the logged-in Studio account has no access to place ${placeId}.`;
    }
    throw new PlaceFetchError(response.status, detail);
  }
  const data = (await response.json()) as { data?: VersionEntry[] };
  return data.data ?? [];
}

function toInfo(entry: VersionEntry | undefined): VersionInfo | null {
  if (!entry || typeof entry.assetVersionNumber !== "number") return null;
  return { version: entry.assetVersionNumber, updated: entry.created ?? "" };
}

export async function getPlaceVersions(
  placeId: number,
  cookie: string,
  timeoutMs: number
): Promise<PlaceVersions> {
  const [saved, published] = await Promise.all([
    fetchVersionPage(placeId, "saved-versions", cookie, timeoutMs),
    fetchVersionPage(placeId, "published-versions", cookie, timeoutMs),
  ]);
  return {
    saved: toInfo(saved[0]),
    published: toInfo(published.find((v) => v.isEqualToCurrentPublishedVersion)),
  };
}

// ---------------------------------------------------------------------------
// Download a place binary (.rbxl). Without a version, assetdelivery serves the
// latest SAVED version (not the published one).
// ---------------------------------------------------------------------------
export async function downloadPlace(
  placeId: number,
  cookie: string,
  timeoutMs: number,
  version?: number
): Promise<Buffer> {
  const url =
    `https://assetdelivery.roblox.com/v1/asset/?id=${placeId}` +
    (version !== undefined ? `&version=${version}` : "");
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
    // 401/403 here almost always means the Studio cookie is missing/expired or
    // the logged-in user can't read this place — surface that, not a raw excerpt.
    let hint = excerpt;
    if (response.status === 401 || response.status === 403) {
      hint =
        `Studio cookie rejected (HTTP ${response.status}) — the session is expired, ` +
        `or the logged-in Studio account has no access to place ${placeId}. ${excerpt}`.trim();
    } else if (response.status === 404) {
      hint = `place ${placeId} not found (HTTP 404). ${excerpt}`.trim();
    }
    throw new PlaceFetchError(response.status, hint);
  }

  return Buffer.from(await response.arrayBuffer());
}

// Resolves "saved"/"published" to a version number, then downloads exactly
// that version (so the number reported is the one actually used).
export async function fetchPlaceVersion(
  placeId: number,
  kind: VersionKind,
  cookie: string,
  timeoutMs: number
): Promise<{ resolved: number; file: Buffer }> {
  const versions = await getPlaceVersions(placeId, cookie, timeoutMs);
  const info = versions[kind];
  if (!info) {
    throw new PlaceFetchError(404, `place ${placeId} has no ${kind} version`);
  }
  return {
    resolved: info.version,
    file: await downloadPlace(placeId, cookie, timeoutMs, info.version),
  };
}

// ---------------------------------------------------------------------------
// Lune scripts + temp workspace
// ---------------------------------------------------------------------------

// __dirname is dist/ at runtime; the scripts live at <root>/scripts/
const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");

// Runs scripts/<name> and parses the JSON line it prints on stdout.
export async function runLuneScript<T>(
  name: string,
  args: string[],
  timeoutMs: number
): Promise<T> {
  const { lunePath } = readConfig().studio;
  const stdout = await runProcess(
    lunePath,
    ["run", path.join(SCRIPTS_DIR, name), ...args],
    "",
    timeoutMs
  );
  const lastLine = stdout.split("\n").pop() ?? "";
  try {
    return JSON.parse(lastLine) as T;
  } catch {
    throw new Error(`${name} printed no JSON result: ${stdout.slice(0, 200)}`);
  }
}

// Lune's serde encodes an empty table as {} — normalize list fields.
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "roblox-bridge-"));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
