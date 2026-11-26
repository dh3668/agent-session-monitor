import Foundation
import AppKit
import UserNotifications

// Native macOS UNUserNotificationCenter helper for Agent Session Monitor.
// Supports CLI modes (--send, --clear, --status) via stdin JSON and handles cold-launch
// notification click activation to jump directly to the exact VS Code project window.

private let allowedUriSchemes: Set<String> = [
    "vscode",
    "vscode-insiders",
    "cursor",
    "antigravity",
    "vscodium",
]

private struct EditorTarget {
    let bundleId: String
    let appPath: String
    let cliPaths: [String]
}

private let knownEditors: [String: EditorTarget] = [
    "visual studio code": EditorTarget(
        bundleId: "com.microsoft.VSCode",
        appPath: "/Applications/Visual Studio Code.app",
        cliPaths: [
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            "/opt/homebrew/bin/code",
            "/usr/local/bin/code",
        ]
    ),
    "visual studio code - insiders": EditorTarget(
        bundleId: "com.microsoft.VSCodeInsiders",
        appPath: "/Applications/Visual Studio Code - Insiders.app",
        cliPaths: [
            "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
            "/opt/homebrew/bin/code-insiders",
            "/usr/local/bin/code-insiders",
        ]
    ),
    "cursor": EditorTarget(
        bundleId: "com.todesktop.230313mzl4w4u92",
        appPath: "/Applications/Cursor.app",
        cliPaths: [
            "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
            "/opt/homebrew/bin/cursor",
            "/usr/local/bin/cursor",
        ]
    ),
    "antigravity": EditorTarget(
        bundleId: "com.google.antigravity",
        appPath: "/Applications/Antigravity.app",
        cliPaths: [
            "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity",
            "/opt/homebrew/bin/antigravity",
            "/usr/local/bin/antigravity",
        ]
    ),
    "vscodium": EditorTarget(
        bundleId: "com.vscodium",
        appPath: "/Applications/VSCodium.app",
        cliPaths: [
            "/Applications/VSCodium.app/Contents/Resources/app/bin/codium",
            "/opt/homebrew/bin/codium",
            "/usr/local/bin/codium",
        ]
    ),
]

private struct SendPayload: Decodable {
    let id: String?
    let group: String?
    let title: String?
    let subtitle: String?
    let body: String?
    let logoPath: String?
    let openUri: String?
    let workspaceRoot: String?
    let appName: String?
    let interruptionLevel: String?
    let sound: Bool?
}

private struct ClearPayload: Decodable {
    let ids: [String]?
    let group: String?
    let groups: [String]?
    let all: Bool?
}

private func writeJSONAndExit(_ dict: [String: Any], code: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        fputs(text + "\n", stdout)
    } else {
        fputs("{\"ok\":false,\"error\":\"serialization_failed\"}\n", stdout)
    }
    fflush(stdout)
    exit(code)
}

private func permissionName(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .notDetermined: return "notDetermined"
    case .provisional: return "provisional"
    @unknown default: return "unknown"
    }
}

private func settingName(_ setting: UNNotificationSetting) -> String {
    switch setting {
    case .enabled: return "enabled"
    case .disabled: return "disabled"
    case .notSupported: return "notSupported"
    @unknown default: return "unknown"
    }
}

private func validatedEditorURL(_ raw: String?) -> URL? {
    guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
          !raw.isEmpty,
          raw.count <= 2048,
          !raw.contains("\0"),
          let url = URL(string: raw),
          let scheme = url.scheme?.lowercased(),
          allowedUriSchemes.contains(scheme),
          let host = url.host,
          !host.isEmpty else {
        return nil
    }
    return url
}

private func validatedDirectoryPath(_ raw: String?) -> String? {
    guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
          raw.hasPrefix("/"),
          raw.count <= 4096,
          !raw.contains("\0") else {
        return nil
    }
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: raw, isDirectory: &isDir), isDir.boolValue else {
        return nil
    }
    return raw
}

