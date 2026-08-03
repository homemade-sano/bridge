import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { runPowerShell } from "./winps";

// Local encrypted API-key store, so Roblox scripts never contain secrets.
//
//   POST   /api-key               { Name, Key }  — store (overwrites)
//   GET    /api-key?name={name}                  — decrypt and return
//   DELETE /api-key?name={name}                  — remove
//   GET    /api-key/list                         — names only, never values
//
// Keys are encrypted with Windows DPAPI (CurrentUser scope) via PowerShell:
// only this Windows user on this machine can decrypt them. Encrypted blobs
// live in %LOCALAPPDATA%\RobloxBridge\apikeys.json — plaintext never touches
// disk and is never logged. Secrets cross to/from PowerShell as base64 over
// stdin/stdout so they never appear on a command line.

const STORE_DIR = path.join(
  process.env.LOCALAPPDATA ??
    path.join(process.env.USERPROFILE ?? ".", "AppData", "Local"),
  "RobloxBridge"
);
const STORE_PATH = path.join(STORE_DIR, "apikeys.json");

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DPAPI_TIMEOUT_MS = 15000;

function ts() {
  return new Date().toISOString();
}

function dpapi(mode: "Protect" | "Unprotect", b64: string): Promise<string> {
  const script = [
    "Add-Type -AssemblyName System.Security;",
    "$in = [Console]::In.ReadToEnd().Trim();",
    "$data = [Convert]::FromBase64String($in);",
    `$out = [Security.Cryptography.ProtectedData]::${mode}(` +
      "$data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Console]::Out.Write([Convert]::ToBase64String($out));",
  ].join(" ");
  return runPowerShell(script, b64, DPAPI_TIMEOUT_MS);
}

function readStore(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, string>): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function queryName(req: Request): string | null {
  const name = req.query.name;
  return typeof name === "string" && NAME_RE.test(name) ? name : null;
}

// ---------------------------------------------------------------------------
// POST /api-key
// ---------------------------------------------------------------------------
export async function handleSetApiKey(req: Request, res: Response): Promise<void> {
  const { Name, Key } = req.body as { Name?: unknown; Key?: unknown };

  if (typeof Name !== "string" || !NAME_RE.test(Name)) {
    console.warn(`[${ts()}] [POST /api-key] 400 bad Name`);
    res.status(400).json({
      error: "Name must match [A-Za-z0-9._-], 1-64 chars",
    });
    return;
  }
  if (typeof Key !== "string" || Key.length === 0) {
    console.warn(`[${ts()}] [POST /api-key] 400 empty Key`);
    res.status(400).json({ error: "Key must be a non-empty string" });
    return;
  }

  try {
    const encrypted = await dpapi(
      "Protect",
      Buffer.from(Key, "utf8").toString("base64")
    );
    const store = readStore();
    const overwritten = Name in store;
    store[Name] = encrypted;
    writeStore(store);

    console.log(
      `[${ts()}] [POST /api-key] stored "${Name}" (${Key.length} chars, overwritten=${overwritten})`
    );
    res.json({ ok: true, name: Name, overwritten });
  } catch (err) {
    console.error(`[${ts()}] [POST /api-key] error — ${(err as Error).message}`);
    res.status(500).json({ error: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// GET /api-key?name={name}
// ---------------------------------------------------------------------------
export async function handleGetApiKey(req: Request, res: Response): Promise<void> {
  const name = queryName(req);
  if (!name) {
    console.warn(`[${ts()}] [GET /api-key] 400 bad name`);
    res.status(400).json({ error: "name query param must match [A-Za-z0-9._-], 1-64 chars" });
    return;
  }

  const encrypted = readStore()[name];
  if (!encrypted) {
    console.warn(`[${ts()}] [GET /api-key] 404 "${name}" not found`);
    res.status(404).json({ error: `No API key named "${name}"` });
    return;
  }

  try {
    const keyB64 = await dpapi("Unprotect", encrypted);
    const key = Buffer.from(keyB64, "base64").toString("utf8");
    console.log(`[${ts()}] [GET /api-key] returned "${name}" (${key.length} chars)`);
    res.json({ name, key });
  } catch (err) {
    // Typical cause: blob copied from another machine/user — DPAPI cannot decrypt
    console.error(`[${ts()}] [GET /api-key] decrypt failed for "${name}" — ${(err as Error).message}`);
    res.status(500).json({
      error: `Failed to decrypt "${name}" — was it stored by another Windows user or machine?`,
    });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api-key?name={name}
// ---------------------------------------------------------------------------
export function handleDeleteApiKey(req: Request, res: Response): void {
  const name = queryName(req);
  if (!name) {
    console.warn(`[${ts()}] [DELETE /api-key] 400 bad name`);
    res.status(400).json({ error: "name query param must match [A-Za-z0-9._-], 1-64 chars" });
    return;
  }

  const store = readStore();
  if (!(name in store)) {
    console.warn(`[${ts()}] [DELETE /api-key] 404 "${name}" not found`);
    res.status(404).json({ error: `No API key named "${name}"` });
    return;
  }

  delete store[name];
  writeStore(store);
  console.log(`[${ts()}] [DELETE /api-key] removed "${name}"`);
  res.json({ ok: true, name });
}

// ---------------------------------------------------------------------------
// GET /api-key/list
// ---------------------------------------------------------------------------
export function handleListApiKeys(_req: Request, res: Response): void {
  const names = Object.keys(readStore()).sort();
  console.log(`[${ts()}] [GET /api-key/list] ${names.length} key(s)`);
  res.json({ names });
}
