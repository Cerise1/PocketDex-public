//
//  CodexAccountsManager.swift
//  PocketDexApp
//
//  Created by Codex on 09/02/2026.
//

import Combine
import CryptoKit
import Foundation

@MainActor
final class CodexAccountsManager: ObservableObject {
    @Published private(set) var accounts: [CodexManagedAccount] = []
    @Published private(set) var activeAccountStableID: String?
    @Published private(set) var isBusy = false
    @Published private(set) var busyStatusMessage: String?
    @Published private(set) var lastUpdatedAt: Date?
    @Published var infoMessage: String?
    @Published var errorMessage: String?

    private let fileManager: FileManager
    private let codexHomeURL: URL
    private let authFileURL: URL
    private let configFileURL: URL
    private let accountsFileURL: URL
    private let debugLogURL: URL
    private var hasLoadedOnce = false
    private var backgroundRefreshTask: Task<Void, Never>?
    private let backgroundActiveRefreshInterval: TimeInterval = 180
    private let backgroundInactiveRefreshInterval: TimeInterval = 3_600
    private var accountsCommitRevision: UInt64 = 0

    private enum AccountsCommitStrategy: String {
        case mergeWithLatest
        case replace
    }

    init(
        fileManager: FileManager = .default,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.fileManager = fileManager

        let codexHomePath = environment["CODEX_HOME"] ?? "~/.codex"
        let expanded = NSString(string: codexHomePath).expandingTildeInPath
        codexHomeURL = URL(fileURLWithPath: expanded, isDirectory: true)

        authFileURL = codexHomeURL.appendingPathComponent("auth.json")
        configFileURL = codexHomeURL.appendingPathComponent("config.toml")

        let pocketDexRoot = codexHomeURL.appendingPathComponent("pocketdex", isDirectory: true)
        accountsFileURL = pocketDexRoot.appendingPathComponent("accounts.json")
        debugLogURL = pocketDexRoot.appendingPathComponent("accounts-debug.log")

        startBackgroundAutoRefresh()
    }

    var debugLogFilePath: String {
        debugLogURL.path
    }

    deinit {
        backgroundRefreshTask?.cancel()
    }

    func loadIfNeeded() {
        guard !hasLoadedOnce else { return }
        hasLoadedOnce = true
        var storedAccounts = loadStoredAccounts()
        let currentFileAccount = loadCurrentAccountFromAuthFile()
        if let currentFileAccount {
            storedAccounts = upsert(currentFileAccount, into: storedAccounts)
        }

        storedAccounts = deduplicated(storedAccounts)
        _ = commitAccounts(
            storedAccounts,
            strategy: .mergeWithLatest,
            preferredActiveStableID: currentFileAccount?.stableID
        )
    }