private func sweepStaleLogoTempFiles() {
    let fm = FileManager.default
    let tempDir = fm.temporaryDirectory
    guard let entries = try? fm.contentsOfDirectory(
        at: tempDir,
        includingPropertiesForKeys: [.contentModificationDateKey],
        options: [.skipsSubdirectoryDescendants]
    ) else {
        return
    }
    let cutoff = Date().addingTimeInterval(-3600)
    for url in entries where url.lastPathComponent.hasPrefix("asm-logo-") {
        if let values = try? url.resourceValues(forKeys: [.contentModificationDateKey]),
           let modified = values.contentModificationDate,
           modified < cutoff {
            try? fm.removeItem(at: url)
        }
    }
}

private func createLogoAttachment(from logoPath: String?) -> (UNNotificationAttachment, URL)? {
    guard let raw = logoPath?.trimmingCharacters(in: .whitespacesAndNewlines),
          raw.hasPrefix("/"),
          !raw.contains("\0") else {
        return nil
    }
    let sourceURL = URL(fileURLWithPath: raw)
    let ext = sourceURL.pathExtension.lowercased()
    guard ["png", "jpg", "jpeg"].contains(ext) else {
        return nil
    }
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: sourceURL.path, isDirectory: &isDir), !isDir.boolValue else {
        return nil
    }
    // UNNotificationAttachment moves the provided file into the system notification store,
    // so always copy to a unique temporary file first.
    let tempURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("asm-logo-\(UUID().uuidString).\(ext)")
    do {
        try FileManager.default.copyItem(at: sourceURL, to: tempURL)
        let attachment = try UNNotificationAttachment(
            identifier: "logo",
            url: tempURL,
            options: [UNNotificationAttachmentOptionsThumbnailHiddenKey: false]
        )
        return (attachment, tempURL)
    } catch {
        try? FileManager.default.removeItem(at: tempURL)
        return nil
    }
}

private func resolveEditorTarget(appName: String?) -> EditorTarget {
    if let name = appName?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !name.isEmpty {
        if let target = knownEditors[name] {
            return target
        }
        if name.contains("antigravity") { return knownEditors["antigravity"]! }
        if name.contains("cursor") { return knownEditors["cursor"]! }
        if name.contains("vscodium") { return knownEditors["vscodium"]! }
        if name.contains("insiders") { return knownEditors["visual studio code - insiders"]! }
    }
    return knownEditors["visual studio code"]!
}

// The editor's CLI without a window flag focuses a window that already has the folder
// open and otherwise opens it in a new one; it never replaces the current window's folder.
// `completion` runs on the main queue once the editor has been handed the folder.
private func openWorkspaceFolder(_ folderPath: String, appName: String?, completion: @escaping () -> Void) {
    let target = resolveEditorTarget(appName: appName)
    let fm = FileManager.default

    for cli in target.cliPaths where fm.isExecutableFile(atPath: cli) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: cli)
        proc.arguments = [folderPath]
        proc.standardInput = nil
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        proc.terminationHandler = { _ in DispatchQueue.main.async { completion() } }
        if (try? proc.run()) != nil {
            return
        }
    }

    let folderURL = URL(fileURLWithPath: folderPath, isDirectory: true)
    let workspace = NSWorkspace.shared
    let appURL = workspace.urlForApplication(withBundleIdentifier: target.bundleId)
        ?? (fm.fileExists(atPath: target.appPath) ? URL(fileURLWithPath: target.appPath) : nil)
    guard let appURL = appURL else {
        completion()
        return
    }
    let config = NSWorkspace.OpenConfiguration()
    config.activates = true
    workspace.open([folderURL], withApplicationAt: appURL, configuration: config) { _, _ in
        DispatchQueue.main.async { completion() }
    }
}

// Hands the click to the exact editor window (its app link), or opens the folder when the
// link cannot be opened. `completion` runs on the main queue once the hand-off finished.
private func activateNotificationTarget(userInfo: [AnyHashable: Any], completion: @escaping () -> Void) {
    let openUri = userInfo["openUri"] as? String
    let workspaceRoot = userInfo["workspaceRoot"] as? String
    let appName = userInfo["appName"] as? String

    let openFolder: () -> Void = {
        if let folder = validatedDirectoryPath(workspaceRoot) {
            openWorkspaceFolder(folder, appName: appName, completion: completion)
        } else {
            completion()
        }
    }
    guard let uri = validatedEditorURL(openUri) else {
        openFolder()
        return
    }
    let config = NSWorkspace.OpenConfiguration()
    config.activates = true
    NSWorkspace.shared.open(uri, configuration: config) { _, error in
        DispatchQueue.main.async {
            if error == nil {
                completion()
            } else {
                openFolder()
            }
        }
    }
}

