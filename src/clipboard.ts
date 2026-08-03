import { Request, Response } from "express";
import { runPowerShell } from "./winps";

// POST /clipboard — put text into the Windows clipboard.
//
// Roblox scripts cannot write the OS clipboard (setclipboard is
// CoreScript-only), so the plugin sends the text here instead.
//
// Body: { Text: string }  (non-empty)
//
// The text travels to PowerShell as base64 over stdin: no shell quoting, no
// command-line length limit, full UTF-8 fidelity.

function ts() {
  return new Date().toISOString();
}

const PS_SET_CLIPBOARD = [
  "$b64 = [Console]::In.ReadToEnd().Trim();",
  "$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64));",
  "Set-Clipboard -Value $text;",
].join(" ");

export async function handleClipboard(req: Request, res: Response): Promise<void> {
  const text = (req.body as { Text?: unknown }).Text;

  if (typeof text !== "string" || text.length === 0) {
    console.warn(`[${ts()}] [POST /clipboard] 400 Text missing or empty`);
    res.status(400).json({ error: "Text must be a non-empty string" });
    return;
  }

  try {
    await runPowerShell(
      PS_SET_CLIPBOARD,
      Buffer.from(text, "utf8").toString("base64"),
      10000
    );
    console.log(`[${ts()}] [POST /clipboard] copied ${text.length} chars`);
    res.json({ ok: true, length: text.length });
  } catch (err) {
    console.error(`[${ts()}] [POST /clipboard] error — ${(err as Error).message}`);
    res.status(500).json({ error: (err as Error).message });
  }
}