    func startBackgroundAutoRefresh() {
        guard backgroundRefreshTask == nil else { return }

        backgroundRefreshTask = Task { [weak self] in
            guard let self else { return }
            self.loadIfNeeded()
            await self.refreshAccounts(
                fetchUsage: true,
                includeCurrentAuth: true,
                silent: true,
                activeMinimumRefreshInterval: backgroundActiveRefreshInterval,
                inactiveMinimumRefreshInterval: backgroundInactiveRefreshInterval
            )

            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(backgroundActiveRefreshInterval * 1_000_000_000))
                if Task.isCancelled { return }

                await self.refreshAccounts(
                    fetchUsage: true,
                    includeCurrentAuth: true,
                    silent: true,
                    activeMinimumRefreshInterval: backgroundActiveRefreshInterval,
                    inactiveMinimumRefreshInterval: backgroundInactiveRefreshInterval
                )
            }
        }
    }

    func refreshAllUsage(silent: Bool = true) async {
        await refreshAccounts(fetchUsage: true, includeCurrentAuth: true, silent: silent)
    }

    func refreshAccounts(
        fetchUsage: Bool,
        includeCurrentAuth: Bool,
        silent: Bool,
        activeMinimumRefreshInterval: TimeInterval? = nil,
        inactiveMinimumRefreshInterval: TimeInterval? = nil
    ) async {
        if !silent {
            isBusy = true
            busyStatusMessage = fetchUsage
                ? "Refreshing sessions and rate limits..."
                : "Syncing accounts..."
        }
        defer {
            if !silent {
                isBusy = false
                busyStatusMessage = nil
            }
        }

        var storedAccounts = loadStoredAccounts()

        if includeCurrentAuth, let currentFileAccount = loadCurrentAccountFromAuthFile() {
            storedAccounts = upsert(currentFileAccount, into: storedAccounts)
        }

        var runtimeSnapshot: CodexRuntimeSnapshot?
        if includeCurrentAuth {
            runtimeSnapshot = await fetchActiveRuntimeSnapshot()
        }

        var resolvedActiveStableID: String?
        if let runtimeSnapshot {
            let merged = mergeActiveRuntimeSnapshot(runtimeSnapshot, into: storedAccounts)
            storedAccounts = merged.accounts
            resolvedActiveStableID = merged.activeStableID
        }

        if fetchUsage {
            let now = Date()
            for index in storedAccounts.indices {
                let account = storedAccounts[index]
                if let activeStable = resolvedActiveStableID,
                   account.stableID == activeStable,
                   let runtimeSnapshot
                {
                    guard shouldRefreshUsage(
                        for: account,
                        minimumRefreshInterval: activeMinimumRefreshInterval,
                        now: now
                    ) else {
                        continue
                    }
                    var updated = account
                    updated.apply(rateLimits: runtimeSnapshot.rateLimits, planFallback: runtimeSnapshot.planType)
                    updated.usageFetchedAt = Date()
                    updated.usageCheckedAt = Date()
                    updated.lastError = nil
                    updated.isRuntimeOnly = runtimeSnapshot.isRuntimeOnlyMatch
                    storedAccounts[index] = updated
                    continue
                }
                guard shouldRefreshUsage(
                    for: account,
                    minimumRefreshInterval: inactiveMinimumRefreshInterval,
                    now: now
                ) else {
                    continue
                }
                storedAccounts[index] = await refreshUsageThroughCodexAppServer(for: account)
            }
        }

        storedAccounts = deduplicated(storedAccounts)

        let preferredActiveStableID = resolvedActiveStableID ?? loadCurrentAccountFromAuthFile()?.stableID
        _ = commitAccounts(
            storedAccounts,
            strategy: .mergeWithLatest,
            preferredActiveStableID: preferredActiveStableID
        )
    }

    private func shouldRefreshUsage(
        for account: CodexManagedAccount,
        minimumRefreshInterval: TimeInterval?,
        now: Date
    ) -> Bool {
        guard let minimumRefreshInterval, minimumRefreshInterval > 0 else {
            return true
        }

        guard let lastCheck = account.usageCheckedAt ?? account.usageFetchedAt else {
            return true
        }

        return now.timeIntervalSince(lastCheck) >= minimumRefreshInterval
    }

    func refreshAccount(_ accountID: UUID) async {
        var stored = loadStoredAccounts()
        guard let index = stored.firstIndex(where: { $0.id == accountID }) else { return }

        if stored[index].stableID == activeAccountStableID,
           let runtimeSnapshot = await fetchActiveRuntimeSnapshot()
        {
            var updated = stored[index]
            updated.apply(rateLimits: runtimeSnapshot.rateLimits, planFallback: runtimeSnapshot.planType)
            updated.lastError = nil
            updated.usageFetchedAt = Date()
            updated.usageCheckedAt = Date()
            stored[index] = updated
        } else {
            stored[index] = await refreshUsageThroughCodexAppServer(for: stored[index])
        }

        stored = deduplicated(stored)
        _ = commitAccounts(
            stored,
            strategy: .mergeWithLatest,
            preferredActiveStableID: activeAccountStableID
        )
    }

    @discardableResult
    func removeAccount(_ accountID: UUID) -> Bool {
        var stored = loadStoredAccounts()
        guard let index = stored.firstIndex(where: { $0.id == accountID }) else {
            errorMessage = "Account not found."
            return false
        }

        let target = stored[index]
        if target.stableID == activeAccountStableID {
            errorMessage = "Switch to another account before removing the active account."
            return false
        }

        stored.remove(at: index)
        _ = commitAccounts(stored, strategy: .replace, preferredActiveStableID: activeAccountStableID)
        infoMessage = "Account removed."
        return true
    }

    @discardableResult
    func switchToAccount(_ accountID: UUID) async -> Bool {
        var stored = loadStoredAccounts()
        guard let index = stored.firstIndex(where: { $0.id == accountID }) else {
            errorMessage = "Selected account was not found."
            return false
        }

        let account = stored[index]
        guard account.isSwitchable else {
            errorMessage = "This account cannot be activated because tokens are missing."
            return false
        }

        do {
            try ensureCodexConfigUsesFileAuthStore()
            try writeAuthFile(account.auth)

            stored[index].capturedAt = Date()
            stored[index].isRuntimeOnly = false
            _ = commitAccounts(
                stored,
                strategy: .mergeWithLatest,
                preferredActiveStableID: account.stableID
            )
            infoMessage = "Switched to \(account.displayName)."
            appendDebugLog("switch_success stableID=\(account.stableID) display=\(account.displayName)")
            return true
        } catch {
            let message = "Switch failed: \(error.localizedDescription)"
            errorMessage = message
            appendDebugLog("switch_failure stableID=\(account.stableID) error=\(message)")
            return false
        }
    }

    func addAccountViaLogin() async {
        isBusy = true
        busyStatusMessage = "Waiting for Codex login..."
        defer { isBusy = false }
        defer { busyStatusMessage = nil }

        let loginHome = codexHomeURL
            .appendingPathComponent("pocketdex", isDirectory: true)
            .appendingPathComponent("login", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)

        do {
            try prepareLoginHome(loginHome)
            appendDebugLog("add_account_login_start home=\(loginHome.path)")
            infoMessage = "Opening Codex login for a new account..."

            let loginResult = try await runCodexProcess(
                arguments: ["-c", "cli_auth_credentials_store=\"file\"", "login"],
                codexHomeOverride: loginHome,
                timeout: 900
            )

            guard loginResult.exitCode == 0 else {
                let stderr = loginResult.stderr.isEmpty ? "(no stderr)" : loginResult.stderr
                throw CodexAccountsError.loginFailed(stderr)
            }

            let stagedAuthURL = loginHome.appendingPathComponent("auth.json")
            guard fileManager.fileExists(atPath: stagedAuthURL.path) else {
                throw CodexAccountsError.loginAuthFileMissing
            }

            let data = try Data(contentsOf: stagedAuthURL)
            let auth = try JSONDecoder().decode(CodexAuthFilePayload.self, from: data)
            guard let account = accountFromAuth(auth, existingID: nil, existing: nil) else {
                throw CodexAccountsError.loginDidNotProduceUsableAccount
            }

            var stored = loadStoredAccounts()
            stored = upsert(account, into: stored)
            _ = commitAccounts(
                stored,
                strategy: .mergeWithLatest,
                preferredActiveStableID: activeAccountStableID
            )

            appendDebugLog("add_account_login_success stableID=\(account.stableID) email=\(account.email ?? "unknown")")
            infoMessage = "Account added: \(account.displayName)."

            try? fileManager.removeItem(at: loginHome)

            await refreshAccounts(fetchUsage: true, includeCurrentAuth: true, silent: true)
        } catch {
            let message = "Unable to add account: \(error.localizedDescription)"
            errorMessage = message
            appendDebugLog("add_account_login_failure error=\(message)")
        }
    }

    private func refreshUsageThroughCodexAppServer(for account: CodexManagedAccount) async -> CodexManagedAccount {
        var updated = account

        guard updated.auth.tokens?.accessToken?.isEmpty == false else {
            if !updated.isRuntimeOnly {
                updated.lastError = "Missing access token."
            }
            return updated
        }

        do {
            let tempHome = try createRuntimeProbeHome(for: updated.auth)
            defer { try? fileManager.removeItem(at: tempHome) }

            let runtime = try await runCodexAppServerSnapshot(codexHomeOverride: tempHome, forceFileStore: true)

            updated.apply(rateLimits: runtime.rateLimits, planFallback: runtime.planType)
            updated.usageFetchedAt = Date()
            updated.usageCheckedAt = Date()
            updated.lastError = nil
            updated.isRuntimeOnly = false

            let stagedAuth = tempHome.appendingPathComponent("auth.json")
            if let data = try? Data(contentsOf: stagedAuth),
               let refreshedAuth = try? JSONDecoder().decode(CodexAuthFilePayload.self, from: data)
            {
                updated.auth = refreshedAuth
                updated = withRecomputedIdentity(updated)
            }

            appendDebugLog("usage_refresh_success stableID=\(updated.stableID) email=\(updated.email ?? "unknown") primary=\(updated.usageSnapshot?.primary?.usedPercent ?? -1) secondary=\(updated.usageSnapshot?.secondary?.usedPercent ?? -1)")
            return updated
        } catch {
            if isMissingRateLimitsPayloadError(error) {
                // This can happen transiently when app-server exits before emitting
                // the rate-limits response. Keep the previous snapshot instead of
                // surfacing a scary hard error.
                if updated.usageSnapshot != nil {
                    updated.lastError = nil
                } else {
                    updated.lastError = "Rate limits are temporarily unavailable."
                }
                updated.usageCheckedAt = Date()
                appendDebugLog("usage_refresh_partial stableID=\(updated.stableID) warning=missing_rate_limits_payload")
            } else {
                updated.lastError = error.localizedDescription
                updated.usageCheckedAt = Date()
                appendDebugLog("usage_refresh_failure stableID=\(updated.stableID) error=\(error.localizedDescription)")
            }
            return updated
        }
    }

    private func fetchActiveRuntimeSnapshot() async -> CodexRuntimeSnapshot? {
        do {
            let snapshot = try await runCodexAppServerSnapshot(codexHomeOverride: nil, forceFileStore: false)
            appendDebugLog("active_runtime_snapshot_success email=\(snapshot.email ?? "unknown") plan=\(snapshot.planType ?? "unknown") p=\(snapshot.rateLimits.primary?.usedPercent ?? -1) s=\(snapshot.rateLimits.secondary?.usedPercent ?? -1)")
            return snapshot
        } catch {
            if isMissingRateLimitsPayloadError(error) {
                appendDebugLog("active_runtime_snapshot_partial warning=missing_rate_limits_payload")
            } else {
                appendDebugLog("active_runtime_snapshot_failure error=\(error.localizedDescription)")
            }
            return nil
        }
    }

    private func runCodexAppServerSnapshot(
        codexHomeOverride: URL?,
        forceFileStore: Bool
    ) async throws -> CodexRuntimeSnapshot {
        let maxAttempts = 4
        var lastError: Error?

        for attempt in 1...maxAttempts {
            do {
                return try await runCodexAppServerSnapshotOnce(
                    codexHomeOverride: codexHomeOverride,
                    forceFileStore: forceFileStore
                )
            } catch {
                lastError = error
                guard isMissingRateLimitsPayloadError(error), attempt < maxAttempts else {
                    throw error
                }

                let nextAttempt = attempt + 1
                appendDebugLog(
                    "app_server_retry reason=missing_rate_limits_payload attempt=\(nextAttempt)/\(maxAttempts)"
                )
                // Brief backoff to reduce races where app-server emits account data
                // before rate-limits are fully ready.
                try? await Task.sleep(nanoseconds: UInt64(180_000_000 * attempt))
            }
        }

        if let lastError {
            throw lastError
        }
        throw CodexAccountsError.appServerInvalidPayload("Missing rateLimits payload")
    }

    private func runCodexAppServerSnapshotOnce(
        codexHomeOverride: URL?,
        forceFileStore: Bool
    ) async throws -> CodexRuntimeSnapshot {
        var arguments: [String] = []
        if forceFileStore {
            arguments += ["-c", "cli_auth_credentials_store=\"file\""]
        }
        arguments += ["app-server"]

        let requests: [[String: Any]] = [
            [
                "id": 1,
                "method": "initialize",
                "params": [
                    "clientInfo": [
                        "name": "pocketdex_menubar",
                        "version": "1.0"
                    ]
                ]
            ],
            [
                "method": "initialized",
                "params": [:]
            ],
            [
                "id": 2,
                "method": "account/read",
                "params": ["refreshToken": true]
            ],
            [
                "id": 3,
                "method": "account/rateLimits/read",
                "params": [:]
            ],
            [
                "id": 4,
                "method": "account/read",
                "params": ["refreshToken": false]
            ],
            [
                "id": 5,
                "method": "account/rateLimits/read",
                "params": [:]
            ],
        ]

        let result = try await runCodexProcess(
            arguments: arguments,
            codexHomeOverride: codexHomeOverride,
            timeout: 30,
            stdinJSONLines: requests
        )

        guard result.exitCode == 0 else {
            let message = result.stderr.isEmpty ? result.stdout : result.stderr
            throw CodexAccountsError.appServerFailed(message)
        }

        return try parseRuntimeSnapshot(from: result.stdout)
    }

    private func isMissingRateLimitsPayloadError(_ error: Error) -> Bool {
        guard let codexError = error as? CodexAccountsError else {
            return false
        }
        switch codexError {
        case .appServerInvalidPayload(let message):
            return message.localizedCaseInsensitiveContains("missing ratelimits payload")
        default:
            return false
        }
    }

    private func runCodexProcess(
        arguments: [String],
        codexHomeOverride: URL?,
        timeout: TimeInterval,
        stdinJSONLines: [[String: Any]] = []
    ) async throws -> CodexProcessResult {
        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        let stdinPipe = Pipe()

        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        process.standardInput = stdinPipe

        let executable = resolveCodexExecutable()
        process.executableURL = executable.url
        process.arguments = executable.prefixArguments + arguments

        var env = ProcessInfo.processInfo.environment
        if let codexHomeOverride {
            env["CODEX_HOME"] = codexHomeOverride.path
        }
        process.environment = env

        try process.run()

        for payload in stdinJSONLines {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [])
            if let handle = stdinPipe.fileHandleForWriting as FileHandle? {
                handle.write(data)
                handle.write(Data([0x0A]))
            }
        }
        try? stdinPipe.fileHandleForWriting.close()

        let completed = await waitForProcessExit(process, timeout: timeout)
        if !completed {
            if process.isRunning {
                process.terminate()
            }
            throw CodexAccountsError.processTimedOut
        }

        let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()

        let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
        let stderr = String(data: stderrData, encoding: .utf8) ?? ""

        return CodexProcessResult(
            exitCode: process.terminationStatus,
            stdout: stdout,
            stderr: stderr
        )
    }

    private func waitForProcessExit(_ process: Process, timeout: TimeInterval) async -> Bool {
        let sleepChunk: UInt64 = 100_000_000 // 100ms
        let deadline = Date().addingTimeInterval(timeout)

        while process.isRunning {
            if Date() >= deadline {
                return false
            }
            try? await Task.sleep(nanoseconds: sleepChunk)
        }

        return true
    }

    private func parseRuntimeSnapshot(from output: String) throws -> CodexRuntimeSnapshot {
        var accountEmail: String?
        var accountPlanType: String?
        var rateLimitsPayload: [String: Any]?
        var resultIDs: [Int] = []

        let lines = output.split(whereSeparator: \.isNewline).map(String.init)
        for line in lines where !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            guard let data = line.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                continue
            }

            if let id = json["id"] as? Int,
               let error = json["error"] as? [String: Any]
            {
                let message = (error["message"] as? String) ?? "unknown app-server error"
                throw CodexAccountsError.appServerMethodFailed(id: id, message: message)
            }

            guard let id = json["id"] as? Int,
                  let result = json["result"] as? [String: Any]
            else {
                continue
            }
            resultIDs.append(id)

            if id == 2 || id == 4 {
                let account = (result["account"] as? [String: Any]) ?? result
                accountEmail = (account["email"] as? String) ?? accountEmail
                accountPlanType = stringValue(forKeys: ["planType", "plan_type"], in: account) ?? accountPlanType
            }

            if rateLimitsPayload == nil,
               let extracted = extractRateLimitsPayload(from: result)
            {
                rateLimitsPayload = extracted
            }
        }

        guard let rateLimitsPayload else {
            let ids = resultIDs
                .sorted()
                .map(String.init)
                .joined(separator: ",")
            let suffix = ids.isEmpty ? "none" : ids
            throw CodexAccountsError.appServerInvalidPayload(
                "Missing rateLimits payload (result ids: \(suffix))"
            )
        }

        let parsed = parseRateLimitSnapshot(from: rateLimitsPayload)
        return CodexRuntimeSnapshot(
            email: accountEmail,
            planType: accountPlanType ?? parsed.planType,
            rateLimits: parsed,
            isRuntimeOnlyMatch: false
        )
    }

    private func extractRateLimitsPayload(from result: [String: Any]) -> [String: Any]? {
        if let payload = result["rateLimits"] as? [String: Any] {
            return payload
        }
        if let payload = result["rate_limits"] as? [String: Any] {
            return payload
        }
        if result["primary"] != nil || result["secondary"] != nil {
            return result
        }
        if let account = result["account"] as? [String: Any] {
            if let payload = account["rateLimits"] as? [String: Any] {
                return payload
            }
            if let payload = account["rate_limits"] as? [String: Any] {
                return payload
            }
            if account["primary"] != nil || account["secondary"] != nil {
                return account
            }
        }
        return nil
    }

    private func parseRateLimitSnapshot(from payload: [String: Any]) -> CodexRateLimitSnapshot {
        let primaryPayload = payload["primary"] as? [String: Any]
        let secondaryPayload = payload["secondary"] as? [String: Any]
        let creditsPayload = payload["credits"] as? [String: Any]

        let primary = primaryPayload.flatMap(parseRateLimitWindowFromAppServer)
        let secondary = secondaryPayload.flatMap(parseRateLimitWindowFromAppServer)

        let credits: CodexCreditsSnapshot? = {
            guard let creditsPayload else { return nil }
            return CodexCreditsSnapshot(
                hasCredits: booleanValue(forKeys: ["hasCredits", "has_credits"], in: creditsPayload) ?? false,
                unlimited: (creditsPayload["unlimited"] as? Bool) ?? false,
                balance: creditsPayload["balance"] as? String
            )
        }()

        return CodexRateLimitSnapshot(
            planType: stringValue(forKeys: ["planType", "plan_type"], in: payload),
            primary: primary,
            secondary: secondary,
            credits: credits
        )
    }

    private func parseRateLimitWindowFromAppServer(_ payload: [String: Any]) -> CodexRateLimitWindow {
        let usedPercent = numberValue(forKeys: ["usedPercent", "used_percent"], in: payload) ?? 0
        let minutes = integerValue(forKeys: ["windowDurationMins", "window_duration_mins"], in: payload)
        let resetEpoch = numberValue(forKeys: ["resetsAt", "resets_at"], in: payload) ?? 0

        return CodexRateLimitWindow(
            usedPercent: usedPercent,
            windowMinutes: minutes,
            resetAt: resetEpoch > 0 ? Date(timeIntervalSince1970: resetEpoch) : nil,
            resetAfterSeconds: nil
        )
    }

    private func stringValue(forKeys keys: [String], in payload: [String: Any]) -> String? {
        for key in keys {
            if let value = payload[key] as? String, !value.isEmpty {
                return value
            }
        }
        return nil
    }

    private func booleanValue(forKeys keys: [String], in payload: [String: Any]) -> Bool? {
        for key in keys {
            if let value = payload[key] as? Bool {
                return value
            }
            if let number = payload[key] as? NSNumber {
                return number.boolValue
            }
            if let value = payload[key] as? String {
                switch value.lowercased() {
                case "true", "1":
                    return true
                case "false", "0":
                    return false
                default:
                    continue
                }
            }
        }
        return nil
    }

    private func integerValue(forKeys keys: [String], in payload: [String: Any]) -> Int? {
        for key in keys {
            if let value = payload[key] as? Int {
                return value
            }
            if let value = payload[key] as? Double {
                return Int(value)
            }
            if let value = payload[key] as? NSNumber {
                return value.intValue
            }
            if let value = payload[key] as? String, let intValue = Int(value) {
                return intValue
            }
        }
        return nil
    }

    private func numberValue(forKeys keys: [String], in payload: [String: Any]) -> Double? {
        for key in keys {
            if let value = payload[key] as? Double {
                return value
            }
            if let value = payload[key] as? Int {
                return Double(value)
            }
            if let value = payload[key] as? NSNumber {
                return value.doubleValue
            }
            if let value = payload[key] as? String, let doubleValue = Double(value) {
                return doubleValue
            }
        }
        return nil
    }

    private func prepareLoginHome(_ home: URL) throws {
        try fileManager.createDirectory(
            at: home,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: Int16(0o700))]
        )

        var config = "cli_auth_credentials_store = \"file\"\n"
        if let baseURL = readChatGPTBaseURLFromConfig() {
            config += "chatgpt_base_url = \"\(baseURL)\"\n"
        }
        let configURL = home.appendingPathComponent("config.toml")
        try writeTextFile(config, to: configURL)
    }

    private func createRuntimeProbeHome(for auth: CodexAuthFilePayload) throws -> URL {
        let home = codexHomeURL
            .appendingPathComponent("pocketdex", isDirectory: true)
            .appendingPathComponent("runtime-probes", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)

        try fileManager.createDirectory(
            at: home,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: Int16(0o700))]
        )

        let authURL = home.appendingPathComponent("auth.json")
        let configURL = home.appendingPathComponent("config.toml")

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let authData = try encoder.encode(auth)
        try writeBinaryFile(authData, to: authURL)

        var config = "cli_auth_credentials_store = \"file\"\n"
        if let baseURL = readChatGPTBaseURLFromConfig() {
            config += "chatgpt_base_url = \"\(baseURL)\"\n"
        }
        try writeTextFile(config, to: configURL)

        return home
    }

    private func resolveCodexExecutable() -> (url: URL, prefixArguments: [String]) {
        if let envCodex = ProcessInfo.processInfo.environment["CODEX_BIN"], !envCodex.isEmpty,
           fileManager.isExecutableFile(atPath: envCodex)
        {
            return (URL(fileURLWithPath: envCodex), [])
        }

        let candidates = [
            "/Applications/Codex.app/Contents/Resources/codex",
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
        ]

        for candidate in candidates where fileManager.isExecutableFile(atPath: candidate) {
            return (URL(fileURLWithPath: candidate), [])
        }

        return (URL(fileURLWithPath: "/usr/bin/env"), ["codex"])
    }

    private func loadStoredAccounts() -> [CodexManagedAccount] {
        guard fileManager.fileExists(atPath: accountsFileURL.path) else {
            return []
        }

        do {
            let data = try Data(contentsOf: accountsFileURL)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .secondsSince1970
            let payload = try decoder.decode(CodexAccountsFilePayload.self, from: data)
            return deduplicated(payload.accounts)
        } catch {
            errorMessage = "Failed to parse saved account list. \(error.localizedDescription)"
            appendDebugLog("load_accounts_failure error=\(error.localizedDescription)")
            return []
        }
    }

    private func persistStoredAccounts(_ accounts: [CodexManagedAccount]) {
        do {
            let payload = CodexAccountsFilePayload(version: 2, accounts: accounts)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            encoder.dateEncodingStrategy = .secondsSince1970
            let data = try encoder.encode(payload)
            try writeBinaryFile(data, to: accountsFileURL)
        } catch {
            errorMessage = "Failed to save account list. \(error.localizedDescription)"
            appendDebugLog("persist_accounts_failure error=\(error.localizedDescription)")
        }
    }

    private func loadCurrentAccountFromAuthFile() -> CodexManagedAccount? {
        guard fileManager.fileExists(atPath: authFileURL.path) else {
            return nil
        }

        do {
            let data = try Data(contentsOf: authFileURL)
            let auth = try JSONDecoder().decode(CodexAuthFilePayload.self, from: data)
            return accountFromAuth(auth, existingID: nil, existing: nil)
        } catch {
            appendDebugLog("load_current_auth_file_failure error=\(error.localizedDescription)")
            return nil
        }
    }

    private func accountFromAuth(
        _ auth: CodexAuthFilePayload,
        existingID: UUID?,
        existing: CodexManagedAccount?
    ) -> CodexManagedAccount? {
        guard var tokens = auth.tokens else { return nil }
        guard let accessToken = tokens.accessToken, !accessToken.isEmpty else { return nil }

        let identity = parseIdentity(fromIDToken: tokens.idToken)

        if let identityAccountID = identity.chatgptAccountID, !identityAccountID.isEmpty {
            tokens.accountID = identityAccountID
        }

        var normalizedAuth = auth
        normalizedAuth.tokens = tokens

        let stableID = stableIDForAccount(
            accountID: tokens.accountID,
            userID: identity.chatgptUserID,
            email: identity.email,
            tokenSeed: tokens.refreshToken ?? accessToken
        )

        var account = existing ?? CodexManagedAccount(
            id: existingID ?? UUID(),
            stableID: stableID,
            email: identity.email,
            planType: identity.planType,
            chatgptUserID: identity.chatgptUserID,
            chatgptAccountID: tokens.accountID ?? identity.chatgptAccountID,
            capturedAt: Date(),
            auth: normalizedAuth,
            usageSnapshot: nil,
            usageFetchedAt: nil,
            usageCheckedAt: nil,
            lastError: nil,
            isRuntimeOnly: false
        )

        account.stableID = stableID
        account.auth = normalizedAuth
        account.capturedAt = Date()
        account.isRuntimeOnly = false

        if let email = identity.email {
            account.email = email
        }
        if let planType = identity.planType {
            account.planType = planType
        }
        if let userID = identity.chatgptUserID {
            account.chatgptUserID = userID
        }
        if let accountID = tokens.accountID ?? identity.chatgptAccountID {
            account.chatgptAccountID = accountID
        }

        return account
    }

    private func mergeActiveRuntimeSnapshot(
        _ runtime: CodexRuntimeSnapshot,
        into accounts: [CodexManagedAccount]
    ) -> (accounts: [CodexManagedAccount], activeStableID: String) {
        var mutable = accounts

        if let email = runtime.email?.lowercased(),
           let index = mutable.firstIndex(where: { $0.email?.lowercased() == email })
        {
            var match = mutable[index]
            match.apply(rateLimits: runtime.rateLimits, planFallback: runtime.planType)
            match.usageFetchedAt = Date()
            match.usageCheckedAt = Date()
            match.lastError = nil
            match.isRuntimeOnly = false
            mutable[index] = match
            return (mutable, match.stableID)
        }

        let stableID = stableIDForRuntime(email: runtime.email)
        var runtimeAccount = CodexManagedAccount(
            id: UUID(),
            stableID: stableID,
            email: runtime.email,
            planType: runtime.planType,
            chatgptUserID: nil,
            chatgptAccountID: nil,
            capturedAt: Date(),
            auth: CodexAuthFilePayload(authMode: nil, openAIAPIKey: nil, tokens: nil, lastRefresh: nil),
            usageSnapshot: runtime.rateLimits,
            usageFetchedAt: Date(),
            usageCheckedAt: Date(),
            lastError: nil,
            isRuntimeOnly: true
        )
        runtimeAccount.apply(rateLimits: runtime.rateLimits, planFallback: runtime.planType)

        mutable.append(runtimeAccount)
        return (mutable, runtimeAccount.stableID)
    }

    private func upsert(_ account: CodexManagedAccount, into accounts: [CodexManagedAccount]) -> [CodexManagedAccount] {
        var mutable = accounts
        if let index = mutable.firstIndex(where: { $0.stableID == account.stableID }) {
            var merged = mutable[index]
            merged.auth = account.auth
            merged.capturedAt = account.capturedAt
            merged.email = account.email ?? merged.email
            merged.planType = account.planType ?? merged.planType
            merged.chatgptUserID = account.chatgptUserID ?? merged.chatgptUserID
            merged.chatgptAccountID = account.chatgptAccountID ?? merged.chatgptAccountID
            merged.isRuntimeOnly = false

            // Preserve usage updates when the incoming account carries fresher
            // rate-limit data (or an updated error state). This is essential for
            // merge-with-latest commits that reconcile concurrent writers.
            let carriesUsageUpdate =
                account.usageSnapshot != nil
                || account.usageFetchedAt != nil
                || account.usageCheckedAt != nil
                || account.lastError != nil
            if carriesUsageUpdate {
                merged.usageSnapshot = account.usageSnapshot
                merged.usageFetchedAt = account.usageFetchedAt
                merged.usageCheckedAt = account.usageCheckedAt
                merged.lastError = account.lastError
            }

            mutable[index] = merged
            return mutable
        }

        mutable.append(account)
        return mutable
    }

    private func deduplicated(_ accounts: [CodexManagedAccount]) -> [CodexManagedAccount] {
        var map: [String: CodexManagedAccount] = [:]
        for account in accounts {
            if let existing = map[account.stableID] {
                let existingStamp = existing.usageFetchedAt ?? existing.capturedAt
                let candidateStamp = account.usageFetchedAt ?? account.capturedAt
                map[account.stableID] = candidateStamp >= existingStamp ? account : existing
            } else {
                map[account.stableID] = account
            }
        }
        return Array(map.values)
    }

    @discardableResult
    private func commitAccounts(
        _ proposedAccounts: [CodexManagedAccount],
        strategy: AccountsCommitStrategy,
        preferredActiveStableID: String?
    ) -> [CodexManagedAccount] {
        accountsCommitRevision += 1

        var committed: [CodexManagedAccount]
        switch strategy {
        case .replace:
            committed = deduplicated(proposedAccounts)
        case .mergeWithLatest:
            // Merge with the latest on-disk snapshot to avoid lost updates when
            // multiple async tasks persist account lists concurrently.
            var merged = loadStoredAccounts()
            for account in proposedAccounts {
                merged = upsert(account, into: merged)
            }
            committed = deduplicated(merged)
        }

        if let preferredActiveStableID {
            activeAccountStableID = preferredActiveStableID
        }

        committed = sortAccounts(committed)
        persistStoredAccounts(committed)
        accounts = committed
        lastUpdatedAt = Date()
        appendDebugLog(
            "accounts_commit rev=\(accountsCommitRevision) strategy=\(strategy.rawValue) count=\(committed.count)"
        )
        return committed
    }

    private func sortAccounts(_ accounts: [CodexManagedAccount]) -> [CodexManagedAccount] {
        accounts.sorted { lhs, rhs in
            let lhsActive = lhs.stableID == activeAccountStableID
            let rhsActive = rhs.stableID == activeAccountStableID
            if lhsActive != rhsActive {
                return lhsActive
            }
            return lhs.capturedAt > rhs.capturedAt
        }
    }

    private func parseIdentity(fromIDToken idToken: String?) -> CodexTokenIdentity {
        guard let idToken, !idToken.isEmpty else {
            return CodexTokenIdentity(email: nil, planType: nil, chatgptUserID: nil, chatgptAccountID: nil)
        }

        let pieces = idToken.split(separator: ".")
        guard pieces.count >= 2 else {
            return CodexTokenIdentity(email: nil, planType: nil, chatgptUserID: nil, chatgptAccountID: nil)
        }

        var payload = String(pieces[1])
        payload = payload.replacingOccurrences(of: "-", with: "+")
        payload = payload.replacingOccurrences(of: "_", with: "/")
        let padding = (4 - payload.count % 4) % 4
        if padding > 0 {
            payload += String(repeating: "=", count: padding)
        }

        guard let payloadData = Data(base64Encoded: payload),
              let object = try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any]
        else {
            return CodexTokenIdentity(email: nil, planType: nil, chatgptUserID: nil, chatgptAccountID: nil)
        }

        let profile = object["https://api.openai.com/profile"] as? [String: Any]
        let auth = object["https://api.openai.com/auth"] as? [String: Any]

        return CodexTokenIdentity(
            email: (object["email"] as? String) ?? (profile?["email"] as? String),
            planType: auth?["chatgpt_plan_type"] as? String,
            chatgptUserID: (auth?["chatgpt_user_id"] as? String) ?? (auth?["user_id"] as? String),
            chatgptAccountID: auth?["chatgpt_account_id"] as? String
        )
    }

    private func stableIDForRuntime(email: String?) -> String {
        if let email, !email.isEmpty {
            return "runtime|\(email.lowercased())"
        }
        return "runtime|\(UUID().uuidString.lowercased())"
    }

    private func stableIDForAccount(
        accountID: String?,
        userID: String?,
        email: String?,
        tokenSeed: String
    ) -> String {
        let parts = [accountID, userID, email?.lowercased()]
            .compactMap { value -> String? in
                guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
                    return nil
                }
                return value
            }

        if !parts.isEmpty {
            return parts.joined(separator: "|")
        }

        let digest = SHA256.hash(data: Data(tokenSeed.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func withRecomputedIdentity(_ account: CodexManagedAccount) -> CodexManagedAccount {
        var updated = account
        guard let tokens = updated.auth.tokens else {
            return updated
        }

        let identity = parseIdentity(fromIDToken: tokens.idToken)

        if let email = identity.email {
            updated.email = email
        }
        if let plan = identity.planType {
            updated.planType = plan
        }
        if let userID = identity.chatgptUserID {
            updated.chatgptUserID = userID
        }
        if let accountID = tokens.accountID ?? identity.chatgptAccountID {
            updated.chatgptAccountID = accountID
        }

        updated.stableID = stableIDForAccount(
            accountID: tokens.accountID ?? identity.chatgptAccountID,
            userID: identity.chatgptUserID,
            email: identity.email,
            tokenSeed: tokens.refreshToken ?? tokens.accessToken ?? UUID().uuidString
        )

        return updated
    }

    private func ensureCodexConfigUsesFileAuthStore() throws {
        let existing = (try? String(contentsOf: configFileURL, encoding: .utf8)) ?? ""
        let updated = setTopLevelConfigValue(
            in: existing,
            key: "cli_auth_credentials_store",
            valueLiteral: "\"file\""
        )
        if updated != existing {
            try writeTextFile(updated, to: configFileURL)
        }
    }

    private func readChatGPTBaseURLFromConfig() -> String? {
        guard let raw = try? String(contentsOf: configFileURL, encoding: .utf8) else {
            return nil
        }
        return readTopLevelConfigValue(forKey: "chatgpt_base_url", from: raw)
    }

    private func readTopLevelConfigValue(forKey key: String, from raw: String) -> String? {
        var currentSection: String?
        for line in raw.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") {
                continue
            }
            if trimmed.hasPrefix("[") && trimmed.hasSuffix("]") {
                currentSection = trimmed
                continue
            }
            guard currentSection == nil else { continue }

            let parts = trimmed.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { continue }

            let candidateKey = String(parts[0]).trimmingCharacters(in: .whitespaces)
            guard candidateKey == key else { continue }

            let valuePart = String(parts[1]).trimmingCharacters(in: .whitespaces)
            if let firstQuote = valuePart.firstIndex(of: "\""),
               let lastQuote = valuePart.lastIndex(of: "\""),
               firstQuote < lastQuote
            {
                return String(valuePart[valuePart.index(after: firstQuote)..<lastQuote])
            }

            let commentStripped = valuePart.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first
            return commentStripped?.trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    private func setTopLevelConfigValue(in raw: String, key: String, valueLiteral: String) -> String {
        var lines = raw.components(separatedBy: .newlines)
        var currentSection: String?
        var replaced = false

        for index in lines.indices {
            let trimmed = lines[index].trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("[") && trimmed.hasSuffix("]") {
                currentSection = trimmed
                continue
            }
            if trimmed.isEmpty || trimmed.hasPrefix("#") {
                continue
            }
            guard currentSection == nil else { continue }

            let parts = trimmed.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { continue }

            let candidate = String(parts[0]).trimmingCharacters(in: .whitespaces)
            guard candidate == key else { continue }

            lines[index] = "\(key) = \(valueLiteral)"
            replaced = true
        }

        if !replaced {
            if let firstSection = lines.firstIndex(where: {
                let trimmed = $0.trimmingCharacters(in: .whitespaces)
                return trimmed.hasPrefix("[") && trimmed.hasSuffix("]")
            }) {
                lines.insert("\(key) = \(valueLiteral)", at: firstSection)
                lines.insert("", at: firstSection + 1)
            } else {
                if !lines.isEmpty, !lines.last!.isEmpty {
                    lines.append("")
                }
                lines.append("\(key) = \(valueLiteral)")
            }
        }

        return lines.joined(separator: "\n")
    }

    private func writeAuthFile(_ auth: CodexAuthFilePayload) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(auth)
        try writeBinaryFile(data, to: authFileURL)
    }

    private func writeTextFile(_ text: String, to url: URL) throws {
        guard let data = text.data(using: .utf8) else {
            throw CodexAccountsError.unableToEncodeText
        }
        try writeBinaryFile(data, to: url)
    }

    private func writeBinaryFile(_ data: Data, to url: URL) throws {
        let parent = url.deletingLastPathComponent()
        try fileManager.createDirectory(
            at: parent,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: Int16(0o700))]
        )

        try data.write(to: url, options: [.atomic])
        try fileManager.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o600))],
            ofItemAtPath: url.path
        )
    }

    private func appendDebugLog(_ message: String) {
        let line = "[\(Self.debugDateFormatter.string(from: Date()))] \(message)\n"
        let data = Data(line.utf8)

        do {
            let parent = debugLogURL.deletingLastPathComponent()
            try fileManager.createDirectory(
                at: parent,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: NSNumber(value: Int16(0o700))]
            )

            if !fileManager.fileExists(atPath: debugLogURL.path) {
                fileManager.createFile(atPath: debugLogURL.path, contents: nil)
                try fileManager.setAttributes(
                    [.posixPermissions: NSNumber(value: Int16(0o600))],
                    ofItemAtPath: debugLogURL.path
                )
            }

            let handle = try FileHandle(forWritingTo: debugLogURL)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } catch {
            // Ignore debug logging failures.
        }
    }

    private static let debugDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter
    }()
}