private enum Mode {
    case send
    case clear
    case status
    case activateOnly
}

private final class NotifierAppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let mode: Mode
    private var handledClick = false
    private var hasBundle: Bool { Bundle.main.bundleIdentifier != nil }

    init(arguments: [String]) {
        let flags = Set(arguments.dropFirst())
        if flags.contains("--send") {
            self.mode = .send
        } else if flags.contains("--clear") {
            self.mode = .clear
        } else if flags.contains("--status") {
            self.mode = .status
        } else {
            self.mode = .activateOnly
        }
        super.init()
    }

    // Apple docs require setting UNUserNotificationCenter.delegate in willFinishLaunching
    // so cold-launched notification clicks reliably deliver didReceive.
    func applicationWillFinishLaunching(_ notification: Notification) {
        if hasBundle {
            UNUserNotificationCenter.current().delegate = self
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard hasBundle else {
            if mode == .activateOnly {
                NSApp.terminate(nil)
                return
            }
            writeJSONAndExit([
                "ok": false,
                "permission": "unavailable",
                "error": "AgentSessionNotifier must run from inside AgentSessionNotifier.app",
            ])
        }

        switch mode {
        case .status:
            handleStatus()
        case .send:
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let data = FileHandle.standardInput.readDataToEndOfFile()
                DispatchQueue.main.async {
                    self?.handleSend(stdinData: data)
                }
            }
        case .clear:
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let data = FileHandle.standardInput.readDataToEndOfFile()
                DispatchQueue.main.async {
                    self?.handleClear(stdinData: data)
                }
            }
        case .activateOnly:
            // Safety exit if launched without flags and no notification response arrives.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
                if self?.handledClick == false {
                    NSApp.terminate(nil)
                }
            }
        }
    }

    private func handleStatus() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            writeJSONAndExit([
                "ok": true,
                "permission": permissionName(settings.authorizationStatus),
                "alertSetting": settingName(settings.alertSetting),
                "soundSetting": settingName(settings.soundSetting),
                "notificationCenterSetting": settingName(settings.notificationCenterSetting),
            ])
        }
    }

    private func handleSend(stdinData: Data) {
        guard !stdinData.isEmpty,
              let payload = try? JSONDecoder().decode(SendPayload.self, from: stdinData) else {
            writeJSONAndExit(["ok": false, "permission": "unknown", "error": "invalid_payload"])
        }

        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            let currentPerm = permissionName(settings.authorizationStatus)
            // Allowed, but with banners turned off the notification only reaches Notification
            // Center. It is still posted; the caller is told why no banner appeared.
            var extra: [String: Any] = [:]
            if settings.alertSetting == .disabled {
                extra["alertSetting"] = settingName(settings.alertSetting)
            }
            switch settings.authorizationStatus {
            case .denied:
                writeJSONAndExit(["ok": false, "permission": "denied"])
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
                    guard granted else {
                        var out: [String: Any] = ["ok": false, "permission": "denied"]
                        if let error = error { out["error"] = error.localizedDescription }
                        writeJSONAndExit(out)
                    }
                    self.postNotification(center: center, payload: payload, permission: "granted")
                }
            case .authorized, .provisional:
                self.postNotification(center: center, payload: payload, permission: currentPerm, extra: extra)
            @unknown default:
                self.postNotification(center: center, payload: payload, permission: currentPerm, extra: extra)
            }
        }
    }

    private func postNotification(center: UNUserNotificationCenter, payload: SendPayload, permission: String,
                                  extra: [String: Any] = [:]) {
        sweepStaleLogoTempFiles()

        let content = UNMutableNotificationContent()
        let title = (payload.title ?? "").trimmingCharacters(in: .newlines)
        content.title = title.isEmpty ? "에이전트 세션 모니터" : title
        content.subtitle = (payload.subtitle ?? "").trimmingCharacters(in: .newlines)
        content.body = payload.body ?? ""
        if let group = payload.group, !group.isEmpty {
            content.threadIdentifier = group
        }
        if payload.sound ?? true {
            content.sound = .default
        }
        switch payload.interruptionLevel {
        case "timeSensitive":
            content.interruptionLevel = .timeSensitive
        case "passive":
            content.interruptionLevel = .passive
        default:
            content.interruptionLevel = .active
        }

        var info: [String: String] = [:]
        if let uri = validatedEditorURL(payload.openUri) {
            info["openUri"] = uri.absoluteString
        }
        if let root = validatedDirectoryPath(payload.workspaceRoot) {
            info["workspaceRoot"] = root
        }
        if let appName = payload.appName?.trimmingCharacters(in: .whitespacesAndNewlines), !appName.isEmpty {
            info["appName"] = appName
        }
        content.userInfo = info

        var tempAttachmentURL: URL?
        if let (attachment, tempURL) = createLogoAttachment(from: payload.logoPath) {
            content.attachments = [attachment]
            tempAttachmentURL = tempURL
        }

        let identifier = (payload.id?.isEmpty == false) ? payload.id! : UUID().uuidString
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        center.add(request) { error in
            if let tempURL = tempAttachmentURL, FileManager.default.fileExists(atPath: tempURL.path) {
                try? FileManager.default.removeItem(at: tempURL)
            }
            var out: [String: Any] = ["permission": permission]
            out.merge(extra) { current, _ in current }
            if let error = error {
                out["ok"] = false
                out["error"] = error.localizedDescription
                writeJSONAndExit(out)
            }
            out["ok"] = true
            out["id"] = identifier
            writeJSONAndExit(out)
        }
    }

    private func handleClear(stdinData: Data) {
        let payload = (try? JSONDecoder().decode(ClearPayload.self, from: stdinData))
            ?? ClearPayload(ids: nil, group: nil, groups: nil, all: nil)
        let center = UNUserNotificationCenter.current()

        if payload.all == true {
            center.removeAllDeliveredNotifications()
            center.getDeliveredNotifications { _ in
                writeJSONAndExit(["ok": true])
            }
            return
        }

        var explicitIds = (payload.ids ?? []).filter { !$0.isEmpty }
        if !explicitIds.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: explicitIds)
        }

        var groups = Set((payload.groups ?? []).filter { !$0.isEmpty })
        if let group = payload.group, !group.isEmpty {
            groups.insert(group)
        }
        if !groups.isEmpty {
            center.getDeliveredNotifications { delivered in
                let matched = delivered
                    .filter { groups.contains($0.request.content.threadIdentifier) }
                    .map { $0.request.identifier }
                if matched.isEmpty && explicitIds.isEmpty {
                    writeJSONAndExit(["ok": true])
                }
                if !matched.isEmpty {
                    center.removeDeliveredNotifications(withIdentifiers: matched)
                    explicitIds.append(contentsOf: matched)
                }
                // Flush barrier on UNUserNotificationCenter XPC queue before exiting.
                center.getDeliveredNotifications { _ in
                    writeJSONAndExit(["ok": true, "cleared": explicitIds.count])
                }
            }
            return
        }

        if explicitIds.isEmpty {
            writeJSONAndExit(["ok": true])
        }

        center.getDeliveredNotifications { _ in
            writeJSONAndExit(["ok": true, "cleared": explicitIds.count])
        }
    }

    // Show banners even if the helper happens to be active when delivering.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    // Fired when the user clicks a delivered notification (both warm and cold launch).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        handledClick = true
        // Quit once the editor has been handed the click, or after a safety interval if
        // the hand-off never reports back; never while it may still be in flight.
        var finished = false
        let finish: () -> Void = {
            if finished { return }
            finished = true
            NSApp.terminate(nil)
        }
        if response.actionIdentifier != UNNotificationDismissActionIdentifier {
            activateNotificationTarget(userInfo: response.notification.request.content.userInfo) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { finish() }
            }
        } else {
            DispatchQueue.main.async { finish() }
        }
        completionHandler()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { finish() }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
private let delegate = NotifierAppDelegate(arguments: CommandLine.arguments)
app.delegate = delegate
app.run()
