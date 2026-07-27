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

function ts() {
  return new Date().toISOString();
}

// Explains WHY a cookie read failed without ever revealing the cookie itself.
// Only error metadata (codes, stderr) is logged — never stdout, which holds
// the secret.
function readCookieViaLune(): Promise<string | null> {
  const { lunePath, cookieTimeoutMs } = readConfig().studio;
  return new Promise((resolve) => {
    execFile(
      lunePath,
      ["run", COOKIE_SCRIPT],
      { timeout: cookieTimeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === "ENOENT") {
            console.warn(
              `[${ts()}] [cookie/lune] lune not found (lunePath="${lunePath}") — ` +
                `install lune or set studio.lunePath in config.json`
            );
          } else if ((e as { killed?: boolean }).killed) {
            console.warn(
              `[${ts()}] [cookie/lune] timed out after ${cookieTimeoutMs}ms running ${COOKIE_SCRIPT}`
            );
          } else {
            console.warn(
              `[${ts()}] [cookie/lune] failed (${e.code ?? "?"}) — ` +
                `${(stderr || e.message).toString().trim().slice(0, 200)}`
            );
          }
          return resolve(null);
        }
        const cookie = stdout.trim();
        if (cookie.length === 0) {
          console.warn(
            `[${ts()}] [cookie/lune] lune ran but returned no cookie — ` +
              `no Studio session on this machine?`
          );
          return resolve(null);
        }
        console.log(`[${ts()}] [cookie/lune] ok (${cookie.length} chars)`);
        resolve(cookie);
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
        if (err) {
          // A missing value is the normal case on recent Studio (cookie moved
          // to the Windows Credential Manager) — not worth an error, just note it.
          console.warn(
            `[${ts()}] [cookie/registry] no cookie in registry ` +
              `(expected on recent Studio — cookie is DPAPI-encrypted in Credential Manager)`
          );
          return resolve(null);
        }
        // Raw value: ,SEC::<YES>,EXP::<...>,COOK::<actual-cookie>
        const match = stdout.match(/COOK::<([^>]+)>/);
        if (!match) {
          console.warn(
            `[${ts()}] [cookie/registry] registry value present but no COOK::<...> field found`
          );
          return resolve(null);
        }
        console.log(`[${ts()}] [cookie/registry] ok (${match[1].length} chars)`);
        resolve(match[1]);
      }
    );
  });
}

export async function readStudioCookie(): Promise<string | null> {
  const cookie = (await readCookieViaLune()) ?? (await readCookieViaRegistry());
  if (!cookie) {
    console.warn(
      `[${ts()}] [cookie] no Studio session cookie from any source ` +
        `(lune + registry both failed — see warnings above)`
    );
  }
  return cookie;
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
