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

Port stored in `config.json`. Default: `3000`. Override via tray menu or:

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
