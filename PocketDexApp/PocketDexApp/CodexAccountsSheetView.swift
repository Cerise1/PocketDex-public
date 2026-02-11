//
//  CodexAccountsSheetView.swift
//  PocketDexApp
//
//  Created by Codex on 09/02/2026.
//

import AppKit
import SwiftUI

struct CodexAccountsSheetView: View {
    @ObservedObject var accountsManager: CodexAccountsManager
    @ObservedObject var serverManager: ServerManager

    @State private var switchingAccountID: UUID?
    @State private var expandedActionsAccountID: UUID?
    @State private var hoveredActionsAccountID: UUID?
    @State private var refreshingAccountIDs: Set<UUID> = []
    @State private var pendingSwitchAccount: CodexManagedAccount?
    @State private var showSwitchConfirmation = false
    @State private var bannerAutoDismissTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            messageBanner
            actionRow

            Divider()

            accountsSection
        }
        .padding(14)
        .frame(width: 620)
        .background(
            LinearGradient(
                colors: [
                    Color(nsColor: .windowBackgroundColor),
                    Color(nsColor: .windowBackgroundColor).opacity(0.96),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .background {
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture {
                    if expandedActionsAccountID != nil {
                        expandedActionsAccountID = nil
                    }
                }
        }
        .task {
            accountsManager.loadIfNeeded()
            Task {
                await accountsManager.refreshAccounts(fetchUsage: true, includeCurrentAuth: true, silent: false)
            }
        }
        .onDisappear {
            bannerAutoDismissTask?.cancel()
            bannerAutoDismissTask = nil
            expandedActionsAccountID = nil
            refreshingAccountIDs.removeAll()
            pendingSwitchAccount = nil
            showSwitchConfirmation = false
        }
        .onChange(of: accountsManager.infoMessage) {
            scheduleBannerAutoDismissIfNeeded()
        }
        .onChange(of: accountsManager.errorMessage) {
            scheduleBannerAutoDismissIfNeeded()
        }
        .alert(
            "Switch account and restart Codex Desktop?",
            isPresented: $showSwitchConfirmation,
            presenting: pendingSwitchAccount
        ) { account in
            Button("Cancel", role: .cancel) {
                pendingSwitchAccount = nil
            }
            Button("Confirm", role: .destructive) {
                pendingSwitchAccount = nil
                Task {
                    await performSwitch(to: account, forceRelaunchIfPossible: true)
                }
            }
        } message: { _ in
            Text(
                "Switching accounts requires restarting Codex Desktop and will stop all processes currently running in Codex Desktop. Do you want to continue?"
            )
        }
    }

    @ViewBuilder
    private var accountsSection: some View {
        if accountsManager.accounts.isEmpty {
            emptyState
        } else {
            ScrollView(.vertical, showsIndicators: true) {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(accountsManager.accounts) { account in
                        accountCard(account)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 4)
            }
            .frame(maxHeight: maxAccountsListHeight)
        }
    }

    private var maxAccountsListHeight: CGFloat {
        let visibleHeight = NSApp.keyWindow?.screen?.visibleFrame.height
            ?? NSScreen.main?.visibleFrame.height
            ?? 900
        return max(180, min(visibleHeight - 260, 560))
    }

    private var header: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Codex Accounts")
                    .font(.title3.weight(.semibold))
                Text("All accounts in one place, with instant switching.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var messageBanner: some View {
        if let error = accountsManager.errorMessage, !error.isEmpty {
            banner(text: error, tint: .red)
        } else if let info = accountsManager.infoMessage, !info.isEmpty {
            banner(text: info, tint: .green)
        }
    }

    private func banner(text: String, tint: Color) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(tint.opacity(0.12))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(tint.opacity(0.24), lineWidth: 1)
            )
    }

    private var actionRow: some View {
        HStack(spacing: 10) {
            Button {
                expandedActionsAccountID = nil
                Task {
                    await accountsManager.addAccountViaLogin()
                }
            } label: {
                Label("Add", systemImage: "plus.circle.fill")
            }
            .buttonStyle(CodexActionButtonStyle(tint: .blue, compact: true))

            Button {
                expandedActionsAccountID = nil
                Task {
                    await accountsManager.refreshAllUsage(silent: false)
                }
            } label: {
                Label("Refresh all", systemImage: "arrow.clockwise")
            }
            .buttonStyle(CodexActionButtonStyle(tint: .mint, compact: true))

            if accountsManager.isBusy {
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.small)
                    Text(accountsManager.busyStatusMessage ?? "Refreshing...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.leading, 4)
            }

            Spacer(minLength: 0)
        }
    }

    private enum BannerKind {
        case error
        case info
    }

    private func currentBannerMessage() -> (kind: BannerKind, text: String)? {
        if let error = accountsManager.errorMessage, !error.isEmpty {
            return (.error, error)
        }
        if let info = accountsManager.infoMessage, !info.isEmpty {
            return (.info, info)
        }
        return nil
    }

    private func scheduleBannerAutoDismissIfNeeded() {
        bannerAutoDismissTask?.cancel()
        guard let target = currentBannerMessage() else {
            bannerAutoDismissTask = nil
            return
        }

        bannerAutoDismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 7_000_000_000)
            guard !Task.isCancelled else { return }
            guard let current = currentBannerMessage(),
                  current.kind == target.kind,
                  current.text == target.text
            else {
                return
            }

            switch target.kind {
            case .error:
                accountsManager.errorMessage = nil
            case .info:
                accountsManager.infoMessage = nil
            }
            bannerAutoDismissTask = nil
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("No saved accounts yet")
                .font(.headline)
            Text("Click “Add account” and complete Codex login in your browser.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.gray.opacity(0.09))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.gray.opacity(0.15), lineWidth: 1)
        )
    }

    private func accountCard(_ account: CodexManagedAccount) -> some View {
        let isActive = accountsManager.activeAccountStableID == account.stableID
        let isSwitching = switchingAccountID == account.id
        let isActionsExpanded = expandedActionsAccountID == account.id
        let isActionsHovered = hoveredActionsAccountID == account.id
        let isRefreshingThisAccount = refreshingAccountIDs.contains(account.id)

        return AnyView(
            ZStack(alignment: .topTrailing) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 10) {
                    HStack(spacing: 8) {
                        Text(account.displayName)
                            .font(.headline)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .layoutPriority(1)

                        if let planType = account.planType?.trimmingCharacters(in: .whitespacesAndNewlines),
                           !planType.isEmpty
                        {
                            Text(planType.uppercased())
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(
                                    Capsule(style: .continuous)
                                        .fill(Color.primary.opacity(0.08))
                                )
                        }

                        Button {
                            withAnimation(.easeOut(duration: 0.14)) {
                                if isActionsExpanded {
                                    expandedActionsAccountID = nil
                                } else {
                                    expandedActionsAccountID = account.id
                                }
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(isActionsExpanded ? .primary : .secondary)
                                .frame(width: 40, height: 40)
                                .background(
                                    Circle()
                                        .fill((isActionsExpanded || isActionsHovered) ? Color.primary.opacity(0.18) : .clear)
                                )
                                .overlay(
                                    Circle()
                                        .strokeBorder(
                                            Color.white.opacity((isActionsExpanded || isActionsHovered) ? 0.22 : 0),
                                            lineWidth: 1
                                        )
                                )
                                .contentShape(Rectangle())
                                .animation(.easeOut(duration: 0.12), value: isActionsExpanded)
                                .animation(.easeOut(duration: 0.12), value: isActionsHovered)
                        }
                        .buttonStyle(.plain)
                        .contentShape(Rectangle())
                        .zIndex(isActionsExpanded ? 80_000 : 0)
                        .onHover { hovering in
                            if hovering {
                                hoveredActionsAccountID = account.id
                            } else if hoveredActionsAccountID == account.id {
                                hoveredActionsAccountID = nil
                            }
                        }
                        .overlay(alignment: .topTrailing) {
                            if isActionsExpanded {
                                accountActionsMenu(
                                    for: account,
                                    isActive: isActive,
                                    isRefreshing: isRefreshingThisAccount
                                )
                                .offset(y: 44)
                                .zIndex(90_000)
                                .transition(.scale(scale: 0.95, anchor: .topTrailing).combined(with: .opacity))
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    if isActive {
                        Text("Active")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.green)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(
                                Capsule(style: .continuous)
                                    .fill(Color.green.opacity(0.16))
                            )
                    } else {
                        Button {
                            handleSwitchTap(account)
                        } label: {
                            if isSwitching {
                                Label("Switching…", systemImage: "hourglass")
                            } else {
                                Label("Switch", systemImage: "person.crop.circle.badge.checkmark")
                            }
                        }
                        .buttonStyle(CodexActionButtonStyle(tint: .green, compact: true))
                        .disabled(isSwitching || !account.isSwitchable)
                    }
                }
                .zIndex(isActionsExpanded ? 2_000 : 0)

                HStack(spacing: 10) {
                    usageMeter(
                        title: preferredLabel(for: account.usageSnapshot?.primary, fallback: "5h"),
                        window: account.usageSnapshot?.primary,
                        tint: .blue
                    )
                    usageMeter(
                        title: preferredLabel(for: account.usageSnapshot?.secondary, fallback: "Weekly"),
                        window: account.usageSnapshot?.secondary,
                        tint: .teal
                    )
                }
                .allowsHitTesting(!isActionsExpanded)

                HStack(spacing: 8) {
                    if let credits = account.usageSnapshot?.credits {
                        Image(systemName: credits.unlimited ? "infinity.circle" : "creditcard")
                            .foregroundStyle(.secondary)
                        Text(creditsDescription(credits))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    if let freshness = freshnessDescription(for: account) {
                        HStack(spacing: 6) {
                            Text(freshness)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            if isRefreshingThisAccount {
                                ProgressView()
                                    .controlSize(.mini)
                            }
                        }
                    }
                }

                if let error = account.lastError, !error.isEmpty {
                    Text(error)
                        .font(.caption2)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.04),
                                Color.white.opacity(0.015),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(isActive ? Color.green.opacity(0.45) : Color.white.opacity(0.13), lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .onTapGesture {
                if expandedActionsAccountID != nil {
                    expandedActionsAccountID = nil
                }
            }

            }
            .zIndex(isActionsExpanded ? 60_000 : 0)
        )
    }

    private func accountActionsMenu(
        for account: CodexManagedAccount,
        isActive: Bool,
        isRefreshing: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ActionMenuItemButton(
                title: "Refresh",
                systemImage: "arrow.clockwise",
                isLoading: false,
                isDestructive: false
            ) {
                guard !isRefreshing else { return }
                expandedActionsAccountID = nil
                Task {
                    refreshingAccountIDs.insert(account.id)
                    defer { refreshingAccountIDs.remove(account.id) }
                    await accountsManager.refreshAccount(account.id)
                }
            }
            .disabled(isRefreshing)
            .opacity(isRefreshing ? 0.55 : 1)

            ActionMenuItemButton(
                title: "Remove",
                systemImage: "trash",
                isLoading: false,
                isDestructive: true
            ) {
                expandedActionsAccountID = nil
                confirmRemove(account)
            }
            .disabled(isActive)
            .opacity(isActive ? 0.45 : 1)
        }
        .padding(8)
        .frame(width: 154)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(nsColor: .windowBackgroundColor).opacity(0.98))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.14), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.18), radius: 10, x: 0, y: 6)
    }

    private func usageMeter(title: String, window: CodexRateLimitWindow?, tint: Color) -> some View {
        let remainingPercent = window.map { max(0, min(100 - $0.usedPercent, 100)) } ?? 0
        let fillRatio = remainingPercent / 100
        let percentLabel = window == nil ? "--" : String(format: "%.0f%% left", remainingPercent)

        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Text(percentLabel)
                    .font(.caption.monospacedDigit())
            }

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule(style: .continuous)
                        .fill(Color.primary.opacity(0.1))
                    Capsule(style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [tint.opacity(0.95), tint.opacity(0.55)],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: max(4, geometry.size.width * fillRatio))
                }
            }
            .frame(height: 9)

            VStack(alignment: .leading, spacing: 2) {
                Text(window.flatMap { window in
                    guard let resetAt = window.resetAt else { return nil }
                    return "Reset in \(formattedRemainingTime(until: resetAt))"
                } ?? "No data yet")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.primary.opacity(0.04))
        )
    }

    private func preferredLabel(for window: CodexRateLimitWindow?, fallback: String) -> String {
        guard let minutes = window?.windowMinutes else {
            return fallback
        }
        if minutes == 300 {
            return "5h"
        }
        if minutes == 10_080 {
            return "Weekly"
        }
        if minutes % 60 == 0 {
            return "\(minutes / 60)h"
        }
        return "\(minutes)m"
    }

    private func creditsDescription(_ credits: CodexCreditsSnapshot) -> String {
        if credits.unlimited {
            return "Unlimited credits"
        }
        if let balance = credits.balance, !balance.isEmpty {
            return "Credits balance: \(balance)"
        }
        return credits.hasCredits ? "Credits available" : "No credits available"
    }

    private func formattedRelativeDate(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private func freshnessDescription(for account: CodexManagedAccount) -> String? {
        guard let fetchedAt = account.usageFetchedAt else {
            return nil
        }
        return "Last updated \(formattedRelativeDate(fetchedAt))"
    }

    private func formattedRemainingTime(until date: Date) -> String {
        let seconds = max(0, Int(date.timeIntervalSinceNow))
        if seconds == 0 { return "soon" }

        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3_600
        let minutes = (seconds % 3_600) / 60

        if days > 0 {
            return "\(days)d \(hours)h \(minutes)m"
        }
        if hours > 0 {
            return "\(hours)h \(minutes)m"
        }
        return "\(minutes)m"
    }

    private func relaunchCodexIfSafe() async {
        guard serverManager.isRunning else { return }
        let safety = await serverManager.checkCodexRelaunchSafety()
        switch safety {
        case .safe:
            await serverManager.relaunchCodex(forceWhenActiveRuns: false)
        case .requiresConfirmation(let reason):
            accountsManager.infoMessage = "Account switched. \(reason)"
        case .unavailable:
            break
        }
    }

    private func relaunchCodexAfterConfirmedSwitch() async {
        guard serverManager.isRunning else {
            accountsManager.infoMessage = "Account switched. Start the PocketDex server to restart Codex Desktop automatically."
            return
        }
        await serverManager.relaunchCodex(forceWhenActiveRuns: true)
    }

    private func handleSwitchTap(_ account: CodexManagedAccount) {
        expandedActionsAccountID = nil
        if serverManager.isCodexDesktopAppRunning() {
            pendingSwitchAccount = account
            showSwitchConfirmation = true
            return
        }
        Task {
            await performSwitch(to: account, forceRelaunchIfPossible: false)
        }
    }

    private func performSwitch(to account: CodexManagedAccount, forceRelaunchIfPossible: Bool) async {
        switchingAccountID = account.id
        let switched = await accountsManager.switchToAccount(account.id)
        if switched {
            if forceRelaunchIfPossible {
                await relaunchCodexAfterConfirmedSwitch()
            } else {
                await relaunchCodexIfSafe()
            }
        }
        switchingAccountID = nil
    }

    private func confirmRemove(_ account: CodexManagedAccount) {
        let alert = NSAlert()
        alert.messageText = "Delete this account from PocketDex?"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Delete")

        let response = alert.runModal()
        if response == .alertSecondButtonReturn {
            _ = accountsManager.removeAccount(account.id)
        }
    }

}

