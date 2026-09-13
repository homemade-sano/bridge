import AppKit

// Roblox Bridge menu bar item — macOS counterpart of src/tray.ts.
//
// systray2's macOS binary is x86_64-only (needs Rosetta), so on macOS the tray
// is this native binary instead. Compiled by scripts/macos-service.sh deploy to
// <app>/bin/bridge-menu and run by pm2 as "bridge-tray".
//
// Menu: status (polls /health every 5s), Change Port, Open Logs, Open Watchdog
// Log, Restart Bridge, Quit.

let appDir = Bundle.main.executableURL!
  .resolvingSymlinksInPath()
  .deletingLastPathComponent() // bin/
  .deletingLastPathComponent() // app/
let configURL = appDir.appendingPathComponent("config.json")
let watchdogLog = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Logs/RobloxBridge/watchdog.log")

// Same file and precedence as src/config.ts and scripts/watchdog.sh
func readConfig() -> [String: Any] {
  guard let data = try? Data(contentsOf: configURL),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { return [:] }
  return obj
}

func configuredPort() -> Int {
  (readConfig()["port"] as? Int) ?? 3000
}

func writePort(_ port: Int) throws {
  var config = readConfig()
  config["port"] = port
  let data = try JSONSerialization.data(
    withJSONObject: config, options: [.prettyPrinted, .sortedKeys])
  try data.write(to: configURL, options: .atomic)
}

func pm2(_ args: String, then: (() -> Void)? = nil) {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/bin/sh")
  process.arguments = ["-c", "pm2 \(args)"]
  var env = ProcessInfo.processInfo.environment
  env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
  process.environment = env
  process.terminationHandler = { _ in DispatchQueue.main.async { then?() } }
  do {
    try process.run()
  } catch {
    NSLog("bridge-menu: failed to run pm2 \(args): \(error)")
  }
}

final class MenuController: NSObject {
  let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  let itemStatus = NSMenuItem(title: "Checking…", action: nil, keyEquivalent: "")
  let itemChangePort = NSMenuItem(title: "", action: #selector(changePort), keyEquivalent: "")
  var port = configuredPort()
  var lastRunning: Bool?

  override init() {
    super.init()

    if let button = statusItem.button {
      if let image = NSImage(contentsOf: appDir.appendingPathComponent("assets/systray.webp")) {
        image.size = NSSize(width: 18, height: 18)
        button.image = image
      } else {
        button.image = NSImage(
          systemSymbolName: "arrow.left.arrow.right.circle", accessibilityDescription: "Roblox Bridge")
      }
      button.toolTip = "Roblox Bridge"
    }

    let menu = NSMenu()
    menu.autoenablesItems = false
    itemStatus.isEnabled = false
    menu.addItem(itemStatus)
    menu.addItem(.separator())
    menu.addItem(itemChangePort)
    menu.addItem(item("Open Logs", #selector(openLogs)))
    menu.addItem(item("Open Watchdog Log", #selector(openWatchdogLog)))
    menu.addItem(item("Restart Bridge", #selector(restartBridge)))
    menu.addItem(.separator())
    menu.addItem(item("Quit Menu", #selector(quit)))
    for entry in menu.items { entry.target = self }
    statusItem.menu = menu

    updateTitles()
    checkHealth()
    Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      self?.checkHealth()
    }
  }

  func item(_ title: String, _ action: Selector) -> NSMenuItem {
    NSMenuItem(title: title, action: action, keyEquivalent: "")
  }

  func updateTitles() {
    itemChangePort.title = "Change Port (current: \(port))…"
    statusItem.button?.toolTip = "Roblox Bridge — http://127.0.0.1:\(port)"
  }

  func checkHealth() {
    // Pick up manual edits of config.json
    let current = configuredPort()
    if current != port {
      port = current
      lastRunning = nil
      updateTitles()
    }

    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/health")!)
    request.timeoutInterval = 1
    URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
      let running = (response as? HTTPURLResponse)?.statusCode == 200
      DispatchQueue.main.async { self?.setRunning(running) }
    }.resume()
  }

  func setRunning(_ running: Bool) {
    guard running != lastRunning else { return }
    lastRunning = running
    itemStatus.title = running ? "● Running on :\(port)" : "○ Stopped"
    statusItem.button?.appearsDisabled = !running
  }

  @objc func changePort() {
    let alert = NSAlert()
    alert.messageText = "Roblox Bridge"
    alert.informativeText = "Enter new port number:"
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 200, height: 24))
    field.stringValue = String(port)
    alert.accessoryView = field
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = field
    NSApp.activate(ignoringOtherApps: true)

    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let text = field.stringValue.trimmingCharacters(in: .whitespaces)
    guard let newPort = Int(text), (1...65535).contains(newPort) else {
      showError("\"\(text)\" is not a valid port (1-65535).")
      return
    }
    guard newPort != port else { return }

    do {
      try writePort(newPort)
    } catch {
      showError("Could not write \(configURL.path): \(error.localizedDescription)")
      return
    }
    port = newPort
    lastRunning = nil
    updateTitles()
    itemStatus.title = "Restarting…"
    pm2("restart bridge") { [weak self] in self?.checkHealth() }
  }

  // Terminal window tailing pm2 logs, like the cmd window on Windows. A
  // .command file opens in Terminal without Automation permission.
  @objc func openLogs() {
    let script = FileManager.default.temporaryDirectory
      .appendingPathComponent("roblox-bridge-logs.command")
    let body = """
      #!/bin/zsh -l
      export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
      clear
      pm2 logs bridge

      """
    do {
      try body.write(to: script, atomically: true, encoding: .utf8)
      try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
      NSWorkspace.shared.open(script)
    } catch {
      showError("Could not open logs: \(error.localizedDescription)")
    }
  }

  @objc func openWatchdogLog() {
    let fm = FileManager.default
    if !fm.fileExists(atPath: watchdogLog.path) {
      try? fm.createDirectory(
        at: watchdogLog.deletingLastPathComponent(), withIntermediateDirectories: true)
      fm.createFile(atPath: watchdogLog.path, contents: nil)
    }
    let console = URL(fileURLWithPath: "/System/Applications/Utilities/Console.app")
    NSWorkspace.shared.open(
      [watchdogLog], withApplicationAt: console, configuration: NSWorkspace.OpenConfiguration())
  }

  @objc func restartBridge() {
    lastRunning = nil
    itemStatus.title = "Restarting…"
    pm2("restart bridge") { [weak self] in self?.checkHealth() }
  }

  // Plain exit would be undone by pm2 autorestart — stop it through pm2
  @objc func quit() {
    pm2("stop bridge-tray") { NSApp.terminate(nil) }
  }

  func showError(_ message: String) {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Roblox Bridge"
    alert.informativeText = message
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = MenuController()
app.run()
