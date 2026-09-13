import { Request, Response } from "express";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { runPowerShell, runProcess } from "./proc";

// Local encrypted API-key store, so Roblox scripts never contain secrets.
//
//   POST   /api-key               { Name, Key }  — store (overwrites)
//   GET    /api-key?name={name}                  — decrypt and return
//   DELETE /api-key?name={name}                  — remove
//   GET    /api-key/list                         — names only, never values
//
// Encrypted blobs live in apikeys.json — plaintext never touches disk and is
// never logged, and secrets never appear on a command line.
//
// Windows: encrypted with DPAPI (CurrentUser scope) via PowerShell — only this
// Windows user on this machine can decrypt. Store in %LOCALAPPDATA%\RobloxBridge.
// Secrets cross to/from PowerShell as base64 over stdin/stdout.
//
// macOS: AES-256-GCM with a random master key kept in the login Keychain
// (service "RobloxBridge"). Store in ~/Library/Application Support/RobloxBridge.

const IS_MAC = process.platform === "darwin";

const STORE_DIR = IS_MAC
  ? path.join(os.homedir(), "Library", "Application Support", "RobloxBridge")
  : path.join(
      process.env.LOCALAPPDATA ??
        path.join(process.env.USERPROFILE ?? ".", "AppData", "Local"),
      "RobloxBridge"
    );
const STORE_PATH = path.join(STORE_DIR, "apikeys.json");

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CRYPTO_TIMEOUT_MS = 15000;

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
  return runPowerShell(script, b64, CRYPTO_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// macOS Keychain master key
// ---------------------------------------------------------------------------
const KEYCHAIN_SERVICE = "RobloxBridge";
const KEYCHAIN_ACCOUNT = "apikeys-master-key";

let masterKey: Buffer | null = null;

function findMasterKeyHex(): Promise<string> {
  return runProcess(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
    "",
    CRYPTO_TIMEOUT_MS
  );
}

async function getMasterKey(): Promise<Buffer> {
  if (masterKey) return masterKey;

  let hex: string;
  try {
    hex = await findMasterKeyHex();
  } catch (err) {
    if (!/could not be found/i.test((err as Error).message)) throw err;

    // First use: create the key. `security -i` reads the command from stdin so
    // the key never shows up in `ps`. Without -U, add fails if a concurrent
    // request already created one — reading back below picks up the winner.
    const newHex = crypto.randomBytes(32).toString("hex");
    await runProcess(
      "security",
      ["-i"],
      `add-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${newHex}\n`,
      CRYPTO_TIMEOUT_MS
    );
    hex = await findMasterKeyHex();
    console.log(`[${ts()}] [api-key] created master key in Keychain (service "${KEYCHAIN_SERVICE}")`);
  }

  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Keychain item "${KEYCHAIN_SERVICE}" is not a valid 256-bit hex key`);
  }
  masterKey = Buffer.from(hex, "hex");
  return masterKey;
}

// Blob: base64(iv[12] | authTag[16] | ciphertext)
async function aesEncrypt(plain: string): Promise<string> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", await getMasterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

async function aesDecrypt(blob: string): Promise<string> {
  const raw = Buffer.from(blob, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", await getMasterKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Platform dispatch
// ---------------------------------------------------------------------------
async function encryptKey(plain: string): Promise<string> {
  if (IS_MAC) return aesEncrypt(plain);
  return dpapi("Protect", Buffer.from(plain, "utf8").toString("base64"));
}

async function decryptKey(blob: string): Promise<string> {
  if (IS_MAC) return aesDecrypt(blob);
  return Buffer.from(await dpapi("Unprotect", blob), "base64").toString("utf8");
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
    const encrypted = await encryptKey(Key);
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
    const key = await decryptKey(encrypted);
    console.log(`[${ts()}] [GET /api-key] returned "${name}" (${key.length} chars)`);
    res.json({ name, key });
  } catch (err) {
    // Typical cause: blob copied from another machine/user, or master key replaced
    console.error(`[${ts()}] [GET /api-key] decrypt failed for "${name}" — ${(err as Error).message}`);
    res.status(500).json({
      error: `Failed to decrypt "${name}" — was it stored by another user or machine?`,
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