private struct ActionMenuItemButton: View {
    let title: String
    let systemImage: String
    let isLoading: Bool
    let isDestructive: Bool
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    Image(systemName: systemImage)
                }
                Text(title)
                    .font(.caption.weight(.semibold))
                Spacer(minLength: 0)
            }
            .foregroundStyle(isDestructive ? Color.red.opacity(0.95) : Color.primary)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(backgroundColor)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(borderColor, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .onHover { hovering in
            isHovered = hovering
        }
    }

    private var backgroundColor: Color {
        if isDestructive {
            return isHovered ? Color.red.opacity(0.2) : Color.red.opacity(0.12)
        }
        return isHovered ? Color.primary.opacity(0.14) : Color.primary.opacity(0.08)
    }

    private var borderColor: Color {
        if isDestructive {
            return isHovered ? Color.red.opacity(0.35) : Color.red.opacity(0.22)
        }
        return isHovered ? Color.primary.opacity(0.24) : Color.primary.opacity(0.14)
    }
}

private struct CodexActionButtonStyle: ButtonStyle {
    let tint: Color
    let compact: Bool

    init(tint: Color, compact: Bool = false) {
        self.tint = tint
        self.compact = compact
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .caption.weight(.semibold) : .subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, compact ? 10 : 12)
            .padding(.vertical, compact ? 6 : 7)
            .background(
                RoundedRectangle(cornerRadius: compact ? 8 : 10, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                tint.opacity(configuration.isPressed ? 0.82 : 0.98),
                                tint.opacity(configuration.isPressed ? 0.58 : 0.72),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: compact ? 8 : 10, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.18), lineWidth: 1)
            )
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

#Preview {
    CodexAccountsSheetView(
        accountsManager: CodexAccountsManager(),
        serverManager: ServerManager(autoStart: false)
    )
}
