import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import IOKit.pwr_mgt

struct ControlFile: Codable {
    let command: String
    let revision: Int
}

final class ProtectionView: NSView {
    let standby: Bool

    init(frame frameRect: NSRect, standby: Bool) {
        self.standby = standby
        super.init(frame: frameRect)
    }

    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if !standby {
            NSColor.black.withAlphaComponent(0.40).setFill()
            dirtyRect.fill()
        }
        let inset = bounds.insetBy(dx: 28, dy: 28)
        let border = NSBezierPath(roundedRect: inset, xRadius: 30, yRadius: 30)
        border.lineWidth = 6
        (standby ? NSColor.systemYellow : NSColor.systemGreen).withAlphaComponent(0.90).setStroke()
        border.stroke()
        guard !standby else { return }
        let panelWidth: CGFloat = min(660, bounds.width - 120)
        let panelRect = NSRect(x: bounds.midX - panelWidth / 2, y: bounds.midY - 90, width: panelWidth, height: 180)
        let panel = NSBezierPath(roundedRect: panelRect, xRadius: 24, yRadius: 24)
        NSColor.black.withAlphaComponent(0.62).setFill()
        panel.fill()
        let title = "Mac 已进入被动锁屏保护"
        let subtitle = "显示器保持唤醒 · 任意键盘或鼠标操作将立即锁屏"
        let titleAttributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 28, weight: .semibold), .foregroundColor: NSColor.white]
        let subtitleAttributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 16), .foregroundColor: NSColor.white.withAlphaComponent(0.82)]
        let titleSize = title.size(withAttributes: titleAttributes)
        let subtitleSize = subtitle.size(withAttributes: subtitleAttributes)
        title.draw(at: NSPoint(x: bounds.midX - titleSize.width / 2, y: bounds.midY + 12), withAttributes: titleAttributes)
        subtitle.draw(at: NSPoint(x: bounds.midX - subtitleSize.width / 2, y: bounds.midY - 32), withAttributes: subtitleAttributes)
    }
}

