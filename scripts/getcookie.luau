-- Emits the locally logged-in Roblox Studio auth cookie on stdout.
-- Invoked by the bridge (src/robloxAuth.ts) via `lune run`.
--
-- lune's roblox.getAuthCookie reads the cookie from wherever the current
-- Studio version stores it (Windows Credential Manager on recent Studio,
-- registry on older). raw = true returns the bare cookie value, ready to be
-- placed after ".ROBLOSECURITY=" in a Cookie header.
--
-- Security: this script contains no secret. The cookie exists only on this
-- process's stdout, captured by the parent in memory. Never logged/persisted.
local roblox = require("@lune/roblox")
local stdio = require("@lune/stdio")
local process = require("@lune/process")

local cookie = roblox.getAuthCookie(true)
if cookie == nil or cookie == "" then
	-- Non-zero exit tells the parent no session was found
	stdio.ewrite("no auth cookie\n")
	process.exit(1)
end

stdio.write(cookie)
