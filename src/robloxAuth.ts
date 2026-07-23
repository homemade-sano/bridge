import { execFile } from "child_process";
import path from "path";
import { readConfig } from "./config";

// Shared helpers for endpoints that authenticate with the locally logged-in
// Roblox Studio session instead of an Open Cloud API key.

// ---------------------------------------------------------------------------
// Studio session cookie.
//
// Recent Studio versions no longer store .ROBLOSECURITY in the registry
// (HKCU\...\RobloxStudioBrowser) — it moved to the Windows Credential Manager
// (DPAPI-encrypted). We read it via `lune run scripts/getcookie.luau`, which
// uses lune's roblox.getAuthCookie (backed by rbx_cookie) to read whichever
// location the installed Studio uses. The old registry read is kept as a
// fallback for older Studio versions / machines without lune.
//
// The cookie is kept in memory only for the duration of the request. Never
// logged, never written to disk, never included in a response.
// ---------------------------------------------------------------------------

// __dirname is dist/ at runtime; the script lives at <root>/scripts/
const COOKIE_SCRIPT = path.join(__dirname, "..", "scripts", "getcookie.luau");
const STUDIO_REG_KEY = "HKCU\\Software\\Roblox\\RobloxStudioBrowser\\roblox.com";

function readCookieViaLune(): Promise<string | null> {
  const { lunePath, cookieTimeoutMs } = readConfig().studio;
  return new Promise((resolve) => {
    execFile(
      lunePath,
      ["run", COOKIE_SCRIPT],
      { timeout: cookieTimeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const cookie = stdout.trim();
        resolve(cookie.length > 0 ? cookie : null);
      }
    );
  });
}

function readCookieViaRegistry(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", STUDIO_REG_KEY, "/v", ".ROBLOSECURITY"],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        // Raw value: ,SEC::<YES>,EXP::<...>,COOK::<actual-cookie>
        const match = stdout.match(/COOK::<([^>]+)>/);
        resolve(match ? match[1] : null);
      }
    );
  });
}

export async function readStudioCookie(): Promise<string | null> {
  return (await readCookieViaLune()) ?? (await readCookieViaRegistry());
}

// ---------------------------------------------------------------------------
// CSRF dance for legacy (cookie-authenticated) Roblox web endpoints:
// first attempt without a token is rejected 403 with an x-csrf-token response
// header — retry the same request once with that token.
// ---------------------------------------------------------------------------
export async function csrfFetch(
  url: string,
  init: RequestInit & { headers?: Record<string, string> }
): Promise<Response> {
  let response = await fetch(url, init);
  if (response.status === 403) {
    const token = response.headers.get("x-csrf-token");
    if (token) {
      response = await fetch(url, {
        ...init,
        headers: { ...(init.headers ?? {}), "X-CSRF-TOKEN": token },
      });
    }
  }
  return response;
}