final class PassiveLockService: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let controlPath: String?
    private let statusPath: String
    private let legacyStatePath: String?
    private let legacySessionId: String?
    private let persistent: Bool
    private var lastRevision = -1
    private var assertionID: IOPMAssertionID = 0
    private var windows: [NSWindow] = []
    private var permissionWindow: NSWindow?
    private var localMonitor: Any?
    private var globalMonitor: Any?
    private var armed = false
    private var triggered = false
    private var state = "standby"
    private let lock = NSLock()

    init(controlPath: String?, statusPath: String, legacyStatePath: String? = nil, legacySessionId: String? = nil) {
        self.controlPath = controlPath
        self.statusPath = statusPath
        self.legacyStatePath = legacyStatePath
        self.legacySessionId = legacySessionId
        self.persistent = controlPath != nil
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        writeStatus("started")
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
        if persistent { tick() } else { requestArm() }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ notification: Notification) { cleanupProtection(); writeStatus("stopped") }

    private func tick() {
        if let legacyStatePath, let legacySessionId, sessionEnded(statePath: legacyStatePath, sessionId: legacySessionId) {
            writeStatus("session_ended"); NSApp.terminate(nil); return
        }
        guard let controlPath,
              let data = FileManager.default.contents(atPath: controlPath),
              let control = try? JSONDecoder().decode(ControlFile.self, from: data),
              control.revision != lastRevision else { return }
        lastRevision = control.revision
        switch control.command {
        case "arm": requestArm()
        case "standby": enterStandby(reason: "standby_requested")
        case "stop": writeStatus("stop_requested"); NSApp.terminate(nil)
        default: writeStatus("unknown_command:\(control.command)")
        }
    }

    private func requestArm() {
        guard !armed else { writeStatus("already_armed"); return }
        guard accessibilityTrusted(prompt: true) else {
            state = "waiting_permission"
            writeStatus("waiting_accessibility_permission")
            showPermissionWindow()
            return
        }
        permissionWindow?.orderOut(nil); permissionWindow = nil
        beginProtection()
    }

    private func beginProtection() {
        guard !armed else { return }
        triggered = false
        createPowerAssertion()
        createProtectionWindows()
        installEventMonitors()
        state = "arming"
        writeStatus("visible_waiting_for_arm")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            guard let self, self.state == "arming" else { return }
            self.armed = true
            self.state = "armed"
            self.writeStatus("armed")
        }
    }

    private func enterStandby(reason: String) {
        armed = false
        state = "standby"
        cleanupProtection()
        createStandbyWindows()
        writeStatus(reason)
    }

    private func handleInput() {
        guard armed else { return }
        lock.lock(); defer { lock.unlock() }
        guard !triggered else { return }
        triggered = true
        writeStatus("triggered")
        armed = false
        cleanupProtection()
        if sendLockShortcut() { writeStatus("lock_shortcut_sent") } else { writeStatus("error:lock_shortcut_not_sent") }
        if persistent {
            state = "standby"
            createStandbyWindows()
            writeStatus("standby_after_lock")
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { NSApp.terminate(nil) }
        }
    }

    private func accessibilityTrusted(prompt: Bool) -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    private func showPermissionWindow() {
        guard permissionWindow == nil else { return }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 260), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "MyTerminal Passive Lock"
        window.level = .floating
        window.isReleasedWhenClosed = false
        window.center()
        window.delegate = self
        let content = NSView(frame: window.contentView!.bounds)
        let title = NSTextField(labelWithString: "仅支持 macOS：需要“无障碍”权限")
        title.font = NSFont.systemFont(ofSize: 21, weight: .semibold)
        title.frame = NSRect(x: 30, y: 190, width: 500, height: 32)
        let detail = NSTextField(wrappingLabelWithString: "请在 系统设置 → 隐私与安全性 → 无障碍 中，为启动 MyTerminal 的终端应用（例如 Terminal、iTerm2 或其他宿主终端）开启权限。该权限用于监听输入并发送系统 Control–Command–Q 锁屏快捷键。授权前不会进入保护状态。")
        detail.font = NSFont.systemFont(ofSize: 14)
        detail.frame = NSRect(x: 30, y: 84, width: 500, height: 96)
        let settingsButton = NSButton(title: "打开无障碍设置", target: self, action: #selector(openAccessibilitySettings))
        settingsButton.frame = NSRect(x: 330, y: 28, width: 140, height: 34)
        let standbyButton = NSButton(title: "保持待机", target: self, action: #selector(permissionStandby))
        standbyButton.frame = NSRect(x: 478, y: 28, width: 72, height: 34)
        content.addSubview(title); content.addSubview(detail); content.addSubview(settingsButton); content.addSubview(standbyButton)
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        permissionWindow = window
        writeStatus("permission_window_visible")
    }

    @objc private func openAccessibilitySettings() {
        let urls = ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility"]
        for value in urls where NSWorkspace.shared.open(URL(string: value)!) { writeStatus("accessibility_settings_opened"); return }
    }

    @objc private func permissionStandby() { permissionWindow?.orderOut(nil); permissionWindow = nil; enterStandby(reason: "standby_waiting_permission") }
    func windowWillClose(_ notification: Notification) { permissionWindow = nil; if state == "waiting_permission" { enterStandby(reason: "standby_waiting_permission") } }

    private func createPowerAssertion() {
        let result = IOPMAssertionCreateWithName(kIOPMAssertionTypeNoDisplaySleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), "MyTerminal passive lock protection" as CFString, &assertionID)
        if result != kIOReturnSuccess { writeStatus("error:power_assertion") }
    }

    private func createProtectionWindows() {
        for screen in NSScreen.screens {
            let window = NSWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false, screen: screen)
            window.level = .screenSaver; window.backgroundColor = .clear; window.isOpaque = false; window.hasShadow = false
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            window.ignoresMouseEvents = false
            window.contentView = ProtectionView(frame: screen.frame, standby: false)
            window.makeKeyAndOrderFront(nil)
            windows.append(window)
        }
    }

    private func createStandbyWindows() {
        for screen in NSScreen.screens {
            let window = NSWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false, screen: screen)
            window.level = .floating
            window.backgroundColor = .clear
            window.isOpaque = false
            window.hasShadow = false
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            window.ignoresMouseEvents = true
            window.contentView = ProtectionView(frame: screen.frame, standby: true)
            window.orderFrontRegardless()
            windows.append(window)
        }
    }

    private func installEventMonitors() {
        let mask: NSEvent.EventTypeMask = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel]
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] _ in self?.handleInput(); return nil }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] _ in self?.handleInput() }
        if globalMonitor == nil { writeStatus("error:global_monitor_unavailable"); enterStandby(reason: "standby_monitor_error") }
    }

    private func sendLockShortcut() -> Bool {
        guard accessibilityTrusted(prompt: false), let source = CGEventSource(stateID: .hidSystemState) else { return false }
        let sequence: [(CGKeyCode, Bool, CGEventFlags)] = [(59, true, [.maskControl]), (55, true, [.maskControl, .maskCommand]), (12, true, [.maskControl, .maskCommand]), (12, false, [.maskControl, .maskCommand]), (55, false, [.maskControl]), (59, false, [])]
        for (keyCode, keyDown, flags) in sequence {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: keyDown) else { return false }
            event.flags = flags; event.post(tap: .cghidEventTap); usleep(45_000)
        }
        return true
    }

    private func cleanupProtection() {
        if let localMonitor { NSEvent.removeMonitor(localMonitor); self.localMonitor = nil }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor); self.globalMonitor = nil }
        for window in windows { window.orderOut(nil) }; windows.removeAll()
        if assertionID != 0 { IOPMAssertionRelease(assertionID); assertionID = 0 }
    }

    private func sessionEnded(statePath: String, sessionId: String) -> Bool {
        guard let data = FileManager.default.contents(atPath: statePath), let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let sessions = root["sessions"] as? [[String: Any]], let session = sessions.first(where: { $0["id"] as? String == sessionId }), let phase = session["phase"] as? String else { return false }
        return phase == "completed" || phase == "cancelled"
    }

    private func writeStatus(_ value: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(value)\n"
        guard let data = line.data(using: .utf8) else { return }
        if FileManager.default.fileExists(atPath: statusPath), let handle = FileHandle(forWritingAtPath: statusPath) {
            defer { try? handle.close() }; _ = try? handle.seekToEnd(); try? handle.write(contentsOf: data)
        } else { FileManager.default.createFile(atPath: statusPath, contents: data) }
    }
}

let args = CommandLine.arguments
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let service: PassiveLockService
if args.count == 4 && args[1] == "--service" {
    service = PassiveLockService(controlPath: args[2], statusPath: args[3])
} else if args.count == 4 {
    service = PassiveLockService(controlPath: nil, statusPath: args[3], legacyStatePath: args[1], legacySessionId: args[2])
} else {
    fputs("Usage: helper --service <control.json> <status.log> OR helper <state.json> <sessionId> <status.log>\n", stderr)
    exit(2)
}
app.delegate = service
app.run()
