import AppKit
import Foundation

struct LaunchConfiguration: Decodable {
    let project: String
    let executable: String
    let home: String
    let log: String
}

func quote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--make-icon" {
    let image = NSImage(size: NSSize(width: 1024, height: 1024))
    image.lockFocus()
    NSColor(white: 0.97, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 960, height: 960), xRadius: 210, yRadius: 210).fill()
    let text = NSAttributedString(string: "C", attributes: [
        .font: NSFont(name: "Georgia-Bold", size: 720) ?? NSFont.boldSystemFont(ofSize: 720),
        .foregroundColor: NSColor(white: 0.12, alpha: 1),
    ])
    text.draw(at: NSPoint(x: (1024 - text.size().width) / 2, y: (1024 - text.size().height) / 2))
    image.unlockFocus()
    let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
    try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
    exit(0)
}

do {
    let resource = Bundle.main.resourceURL!.appendingPathComponent("launcher.json")
    let config = try JSONDecoder().decode(LaunchConfiguration.self, from: Data(contentsOf: resource))
    let files = FileManager.default
    guard files.isExecutableFile(atPath: config.executable), files.fileExists(atPath: config.project + "/out/main/index.js") else {
        throw NSError(domain: "Clax", code: 1, userInfo: [NSLocalizedDescriptionKey: "找不到 Clax 运行文件。请在项目目录运行 pnpm desktop:install，更新启动入口。"])
    }
    try files.createDirectory(atPath: (config.log as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    if !files.fileExists(atPath: config.log) { files.createFile(atPath: config.log, contents: nil, attributes: [.posixPermissions: 0o600]) }
    let output = try FileHandle(forWritingTo: URL(fileURLWithPath: config.log))
    try output.seekToEnd()
    let hidden = CommandLine.arguments.contains("--background")
    let arguments = ["/usr/bin/env", "-u", "ELECTRON_RUN_AS_NODE", "-u", "ELECTRON_RENDERER_URL", "-u", "CLAX_TEST", "-u", "DESKAGENT_TEST",
                     "CLAX_HOME=\(config.home)", "CLAX_SHOW=\(hidden ? "0" : "1")", config.executable, config.project]
    let task = Process()
    // Load exported shell keys at runtime; never copy their values into the launcher or login item.
    task.executableURL = URL(fileURLWithPath: "/bin/zsh")
    task.arguments = ["-ilc", "exec " + arguments.map(quote).joined(separator: " ")]
    task.currentDirectoryURL = URL(fileURLWithPath: config.project)
    task.standardInput = FileHandle.nullDevice
    task.standardOutput = output
    task.standardError = output
    try task.run()
} catch {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "Clax 未能启动"
    alert.informativeText = error.localizedDescription
    alert.runModal()
    exit(1)
}