private struct CodexProcessResult {
    let exitCode: Int32
    let stdout: String
    let stderr: String
}

private struct CodexRuntimeSnapshot {
    let email: String?
    let planType: String?
    let rateLimits: CodexRateLimitSnapshot
    let isRuntimeOnlyMatch: Bool
}

private struct CodexTokenIdentity {
    let email: String?
    let planType: String?
    let chatgptUserID: String?
    let chatgptAccountID: String?
}

private struct CodexAccountsFilePayload: Codable {
    let version: Int
    let accounts: [CodexManagedAccount]
}

struct CodexManagedAccount: Codable, Identifiable, Hashable {
    let id: UUID
    var stableID: String
    var email: String?
    var planType: String?
    var chatgptUserID: String?
    var chatgptAccountID: String?
    var capturedAt: Date
    var auth: CodexAuthFilePayload
    var usageSnapshot: CodexRateLimitSnapshot?
    var usageFetchedAt: Date?
    var usageCheckedAt: Date?
    var lastError: String?
    var isRuntimeOnly: Bool

    var displayName: String {
        if let email, !email.isEmpty {
            return email
        }
        if let chatgptAccountID, !chatgptAccountID.isEmpty {
            return "Account \(chatgptAccountID)"
        }
        return "Saved account"
    }

