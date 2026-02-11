//
//  MenuBarContentView.swift
//  PocketDexApp
//
//  Created by Codex on 06/02/2026.
//

import AppKit
import SwiftUI

struct MenuBarContentView: View {
    @ObservedObject var serverManager: ServerManager
    @ObservedObject var sparkleUpdater: SparkleUpdaterController
    @ObservedObject var codexAccountsManager: CodexAccountsManager
    @Environment(\.openWindow) private var openWindow
    @State private var isOpenWebHovered = false
    @State private var isCodexAccountsRowHovered = false
    @State private var isLogsRowHovered = false
    @State private var isCheckUpdatesHovered = false
    @State private var isQuitHovered = false
    @State private var hasOpenedCodexWindowForCurrentHover = false
    @State private var menuHostWindow: NSWindow?
    @State private var codexAutoHideTask: Task<Void, Never>?
    @State private var codexWindowRef: NSWindow?
    @State private var isOpeningCodexWindow = false
    @State private var codexWindowOpenTimestamp: Date?
    @State private var codexAutoHideGraceUntil = Date.distantPast

    private let codexWindowIdentifier = NSUserInterfaceItemIdentifier("PocketDex.CodexAccountsWindow")
    private let codexHoverOpenGraceSeconds: TimeInterval = 0
    private let codexAutoHidePollIntervalNanoseconds: UInt64 = 33_000_000

    private var serverBinding: Binding<Bool> {
        Binding(
            get: { serverManager.isRunning || serverManager.isBusy },
            set: { shouldRun in
                serverManager.toggleServer(shouldRun)
            }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: serverManager.statusSymbolName)
                    .foregroundStyle(statusColor)
                Text("PocketDex")
                    .font(.headline)
                Spacer()
            }

            Toggle("Run server", isOn: serverBinding)
                .toggleStyle(.switch)
                .disabled(serverManager.isBusy)

