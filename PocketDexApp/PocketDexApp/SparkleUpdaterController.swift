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
    private var isRunningManualProbe = false

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
                updaterDelegate: self,
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

        // Preserve default Sparkle behavior when a session is already active.
        guard updater.canCheckForUpdates else {
            updater.checkForUpdates()
            return
        }

        // Probe first so we can own the "up to date" dialog and button copy.
        isRunningManualProbe = true
        updater.checkForUpdateInformation()
    }

    private func presentNoUpdateAlert(reasonCode: Int, latestAppcastItem: SUAppcastItem?) {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")

        switch reasonCode {
        case 3:
            alert.messageText = "Your macOS version is too old"
            alert.informativeText = tooOldReasonText(for: latestAppcastItem)
            if let infoURL = latestAppcastItem?.infoURL {
                alert.addButton(withTitle: "Learn More…")
                let response = alert.runModal()
                if response == .alertSecondButtonReturn {
                    NSWorkspace.shared.open(infoURL)
                }
                return
            }
        case 4:
            alert.messageText = "Your macOS version is too new"
            alert.informativeText = tooNewReasonText(for: latestAppcastItem)
            if let infoURL = latestAppcastItem?.infoURL {
                alert.addButton(withTitle: "Learn More…")
                let response = alert.runModal()
                if response == .alertSecondButtonReturn {
                    NSWorkspace.shared.open(infoURL)
                }
                return
            }
        default:
            alert.messageText = "You're up to date!"
            alert.informativeText = upToDateText(for: latestAppcastItem)
            if let patchNotesURL = preferredPatchNotesURL(for: latestAppcastItem) {
                alert.addButton(withTitle: "Patch Notes")
                let response = alert.runModal()
                if response == .alertSecondButtonReturn {
                    NSWorkspace.shared.open(patchNotesURL)
                }
                return
            }
        }

        alert.runModal()
    }

    private func presentUpdateErrorAlert(_ error: NSError) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Unable to Check for Updates"

        let description = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let suggestion = (error.localizedRecoverySuggestion ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        if !description.isEmpty && !suggestion.isEmpty {
            alert.informativeText = "\(description)\n\n\(suggestion)"
        } else if !description.isEmpty {
            alert.informativeText = description
        } else if !suggestion.isEmpty {
            alert.informativeText = suggestion
        } else {
            alert.informativeText = "Please try again in a moment."
        }

        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func upToDateText(for latestAppcastItem: SUAppcastItem?) -> String {
        let appName = Self.nonEmptyInfoValue(forKey: "CFBundleDisplayName", in: .main)
            ?? Self.nonEmptyInfoValue(forKey: "CFBundleName", in: .main)
            ?? "PocketDex"

        let runningVersion = Self.nonEmptyInfoValue(forKey: "CFBundleShortVersionString", in: .main)
            ?? Self.nonEmptyInfoValue(forKey: "CFBundleVersion", in: .main)
            ?? "unknown"

        if let latestVersion = latestAppcastItem?.displayVersionString, !latestVersion.isEmpty, latestVersion != runningVersion {
            return "\(appName) \(latestVersion) is currently the newest version available.\n(You are currently running version \(runningVersion).)"
        }

        return "\(appName) \(runningVersion) is currently the newest version available."
    }

    private func tooOldReasonText(for latestAppcastItem: SUAppcastItem?) -> String {
        let appName = Self.nonEmptyInfoValue(forKey: "CFBundleDisplayName", in: .main)
            ?? Self.nonEmptyInfoValue(forKey: "CFBundleName", in: .main)
            ?? "PocketDex"

        let latestVersion = latestAppcastItem?.displayVersionString ?? "a newer version"
        if let minimumSystemVersion = latestAppcastItem?.minimumSystemVersion, !minimumSystemVersion.isEmpty {
            return "\(appName) \(latestVersion) is available but your macOS version is too old to install it. At least macOS \(minimumSystemVersion) is required."
        }
        return "\(appName) \(latestVersion) is available but your macOS version is too old to install it."
    }

    private func tooNewReasonText(for latestAppcastItem: SUAppcastItem?) -> String {
        let appName = Self.nonEmptyInfoValue(forKey: "CFBundleDisplayName", in: .main)
            ?? Self.nonEmptyInfoValue(forKey: "CFBundleName", in: .main)
            ?? "PocketDex"

        let latestVersion = latestAppcastItem?.displayVersionString ?? "a newer version"
        if let maximumSystemVersion = latestAppcastItem?.maximumSystemVersion, !maximumSystemVersion.isEmpty {
            return "\(appName) \(latestVersion) is available but your macOS version is too new for this update. This update only supports up to macOS \(maximumSystemVersion)."
        }
        return "\(appName) \(latestVersion) is available but your macOS version is too new for this update."
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

extension SparkleUpdaterController: SPUUpdaterDelegate {
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        guard isRunningManualProbe else {
            return
        }

        isRunningManualProbe = false
        updater.checkForUpdates()
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: any Error) {
        guard isRunningManualProbe else {
            return
        }

        isRunningManualProbe = false

        let nsError = error as NSError
        let latestAppcastItem = nsError.userInfo[SPULatestAppcastItemFoundKey] as? SUAppcastItem
        let reasonCode = (nsError.userInfo[SPUNoUpdateFoundReasonKey] as? NSNumber)?.intValue ?? 0

        presentNoUpdateAlert(reasonCode: reasonCode, latestAppcastItem: latestAppcastItem)
    }

    func updater(_ updater: SPUUpdater, didAbortWithError error: any Error) {
        guard isRunningManualProbe else {
            return
        }

        isRunningManualProbe = false
        presentUpdateErrorAlert(error as NSError)
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
