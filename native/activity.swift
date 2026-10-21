import AppKit
import ApplicationServices

// Only app/window metadata and elapsed idle time are sampled. No key events or text values are read.
var enabled = false
var generation = 0
var ownerPid: pid_t = 0
var exclusions: Set<String> = []
var lastTarget: NSRunningApplication?
var screenLocked = false

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}
func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}
func element(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func blocked(_ app: NSRunningApplication) -> Bool {
    return exclusions.contains((app.bundleIdentifier ?? "").lowercased()) || exclusions.contains((app.localizedName ?? "").lowercased())
}
func controlSurface(_ app: NSRunningApplication?) -> Bool {
    return app?.processIdentifier == ownerPid || app?.bundleIdentifier == "com.apple.systemuiserver"
}
func snapshot(_ app: NSRunningApplication) -> [String: Any]? {
    if blocked(app) { return nil }
    let trusted = AXIsProcessTrusted()
    var title = ""
    if trusted {
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        // Check the actual focused field, before reading any window or selection content.
        if let focused = element(attribute(appElement, kAXFocusedUIElementAttribute as CFString)),
           (attribute(focused, kAXSubroleAttribute as CFString) as? String) == (kAXSecureTextFieldSubrole as String) { return nil }
        if let window = element(attribute(appElement, kAXFocusedWindowAttribute as CFString)) {
            title = attribute(window, kAXTitleAttribute as CFString) as? String ?? ""
        }
    }
    if title.range(of: "incognito|private browsing|隐身|无痕|隐私浏览", options: [.regularExpression, .caseInsensitive]) != nil { return nil }
    let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!)
    return ["time": Int(Date().timeIntervalSince1970 * 1000), "app": app.localizedName ?? "Unknown app",
            "bundleId": app.bundleIdentifier ?? "", "pid": app.processIdentifier, "window": title, "idleSeconds": max(0, idle), "trusted": trusted]
}
func sample() {
    if !enabled { return }
    var value: [String: Any] = ["type": "sample", "generation": generation, "trusted": AXIsProcessTrusted()]
    if screenLocked || NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.loginwindow" {
        lastTarget = nil; value["blocked"] = true; value["locked"] = true; emit(value); return
    }
    if let app = NSWorkspace.shared.frontmostApplication, !controlSurface(app),
       let observation = snapshot(app) {
        lastTarget = app
        value.merge(observation) { _, next in next }
    } else {
        value["blocked"] = true
        // Do not let selection capture reach a previous app after visiting an excluded one.
        if !controlSurface(NSWorkspace.shared.frontmostApplication) { lastTarget = nil }
    }
    emit(value)
}
func command(_ value: [String: Any]) {
    let kind = value["type"] as? String ?? ""
    if kind == "configure" {
        enabled = value["enabled"] as? Bool ?? false
        generation = value["generation"] as? Int ?? 0
        ownerPid = pid_t(value["ownerPid"] as? Int ?? 0)
        exclusions = Set((value["excludedApps"] as? [String] ?? []).map { $0.lowercased() })
        if !enabled { lastTarget = nil }
        emit(["type": "ready", "generation": generation, "trusted": AXIsProcessTrusted()])
        sample()
    } else if kind == "permission" {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)
        emit(["type": "ready", "generation": generation, "trusted": trusted])
        if !trusted, let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") { NSWorkspace.shared.open(url) }
    } else if kind == "selection" {
        let id = value["id"] as? String ?? ""
        func fail(_ message: String) { emit(["type": "selection", "id": id, "generation": generation, "error": message]) }
        guard enabled else { fail("活动记录已暂停。"); return }
        guard !screenLocked, NSWorkspace.shared.frontmostApplication?.bundleIdentifier != "com.apple.loginwindow" else { fail("屏幕已锁定，活动记录暂停。"); return }
        guard AXIsProcessTrusted() else { fail("读取选中文字需要 macOS 辅助功能权限。"); return }
        let front = NSWorkspace.shared.frontmostApplication
        let target = controlSurface(front) ? lastTarget : front
        guard let app = target, app.processIdentifier != ownerPid, !app.isTerminated,
              var observation = snapshot(app) else { fail("目标应用已被排除，或没有最近的可用窗口。"); return }
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        guard let focused = element(attribute(appElement, kAXFocusedUIElementAttribute as CFString)),
              let text = attribute(focused, kAXSelectedTextAttribute as CFString) as? String, !text.isEmpty else {
            fail("未读取到选中文字；这个应用可能不支持。请先选中文字，再使用托盘里的记录选中文字。"); return
        }
        observation.merge(["type": "selection", "id": id, "generation": generation, "text": text]) { _, next in next }
        emit(observation)
    }
}

let notification = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
    object: nil, queue: .main) { _ in sample() }
let lockedNotification = DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { _ in screenLocked = true; lastTarget = nil; sample() }
let unlockedNotification = DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { _ in screenLocked = false; sample() }
let timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in sample() }
timer.tolerance = 0.25
// Serialize commands with the sampling run loop, so a pause cannot race a text request.
DispatchQueue.global().async {
    while let line = readLine() {
        if let data = line.data(using: .utf8), let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            DispatchQueue.main.async { command(value) }
        }
    }
    exit(0)
}
emit(["type": "ready", "generation": generation, "trusted": AXIsProcessTrusted()])
RunLoop.main.run()
