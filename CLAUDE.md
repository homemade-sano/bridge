# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A local HTTP bridge that lets Roblox Studio scripts call external APIs via a custom plugin. Roblox's `HttpService:RequestAsync` cannot reach most external services directly, so it POSTs to this local server which forwards the request and returns the response.

## Commands

```bash
npm run build    # compile TypeScript → dist/
npm start        # run compiled server (dist/server.js)
npm run dev      # watch mode (tsc --watch)
```

Server binds to `127.0.0.1:3000` by default. Override with `PORT` env var or via tray port-change menu (saved to `config.json`).

## Architecture

TypeScript sources in `src/`, compiled to `dist/`. Two processes, both managed by pm2:

- `src/server.ts` — the HTTP bridge
- `src/tray.ts` — Windows system tray icon (polls `/health` every 5s; menu: Change Port, Open Logs, Restart Bridge, Quit Tray)
- `src/config.ts` — read/write `config.json` (port persistence)

`assets/systray.webp` is loaded at tray startup, converted to ICO via `sharp`.

pm2 commands:
```bash
pm2 status                # check both processes
pm2 logs bridge           # bridge logs
pm2 logs bridge-tray      # tray logs
pm2 restart bridge        # restart after code change
```

At login, `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\RobloxBridge.vbs` runs `pm2 resurrect` which restores both processes.

macOS: `scripts/macos-service.sh` (install|deploy|status|uninstall). The bridge runs from a copy in `~/Library/Application Support/RobloxBridge/app` (launchd can't read `~/Documents`), so redeploy with `npm run deploy:mac` — `config.json` there is the live one. LaunchAgent `com.robloxbridge.watchdog` runs `scripts/watchdog.sh` at login + every 30s (restarts/resurrects on failed `/health`). macOS tray = native menu bar binary from `macos/BridgeMenu.swift` (systray2's darwin binary is x86_64-only), compiled by deploy to `<app>/bin/bridge-menu`, run by pm2 as `bridge-tray`. Its pm2 `script` must stay relative — pm2 wraps paths containing spaces in `bash -c`.

### `src/server.ts`

Endpoints:

**`GET /status`** — bridge liveness + info:
```json
{ "status": "ok", "port": 3000, "uptimeSeconds": 42 }
```

**`POST /proxy`**

**Request body** (mirrors Roblox `RequestAsync` input dictionary):
| Field | Type | Notes |
|-------|------|-------|
| `Url` | string | required, target URL |
| `Method` | string | HTTP method, defaults to `GET` |
| `Headers` | object | forwarded as-is |
| `Body` | string | request body, omitted for GET/HEAD |
| `Compress` | string | `"None"` or `"Gzip"` |
| `Timeout` | number | seconds |

**Response body** (mirrors Roblox `RequestAsync` response dictionary):
| Field | Type | Notes |
|-------|------|-------|
| `Success` | bool | true if status 200–299 |
| `StatusCode` | number | |
| `StatusMessage` | string | |
| `Headers` | object | |
| `Body` | string | always a string, never parsed |

Network-level errors (timeout, unreachable) return HTTP 500 with `StatusCode: 0`.

A bridge-level `x-api-key` header (on the hop to the bridge) is injected upstream; inner `Headers` win on conflict.

**`POST /proxy/multipart`** — same envelope as `/proxy`, but the bridge builds the multipart/form-data body so binary parts survive. Body: `{ Url, Method?="POST", Headers?, Timeout?, Fields?: {name: string|number|boolean}, Files?: [{ name, filename, contentType?, dataBase64 }] }`. Any `Content-Type` in `Headers` is dropped (boundary generated). JSON body limit is 20mb.

**`POST /deploy`** (x-api-key = Open Cloud key) — v1: `{ sourcePlaceId, targets:[{name, universeId, placeId}], versionType? }` publishes the source's latest saved version to each target. v2 (any target has `code`): per target `code: {placeId, version:"saved"|"published"} | "keep"` and `map: {…} | "keep" | "none"`; "keep" = the target's own published version. The map's Workspace + Terrain are grafted into the code place by `scripts/assemble.luau` (Lune), all downloads + assemblies happen before the first publish, failures are per target (422 = base without `ReplicatedStorage.Contents`). Handlers in `src/deploy.ts`; version lookup/download/Lune runner in `src/placeFiles.ts`. Without `&version=`, assetdelivery serves the latest SAVED version.

**`GET /places/versions?placeId=`** → `{ placeId, saved, published? }` (`{version, updated}` each). **`POST /places/extract`** `{ placeId, version, paths }` → `{ placeId, resolved, items:[{path, ok, dataBase64?, sizeBytes?, detail?}] }` (.rbxm via `scripts/extract.luau`). Both use the Studio cookie (develop.roblox.com version history, deprecated by Roblox in favor of Open Cloud Assets).

**`POST /clipboard`** — put text into the OS clipboard (Roblox scripts can't; `setclipboard` is CoreScript-only). Body: `{ "Text": "..." }` (non-empty). Response: `{ "ok": true, "length": n }`. Windows: PowerShell `Set-Clipboard`, text passed as base64 over stdin (UTF-8 safe). macOS: `pbcopy` over stdin with `LANG=en_US.UTF-8`.

**API-key store** (`src/apikeys.ts`) — plaintext never on disk, never logged, never on a command line (child processes spawned via `src/proc.ts`, data over stdin/stdout).
- Windows: DPAPI (CurrentUser scope) via PowerShell; blobs in `%LOCALAPPDATA%\RobloxBridge\apikeys.json`.
- macOS: AES-256-GCM, master key in the login Keychain (service `RobloxBridge`, account `apikeys-master-key`, created on first use via `security -i`); blobs in `~/Library/Application Support/RobloxBridge/apikeys.json`. Deleting the Keychain item makes existing blobs undecryptable.

| Endpoint | Input | Response |
|----------|-------|----------|
| `POST /api-key` | `{ "Name": "...", "Key": "..." }` | `{ ok, name, overwritten }` |
| `GET /api-key?name=...` | — | `{ name, key }` (404 if unknown) |
| `DELETE /api-key?name=...` | — | `{ ok, name }` |
| `GET /api-key/list` | — | `{ names: [...] }` (never values) |

Name must match `[A-Za-z0-9._-]{1,64}`. Note: anything running on this machine can hit `127.0.0.1` and read keys — DPAPI/Keychain protect against other OS users and file exfiltration, not local processes.

## Roblox plugin usage

```lua
local HttpService = game:GetService("HttpService")

local response = HttpService:RequestAsync({
    Url = "http://127.0.0.1:3000/proxy",
    Method = "POST",
    Headers = { ["Content-Type"] = "application/json" },
    Body = HttpService:JSONEncode({
        Url = "https://api.example.com/data",
        Method = "GET",
        Headers = { ["Authorization"] = "Bearer TOKEN" },
    }),
})

local result = HttpService:JSONDecode(response.Body)
-- result.Success, result.StatusCode, result.Body ...
```