            if serverManager.isRunning {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Server address")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(serverManager.serverAddress)
                        .font(.caption.monospaced())
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            Button {
                serverManager.openWebUI()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "globe")
                    Text("Open Web UI")
                }
                .font(.subheadline.weight(.semibold))
                .frame(width: 210)
                .frame(minHeight: 36)
            }
            .buttonStyle(
                ActionCapsuleButtonStyle(
                    tint: Color.blue,
                    isEnabled: serverManager.isRunning,
                    isHovered: isOpenWebHovered
                )
            )
            .disabled(!serverManager.isRunning)
            .onHover { hovering in
                isOpenWebHovered = hovering
            }
            .frame(maxWidth: .infinity, alignment: .center)

            Divider()

            VStack(alignment: .leading, spacing: 0) {
                Button {
                    openCodexAccountsWindow()
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "person.3.fill")
                        Text("Codex Accounts")
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(isCodexAccountsRowHovered ? Color.primary.opacity(0.11) : Color.clear)
                    )
                }
                .buttonStyle(.plain)
                .onHover { hovering in
                    isCodexAccountsRowHovered = hovering
                    if hovering {
                        if !hasOpenedCodexWindowForCurrentHover {
                            hasOpenedCodexWindowForCurrentHover = true
                            openCodexAccountsWindow()
                        }
                    } else {
                        hasOpenedCodexWindowForCurrentHover = false
                    }
                }

                Button {
                    serverManager.openServerLogFile()
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "doc.text.magnifyingglass")
                        Text("Check server logs")
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(isLogsRowHovered ? Color.primary.opacity(0.11) : Color.clear)
                    )
                }
                .buttonStyle(.plain)
                .disabled(serverManager.persistentLogFilePath == nil)
                .onHover { hovering in
                    isLogsRowHovered = hovering
                }

                Button {
                    sparkleUpdater.checkForUpdates()
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.down.circle")
                        Text("Check for Updates...")
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(isCheckUpdatesHovered ? Color.primary.opacity(0.11) : Color.clear)
                    )
                }
                .buttonStyle(.plain)
                .disabled(!sparkleUpdater.isConfigured)
                .help(
                    sparkleUpdater.isConfigured
                        ? "Checks if a newer PocketDex build is available."
                        : "Configure SUFeedURL and SUPublicEDKey in Info.plist to enable Sparkle updates."
                )
                .onHover { hovering in
                    isCheckUpdatesHovered = hovering
                }

                Button {
                    NSApplication.shared.terminate(nil)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "power")
                        Text("Quit")
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(isQuitHovered ? Color.primary.opacity(0.11) : Color.clear)
                    )
                }
                .buttonStyle(.plain)
                .keyboardShortcut("q")
                .onHover { hovering in
                    isQuitHovered = hovering
                }
            }

            if let error = serverManager.lastErrorMessage, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }

        }
        .padding(12)
        .frame(width: 250)
        .background(
            MenuHostWindowReader { window in
                menuHostWindow = window
            }
        )
        .onAppear {
            serverManager.bootstrapIfNeeded()
        }
        .onDisappear {
            hasOpenedCodexWindowForCurrentHover = false
        }
    }

    private var statusColor: Color {
        switch serverManager.status {
        case .running:
            return .green
        case .starting, .stopping:
            return .orange
        case .failed:
            return .red
        case .stopped:
            return .secondary
        }
    }

    private func openCodexAccountsWindow() {
        let anchorFrame = menuHostWindow?.frame ?? NSApp.keyWindow?.frame ?? NSApp.mainWindow?.frame
        codexAutoHideGraceUntil = Date().addingTimeInterval(codexHoverOpenGraceSeconds)

        if positionCodexWindow(anchorFrame: anchorFrame) {
            codexWindowOpenTimestamp = Date()
            startCodexWindowAutoHideMonitor()
            return
        }

        guard !isOpeningCodexWindow else { return }
        isOpeningCodexWindow = true
        openWindow(id: "codex-accounts")
        Task { @MainActor in
            // Avoid "open then jump" flicker: position as soon as the window object exists.
            defer { isOpeningCodexWindow = false }
            for _ in 0..<150 {
                if positionCodexWindow(anchorFrame: anchorFrame) {
                    codexWindowOpenTimestamp = Date()
                    startCodexWindowAutoHideMonitor()
                    return
                }
                await Task.yield()
                try? await Task.sleep(nanoseconds: 4_000_000)
            }
        }
    }

    private func codexAccountsWindow() -> NSWindow? {
        if let codexWindowRef {
            return codexWindowRef
        }

        if let identified = NSApp.windows.first(where: { $0.identifier == codexWindowIdentifier }) {
            codexWindowRef = identified
            return identified
        }

        if let titled = NSApp.windows.first(where: { $0.title == "Codex Accounts" }) {
            titled.identifier = codexWindowIdentifier
            codexWindowRef = titled
            return titled
        }

        return nil
    }

    private func closeCodexAccountsWindow() {
        codexAutoHideTask?.cancel()
        codexAutoHideTask = nil
        codexAccountsWindow()?.orderOut(nil)
    }

    @MainActor
    private func positionCodexWindow(anchorFrame: NSRect?) -> Bool {
        guard let codexWindow = codexAccountsWindow() else {
            return false
        }
        codexWindowRef = codexWindow
        codexWindow.identifier = codexWindowIdentifier

        NSApp.activate(ignoringOtherApps: true)
        codexWindow.level = .statusBar
        codexWindow.collectionBehavior.insert(.moveToActiveSpace)
        codexWindow.collectionBehavior.insert(.fullScreenAuxiliary)

        let visibleFrame = (codexWindow.screen ?? NSScreen.main)?.visibleFrame
        guard let visibleFrame else { return false }

        let targetX: CGFloat
        let targetY: CGFloat
        if let anchorFrame {
            targetX = anchorFrame.minX - codexWindow.frame.width - 10
            targetY = anchorFrame.maxY - codexWindow.frame.height
        } else {
            let mouse = NSEvent.mouseLocation
            targetX = mouse.x - codexWindow.frame.width - 16
            targetY = mouse.y - codexWindow.frame.height + 18
        }

        let clampedX = max(visibleFrame.minX + 8, min(targetX, visibleFrame.maxX - codexWindow.frame.width - 8))
        let clampedY = max(visibleFrame.minY + 8, min(targetY, visibleFrame.maxY - codexWindow.frame.height - 8))

        codexWindow.alphaValue = 0
        codexWindow.setFrameOrigin(NSPoint(x: clampedX, y: clampedY))
        codexWindow.orderFrontRegardless()
        codexWindow.makeKeyAndOrderFront(nil)
        codexWindow.alphaValue = 1
        return true
    }

    private func startCodexWindowAutoHideMonitor() {
        codexAutoHideTask?.cancel()
        codexAutoHideTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: codexAutoHidePollIntervalNanoseconds)
                if Task.isCancelled { return }

                let shouldHide = await MainActor.run { shouldAutoHideCodexWindow() }
                if shouldHide {
                    await MainActor.run {
                        closeCodexAccountsWindow()
                        hasOpenedCodexWindowForCurrentHover = false
                    }
                    break
                }
            }
            await MainActor.run {
                codexAutoHideTask = nil
            }
        }
    }

    @MainActor
    private func shouldAutoHideCodexWindow() -> Bool {
        let now = Date()
        if now < codexAutoHideGraceUntil {
            return false
        }

        guard let codexWindow = codexAccountsWindow() else {
            if let openedAt = codexWindowOpenTimestamp {
                return now.timeIntervalSince(openedAt) > 1.0
            }
            return false
        }

        guard codexWindow.isVisible else {
            if let openedAt = codexWindowOpenTimestamp {
                return now.timeIntervalSince(openedAt) > 1.0
            }
            return true
        }

        let mouse = NSEvent.mouseLocation
        let codexHitFrame = codexWindow.frame.insetBy(dx: -8, dy: -8)
        let bridgeFrame = codexMenuBridgeFrame(codexFrame: codexWindow.frame, menuFrame: menuHostWindow?.frame)

        let isOverCodex = codexHitFrame.contains(mouse)
        let isOverBridge = bridgeFrame?.contains(mouse) ?? false
        let isClicking = NSEvent.pressedMouseButtons != 0
        if isClicking && (isOverCodex || isOverBridge || isCodexAccountsRowHovered) {
            return false
        }
        // Keep open only when hovering Codex Accounts row, the accounts window itself,
        // or the tiny bridge gap between both. If cursor is on other menu rows, hide.
        return !(isOverCodex || isOverBridge || isCodexAccountsRowHovered)
    }

    private func codexMenuBridgeFrame(codexFrame: NSRect, menuFrame: NSRect?) -> NSRect? {
        guard let menuFrame else { return nil }

        let left = min(codexFrame.maxX, menuFrame.minX)
        let right = max(codexFrame.maxX, menuFrame.minX)
        let width = right - left
        guard width > 0 else { return nil }

        let minY = min(codexFrame.minY, menuFrame.minY) - 8
        let maxY = max(codexFrame.maxY, menuFrame.maxY) + 8
        return NSRect(x: left - 4, y: minY, width: width + 8, height: maxY - minY)
    }
}

