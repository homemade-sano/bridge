import { Request, Response } from "express";
import { runPowerShell, runProcess } from "./proc";

// POST /clipboard — put text into the OS clipboard.
//
// Roblox scripts cannot write the OS clipboard (setclipboard is
// CoreScript-only), so the plugin sends the text here instead.
//
// Body: { Text: string }  (non-empty)
//
// Windows: the text travels to PowerShell as base64 over stdin: no shell
// quoting, no command-line length limit, full UTF-8 fidelity.
// macOS: raw text piped to pbcopy over stdin.

function ts() {
  return new Date().toISOString();
}

const PS_SET_CLIPBOARD = [
  "$b64 = [Console]::In.ReadToEnd().Trim();",
  "$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64));",
  "Set-Clipboard -Value $text;",
].join(" ");

function setClipboard(text: string): Promise<string> {
  if (process.platform === "darwin") {
    // pbcopy decodes stdin using the locale — pm2 may start us without LANG
    return runProcess("pbcopy", [], text, 10000, { ...process.env, LANG: "en_US.UTF-8" });
  }
  return runPowerShell(
    PS_SET_CLIPBOARD,
    Buffer.from(text, "utf8").toString("base64"),
    10000
  );
}

export async function handleClipboard(req: Request, res: Response): Promise<void> {
  const text = (req.body as { Text?: unknown }).Text;

  if (typeof text !== "string" || text.length === 0) {
    console.warn(`[${ts()}] [POST /clipboard] 400 Text missing or empty`);
    res.status(400).json({ error: "Text must be a non-empty string" });
    return;
  }

  try {
    await setClipboard(text);
    console.log(`[${ts()}] [POST /clipboard] copied ${text.length} chars`);
    res.json({ ok: true, length: text.length });
  } catch (err) {
    console.error(`[${ts()}] [POST /clipboard] error — ${(err as Error).message}`);
    res.status(500).json({ error: (err as Error).message });
  }
}
