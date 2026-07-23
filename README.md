# Roblox Cloud API Bridge

Local HTTP bridge. Roblox Studio → this server → external APIs.

## Requirements

- Node.js 18+
- npm
- pm2 (`npm install -g pm2`)

## First Deploy

```bash
npm install
npm run build
pm2 start ecosystem.config.js
pm2 save
```

## Processes

| Name | Script | Role |
|------|--------|------|
| `bridge` | `dist/server.js` | HTTP proxy server |
| `bridge-tray` | `dist/tray.js` | Windows tray icon |

## Redeploy (after code change)

```bash
npm run deploy
# = npm run build && pm2 restart bridge bridge-tray
```

## pm2 Commands

```bash
pm2 status                  # check both processes
pm2 logs bridge             # server logs
pm2 logs bridge-tray        # tray logs
pm2 restart bridge          # restart server only
pm2 restart bridge-tray     # restart tray only
pm2 stop all                # stop everything
```

## Startup on Login

Run once to auto-resurrect on Windows login:

```bash
pm2 save
```

`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\RobloxBridge.vbs` must call `pm2 resurrect`.

## Config

Stored in `config.json`:

```json
{
  "port": 3000,
  "deploy": {
    "downloadTimeoutMs": 60000,
    "publishTimeoutMs": 120000
  }
}
```

Port default: `3000`. Override via tray menu or:

```bash
PORT=4000 pm2 restart bridge --update-env
```

## Endpoints

### GET /status
```json
{ "status": "ok", "port": 3000, "uptimeSeconds": 42 }
```

### POST /proxy

**Request:**
```json
{
  "Url": "https://api.example.com/data",
  "Method": "GET",
  "Headers": { "Authorization": "Bearer TOKEN" },
  "Body": "",
  "Timeout": 10
}
```

**Response:**
```json
{
  "Success": true,
  "StatusCode": 200,
  "StatusMessage": "OK",
  "Headers": {},
  "Body": "..."
}
```

### POST /deploy

Downloads the source place file (via the locally logged-in Studio session) and
publishes it to every target place through Open Cloud.

**Headers:** `x-api-key: <Open Cloud API key>` (required)

The API key needs the **`universe-places:write`** scope on **every target
universe**.

**Request:**
```json
{
  "sourcePlaceId": 123456,
  "targets": [
    { "name": "Test/Island", "universeId": 111, "placeId": 222 },
    { "name": "Test/Mine",   "universeId": 111, "placeId": 333 }
  ],
  "versionType": "Published"
}
```

- `versionType`: `"Published"` (live immediately) or `"Saved"` (staged version
  only). Default `"Published"`.
- Targets are published sequentially, in array order. A failing target does not
  abort the rest.

**Response** — `200` even with partial failures (caller aggregates `results`):
```json
{
  "ok": true,
  "sourcePlaceId": 123456,
  "sourceSizeBytes": 4587520,
  "versionType": "Published",
  "results": [
    { "name": "Test/Island", "placeId": 222, "ok": true,  "versionNumber": 42 },
    { "name": "Test/Mine",   "placeId": 333, "ok": false, "status": 403, "detail": "API key lacks write scope for universe 111" }
  ]
}
```

Non-200 responses (pre-flight failures only):

| Code | Meaning |
|------|---------|
| `400` | Missing `x-api-key`, empty/duplicate targets, target = source, non-numeric ids, unknown `versionType` |
| `409` | No Roblox Studio session on this machine (open Studio and log in) |
| `502` | Source place download failed (includes Roblox status + body excerpt) |

## Roblox Usage

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
-- result.Success, result.StatusCode, result.Body
```
