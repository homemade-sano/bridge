import { spawn } from "child_process";

// Shared PowerShell runner for Windows-only features (clipboard, DPAPI).
//
// Data crosses process boundaries via stdin/stdout only — never on the
// command line, where it would be visible in Task Manager / process lists.
// Callers pass base64 through both directions to sidestep console encoding
// (PS 5.1 console I/O is not UTF-8 by default).

export function runPowerShell(
  script: string,
  stdin: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true }
    );

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`powershell timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim().slice(0, 300) || `powershell exited with code ${code}`));
      }
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}
