import AppKit

// A controlled native window verifies AX titles, selected text and secure-field exclusion.
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 500, height: 260),
    styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Clax 活动验证窗口"
let text = NSTextView(frame: NSRect(x: 20, y: 90, width: 450, height: 130))
text.string = "fixture-selected-text 中文验证内容"
let password = NSSecureTextField(frame: NSRect(x: 20, y: 30, width: 280, height: 25))
password.stringValue = "secure-fixture-must-not-be-read"
window.contentView?.addSubview(text); window.contentView?.addSubview(password)
func focus(_ secure: Bool) {
    window.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    window.makeFirstResponder(secure ? password : text)
    if !secure { text.setSelectedRange(NSRange(location: 0, length: (text.string as NSString).length)) }
}
DispatchQueue.main.async { focus(false); print("ready"); fflush(stdout) }
DispatchQueue.global().async {
    while let line = readLine() { DispatchQueue.main.async { focus(line == "password") } }
    exit(0)
}
app.run()
