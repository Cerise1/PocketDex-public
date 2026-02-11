//
//  SparkleUpdaterController.swift
//  PocketDexApp
//
//  Created by Codex on 08/02/2026.
//

import Foundation
import Combine
import AppKit
import Sparkle

@MainActor
final class SparkleUpdaterController: NSObject, ObservableObject {
    @Published private(set) var isConfigured: Bool

    private var updaterController: SPUStandardUpdaterController?
    private let fallbackPatchNotesURL: URL?

    init(bundle: Bundle = .main) {
        let feedURL = Self.nonEmptyInfoValue(forKey: "SUFeedURL", in: bundle)
        let publicKey = Self.nonEmptyInfoValue(forKey: "SUPublicEDKey", in: bundle)
        let configured = (feedURL != nil) && (publicKey != nil)

        isConfigured = configured
        fallbackPatchNotesURL = Self.defaultPatchNotesURL(in: bundle, feedURL: feedURL)

        super.init()

        updaterController = configured
            ? SPUStandardUpdaterController(
                startingUpdater: true,
                updaterDelegate: nil,
                userDriverDelegate: self
            )
            : nil
    }

    var canCheckForUpdates: Bool {
        updaterController?.updater.canCheckForUpdates ?? false
    }

    func checkForUpdates() {
        guard let updater = updaterController?.updater else {
            return
        }

        // Sparkle's canCheckForUpdates is for menu validation and does not always
        // reflect an in-flight session. Guard sessionInProgress first.
        if updater.sessionInProgress || !updater.canCheckForUpdates {
            presentCheckInProgressAlert()
            return
        }

        NSApp.activate(ignoringOtherApps: true)
        updater.checkForUpdates()
    }

    private func presentCheckInProgressAlert() {
        NSApp.activate(ignoringOtherApps: true)

        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Update check already in progress"
        alert.informativeText = "PocketDex is already checking for updates. Please wait a moment and try again."
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func preferredPatchNotesURL(for appcastItem: SUAppcastItem?) -> URL? {
        if let appcastItem {
            if let fullReleaseNotesURL = appcastItem.fullReleaseNotesURL {
                return Self.githubReleaseTagURL(fromAssetURL: fullReleaseNotesURL)
                    ?? Self.githubReleasesURL(fromGitHubURL: fullReleaseNotesURL)
                    ?? fullReleaseNotesURL
            }

            if let releaseNotesURL = appcastItem.releaseNotesURL {
                return Self.githubReleaseTagURL(fromAssetURL: releaseNotesURL)
                    ?? Self.githubReleasesURL(fromGitHubURL: releaseNotesURL)
                    ?? releaseNotesURL
            }

            if let infoURL = appcastItem.infoURL {
                return Self.githubReleasesURL(fromGitHubURL: infoURL) ?? infoURL
            }
        }

        return fallbackPatchNotesURL
    }

    private static func defaultPatchNotesURL(in bundle: Bundle, feedURL: String?) -> URL? {
        if
            let configuredPatchNotesURL = nonEmptyInfoValue(forKey: "SUPatchNotesURL", in: bundle),
            let patchNotesURL = URL(string: configuredPatchNotesURL)
        {
            return patchNotesURL
        }

        guard let feedURL, let parsedFeedURL = URL(string: feedURL) else {
            return nil
        }

        return githubReleasesURL(fromGitHubURL: parsedFeedURL)
    }

    private static func githubReleasesURL(fromGitHubURL url: URL) -> URL? {
        guard (url.host ?? "").caseInsensitiveCompare("github.com") == .orderedSame else {
            return nil
        }

        let pathComponents = url.path.split(separator: "/")
        guard pathComponents.count >= 2 else {
            return nil
        }

        let owner = pathComponents[0]
        let repo = pathComponents[1]
        return URL(string: "https://github.com/\(owner)/\(repo)/releases")
    }

    private static func githubReleaseTagURL(fromAssetURL url: URL) -> URL? {
        guard (url.host ?? "").caseInsensitiveCompare("github.com") == .orderedSame else {
            return nil
        }

        let pathComponents = url.path.split(separator: "/")
        guard pathComponents.count >= 6 else {
            return nil
        }

        guard pathComponents[2] == "releases", pathComponents[3] == "download" else {
            return nil
        }

        let owner = pathComponents[0]
        let repo = pathComponents[1]
        let tag = pathComponents[4]
        return URL(string: "https://github.com/\(owner)/\(repo)/releases/tag/\(tag)")
    }

    private static func nonEmptyInfoValue(forKey key: String, in bundle: Bundle) -> String? {
        guard let value = bundle.object(forInfoDictionaryKey: key) as? String else {
            return nil
        }

        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

extension SparkleUpdaterController: SPUStandardUserDriverDelegate {
    func standardUserDriverShouldShowVersionHistory(for item: SUAppcastItem) -> Bool {
        preferredPatchNotesURL(for: item) != nil
    }

    func standardUserDriverShowVersionHistory(for item: SUAppcastItem) {
        guard let patchNotesURL = preferredPatchNotesURL(for: item) else {
            return
        }

        NSWorkspace.shared.open(patchNotesURL)
    }
}