private struct MenuHostWindowReader: NSViewRepresentable {
    let onResolve: (NSWindow?) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        DispatchQueue.main.async {
            onResolve(view.window)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            onResolve(nsView.window)
        }
    }
}

private struct ActionCapsuleButtonStyle: ButtonStyle {
    let tint: Color
    let isEnabled: Bool
    let isHovered: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isEnabled ? Color.white : Color.white.opacity(0.75))
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: backgroundColors(isPressed: configuration.isPressed),
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(
                        Color.white.opacity(isEnabled ? (isHovered ? 0.28 : 0.14) : 0.08),
                        lineWidth: isHovered && isEnabled ? 1.4 : 1
                    )
            )
            .shadow(
                color: tint.opacity(isEnabled ? (isHovered ? 0.35 : 0.18) : 0),
                radius: isHovered ? 8 : 3,
                x: 0,
                y: isHovered ? 4 : 1
            )
            .opacity(isEnabled ? 1 : 0.62)
            .scaleEffect(configuration.isPressed && isEnabled ? 0.98 : (isHovered && isEnabled ? 1.01 : 1))
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
            .animation(.easeOut(duration: 0.16), value: isHovered)
    }

    private func backgroundColors(isPressed: Bool) -> [Color] {
        let base = isPressed ? tint.opacity(0.85) : tint
        if !isEnabled {
            return [Color.gray.opacity(0.38), Color.gray.opacity(0.28)]
        }
        return [base.opacity(0.95), base.opacity(0.65)]
    }
}

#Preview {
    MenuBarContentView(
        serverManager: ServerManager(autoStart: false),
        sparkleUpdater: SparkleUpdaterController(bundle: .main),
        codexAccountsManager: CodexAccountsManager()
    )
}