    var displaySubtitle: String {
        var pieces: [String] = []
        if let chatgptAccountID, !chatgptAccountID.isEmpty {
            pieces.append(chatgptAccountID)
        }
        if let planType, !planType.isEmpty {
            pieces.append(planType.uppercased())
        }
        if isRuntimeOnly {
            pieces.append("runtime")
        }
        return pieces.joined(separator: " • ")
    }

    var isSwitchable: Bool {
        guard !isRuntimeOnly else { return false }
        guard let tokens = auth.tokens else { return false }
        guard let accessToken = tokens.accessToken, !accessToken.isEmpty else { return false }
        return true
    }

    mutating func apply(rateLimits: CodexRateLimitSnapshot, planFallback: String?) {
        usageSnapshot = rateLimits
        if let explicitPlan = rateLimits.planType, !explicitPlan.isEmpty {
            planType = explicitPlan
        } else if let planFallback, !planFallback.isEmpty {
            planType = planFallback
        }
    }
}

struct CodexAuthFilePayload: Codable, Hashable {
    var authMode: String?
    var openAIAPIKey: String?
    var tokens: CodexAuthTokens?
    var lastRefresh: String?

    enum CodingKeys: String, CodingKey {
        case authMode = "auth_mode"
        case openAIAPIKey = "OPENAI_API_KEY"
        case tokens
        case lastRefresh = "last_refresh"
    }
}

