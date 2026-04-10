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
