import Cocoa
import WebKit

final class LocalApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusLabel: NSTextField!
    private var service: Process?
    private var logHandle: FileHandle?
    private var healthTimer: Timer?
    private var closing = false

    private let host = "127.0.0.1"
    private let port = 3210

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        let warning = NSAlert()
        warning.messageText = "启动本地 AI 客服？"
        warning.informativeText = "本地库包含服务器同步的 Telegram 客服账号。请确认服务器客服已停止，避免两边同时接收消息。关闭本窗口会立即停止本地服务。"
        warning.alertStyle = .warning
        warning.addButton(withTitle: "启动本地版")
        warning.addButton(withTitle: "退出")
        if warning.runModal() != .alertFirstButtonReturn {
            NSApp.terminate(nil)
            return
        }
        startService()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        closing = true
        healthTimer?.invalidate()
        stopService()
    }

    func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }

    private var projectDirectory: URL { Bundle.main.bundleURL.deletingLastPathComponent() }

    private func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1280, height: 820)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "AI 客服 · 本地版"
        window.center()
        window.delegate = self
        window.minSize = NSSize(width: 900, height: 620)

        webView = WKWebView(frame: frame)
        webView.autoresizingMask = [.width, .height]
        webView.isHidden = true

        statusLabel = NSTextField(labelWithString: "正在启动本地 AI 客服…")
        statusLabel.alignment = .center
        statusLabel.font = .systemFont(ofSize: 16, weight: .medium)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.frame = NSRect(x: 80, y: 370, width: 1120, height: 40)
        statusLabel.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]

        let content = NSView(frame: frame)
        content.addSubview(webView)
        content.addSubview(statusLabel)
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func startService() {
        let entry = projectDirectory.appendingPathComponent("dist/server.js")
        guard FileManager.default.fileExists(atPath: entry.path) else {
            showError("缺少构建文件 dist/server.js，请重新安装本地版本。")
            return
        }
        let logDirectory = projectDirectory.appendingPathComponent("data/runtime/logs", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
            let logURL = logDirectory.appendingPathComponent("local-app.log")
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: logURL)
            try handle.seekToEnd()
            logHandle = handle

            var environment = ProcessInfo.processInfo.environment
            let localBin = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/pnpm/bin").path
            environment["PATH"] = [localBin, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
                .joined(separator: ":")
            environment["HOST"] = host
            environment["PORT"] = String(port)
            environment["DATA_DIR"] = projectDirectory.appendingPathComponent("data").path
            environment["AI_SUPPORT_CODE_LIBRARY_ROOT"] = projectDirectory
                .deletingLastPathComponent()
                .appendingPathComponent("ai客服项目代码").path
            environment["AI_SUPPORT_ALLOW_NEWER_DATABASE_SCHEMA"] = "1"
            environment["LOG_LEVEL"] = "info"

            let process = Process()
            guard let nodeURL = Bundle.main.resourceURL?.appendingPathComponent("node"),
                  FileManager.default.isExecutableFile(atPath: nodeURL.path) else {
                showError("本地程序缺少 Node.js 运行时，请重新安装本地版本。")
                return
            }
            process.executableURL = nodeURL
            process.arguments = [entry.path]
            process.currentDirectoryURL = projectDirectory
            process.environment = environment
            process.standardOutput = handle
            process.standardError = handle
            process.terminationHandler = { [weak self] task in
                DispatchQueue.main.async {
                    guard let self, !self.closing else { return }
                    self.showError("本地服务已退出（状态码 \(task.terminationStatus)）。详情见 data/runtime/logs/local-app.log")
                }
            }
            try process.run()
            service = process
            beginHealthCheck()
        } catch {
            showError("本地服务启动失败：\(error.localizedDescription)")
        }
    }

    private func beginHealthCheck() {
        var attempts = 0
        healthTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            guard let self else { return }
            attempts += 1
            var request = URLRequest(url: URL(string: "http://\(self.host):\(self.port)/health")!)
            request.timeoutInterval = 0.4
            URLSession.shared.dataTask(with: request) { _, response, _ in
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    if attempts >= 60 {
                        DispatchQueue.main.async {
                            timer.invalidate()
                            self.showError("服务启动超过 30 秒仍未就绪，请查看 data/runtime/logs/local-app.log")
                        }
                    }
                    return
                }
                DispatchQueue.main.async {
                    timer.invalidate()
                    self.statusLabel.isHidden = true
                    self.webView.isHidden = false
                    self.webView.load(URLRequest(url: URL(string: "http://\(self.host):\(self.port)/")!))
                }
            }.resume()
        }
    }

    private func showError(_ message: String) {
        statusLabel.stringValue = message
        statusLabel.textColor = .systemRed
        statusLabel.isHidden = false
        webView.isHidden = true
    }

    private func stopService() {
        guard let process = service else {
            try? logHandle?.close()
            return
        }
        if process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(5)
            while process.isRunning && Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            }
            if process.isRunning {
                kill(process.processIdentifier, SIGKILL)
                process.waitUntilExit()
            }
        }
        service = nil
        try? logHandle?.close()
        logHandle = nil
    }
}

@main
enum LocalAppLauncher {
    static func main() {
        let application = NSApplication.shared
        let delegate = LocalApp()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
        withExtendedLifetime(delegate) {}
    }
}