struct CodexAuthTokens: Codable, Hashable {
    var idToken: String?
    var accessToken: String?
    var refreshToken: String?
    var accountID: String?

    enum CodingKeys: String, CodingKey {
        case idToken = "id_token"
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case accountID = "account_id"
    }
}

struct CodexRateLimitSnapshot: Codable, Hashable {
    var planType: String?
    var primary: CodexRateLimitWindow?
    var secondary: CodexRateLimitWindow?
    var credits: CodexCreditsSnapshot?
}

struct CodexRateLimitWindow: Codable, Hashable {
    var usedPercent: Double
    var windowMinutes: Int?
    var resetAt: Date?
    var resetAfterSeconds: Int?
}

struct CodexCreditsSnapshot: Codable, Hashable {
    var hasCredits: Bool
    var unlimited: Bool
    var balance: String?
}

private enum CodexAccountsError: LocalizedError {
    case unableToEncodeText
    case loginFailed(String)
    case loginAuthFileMissing
    case loginDidNotProduceUsableAccount
    case processTimedOut
    case appServerFailed(String)
    case appServerMethodFailed(id: Int, message: String)
    case appServerInvalidPayload(String)

    var errorDescription: String? {
        switch self {
        case .unableToEncodeText:
            return "Unable to encode text."
        case .loginFailed(let details):
            return "Codex login failed: \(details)"
        case .loginAuthFileMissing:
            return "Login completed but no auth file was produced."
        case .loginDidNotProduceUsableAccount:
            return "Login completed but produced unusable account data."
        case .processTimedOut:
            return "The Codex process timed out."
        case .appServerFailed(let details):
            return "Codex app-server failed: \(details)"
        case .appServerMethodFailed(let id, let message):
            return "Codex app-server method \(id) failed: \(message)"
        case .appServerInvalidPayload(let message):
            return "Invalid app-server payload: \(message)"
        }
    }
}
