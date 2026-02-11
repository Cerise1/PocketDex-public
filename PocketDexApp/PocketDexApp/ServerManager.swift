//
//  ServerManager.swift
//  PocketDexApp
//
//  Created by Codex on 06/02/2026.
//

import AppKit
import Combine
import Darwin
import Foundation

@MainActor
final class ServerManager: NSObject, ObservableObject {
    private let preferredPort = 8787

    enum Status: Equatable {
        case stopped
        case starting
        case running
        case stopping
        case failed(String)
    }

    enum RelaunchCheckResult: Equatable {
        case safe
        case requiresConfirmation(String)
        case unavailable(String)
    }

    @Published private(set) var status: Status = .stopped
    @Published private(set) var logTail: [String] = []
    @Published private(set) var lastErrorMessage: String?
    @Published private(set) var resolvedProjectRoot: URL?
    @Published private(set) var codexActionMessage: String?
    @Published private(set) var codexActionInFlight = false
    @Published private(set) var persistentLogFilePath: String?
    @Published var port: Int = 8787

    private var process: Process?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var persistentLogFileURL: URL?
    private var persistentLogFileHandle: FileHandle?
    private var healthTask: Task<Void, Never>?
    private var startupTask: Task<Void, Never>?
    private var pendingRestart = false
    private var didBootstrap = false
    private var didRunAppTerminationCleanup = false

    init(autoStart: Bool = true) {
        super.init()
        configurePersistentLogging()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppWillTerminate),
            name: NSApplication.willTerminateNotification,
            object: nil
        )
        if autoStart {
            Task { @MainActor [weak self] in
                self?.bootstrapIfNeeded()
            }
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(
            self,
            name: NSApplication.willTerminateNotification,
            object: nil
        )
    }

    var isRunning: Bool {
        if case .running = status { return true }
        return false
    }

    var isBusy: Bool {
        switch status {
        case .starting, .stopping:
            return true
        default:
            return false
        }
    }

    var statusLabel: String {
        switch status {
        case .stopped:
            return "Stopped"
        case .starting:
            return "Starting"
        case .running:
            return "Running"
        case .stopping:
            return "Stopping"
        case .failed:
            return "Error"
        }
    }

    var serverAddress: String {
        "http://localhost:\(port)"
    }

    var statusSymbolName: String {
        switch status {
        case .stopped:
            return "circle"
        case .starting, .stopping:
            return "arrow.triangle.2.circlepath.circle"
        case .running:
            return "checkmark.circle.fill"
        case .failed:
            return "exclamationmark.triangle.fill"
        }
    }

    func bootstrapIfNeeded() {
        guard !didBootstrap else { return }
        didBootstrap = true
        start()
    }

    func toggleServer(_ shouldRun: Bool) {
        if shouldRun {
            start()
        } else {
            stop()
        }
    }

    func start() {
        guard process == nil else { return }
        guard !isBusy else { return }
        didRunAppTerminationCleanup = false
        startupTask?.cancel()
        status = .starting
        startupTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let selectedPort = try self.findFirstAvailablePort(startingAt: self.preferredPort)
                if selectedPort != self.port {
                    self.port = selectedPort
                    if selectedPort == self.preferredPort {
                        self.appendLog("Reusing preferred port \(selectedPort).")
                    } else {
                        self.appendLog("Port \(self.preferredPort) is occupied. Using port \(selectedPort) instead.")
                    }
                }
            } catch {
                self.lastErrorMessage = error.localizedDescription
                self.status = .failed(error.localizedDescription)
                self.appendLog("Failed to pick a free port: \(error.localizedDescription)")
                return
            }

            self.launchManagedServerProcess()
        }
    }

    private func launchManagedServerProcess() {
        do {
            let config = try resolveRuntimeConfiguration()
            resolvedProjectRoot = config.projectRoot
            lastErrorMessage = nil

            let process = Process()
            process.currentDirectoryURL = config.projectRoot
            process.executableURL = config.executable
            process.arguments = config.arguments

            var env = ProcessInfo.processInfo.environment
            for (key, value) in config.environment {
                env[key] = value
            }
            process.environment = env

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr
            installReadHandler(for: stdout)
            installReadHandler(for: stderr)

            process.terminationHandler = { [weak self] proc in
                guard let self else { return }
                Task { @MainActor [self] in
                    self.handleTermination(proc)
                }
            }

            try process.run()
            self.process = process
            self.stdoutPipe = stdout
            self.stderrPipe = stderr

            appendLog("Server start command launched.")
            appendLog("Working directory: \(config.projectRoot.path)")
            beginHealthPolling()
        } catch {
            lastErrorMessage = error.localizedDescription
            status = .failed(error.localizedDescription)
            appendLog("Failed to start server: \(error.localizedDescription)")
        }
    }

    func stop() {
        startupTask?.cancel()
        startupTask = nil

        guard let process else {
            status = .stopped
            return
        }
        guard status != .stopping else { return }

        status = .stopping
        appendLog("Stopping server...")
        process.terminate()

        let pid = process.processIdentifier
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard let current = self.process else { return }
            guard current.processIdentifier == pid else { return }
            guard current.isRunning else { return }
            appendLog("Force-killing lingering server process \(pid).")
            _ = kill(pid, SIGKILL)
        }
    }

    func terminateForAppExit() {
        guard !didRunAppTerminationCleanup else { return }
        didRunAppTerminationCleanup = true

        startupTask?.cancel()
        startupTask = nil
        healthTask?.cancel()
        healthTask = nil
        pendingRestart = false

        guard let process else {
            status = .stopped
            return
        }

        let pid = process.processIdentifier
        process.terminationHandler = nil
        appendLog("Application is closing. Terminating server process \(pid).")

        if process.isRunning {
            _ = kill(pid, SIGTERM)
            if !waitForProcessExit(pid: pid, timeoutNanoseconds: 1_200_000_000) {
                appendLog("Server process \(pid) did not exit after SIGTERM. Sending SIGKILL.")
                _ = kill(pid, SIGKILL)
                _ = waitForProcessExit(pid: pid, timeoutNanoseconds: 500_000_000)
            }
        }

        cleanupProcessState()
        closePersistentLogFile()
        status = .stopped
    }

    func restart() {
        if process == nil {
            start()
            return
        }
        pendingRestart = true
        stop()
    }

    func openWebUI() {
        guard let url = URL(string: serverAddress) else { return }
        NSWorkspace.shared.open(url)
    }

    func openServerLogFile() {
        guard let url = persistentLogFileURL else { return }
        NSWorkspace.shared.open(url)
    }

    func revealServerLogFileInFinder() {
        guard let url = persistentLogFileURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    func isCodexDesktopAppRunning() -> Bool {
        let knownBundleMatches = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex")
            .contains { !$0.isTerminated }
        if knownBundleMatches { return true }

        return NSWorkspace.shared.runningApplications.contains { app in
            guard !app.isTerminated else { return false }
            if app.localizedName?.caseInsensitiveCompare("Codex") == .orderedSame {
                return true
            }
            if app.bundleURL?.lastPathComponent.caseInsensitiveCompare("Codex.app") == .orderedSame {
                return true
            }
            if app.executableURL?.lastPathComponent.caseInsensitiveCompare("Codex") == .orderedSame {
                return true
            }
            return false
        }
    }

    func checkCodexRelaunchSafety() async -> RelaunchCheckResult {
        guard isRunning else {
            let message = "The server must be running to relaunch Codex."
            codexActionMessage = message
            return .unavailable(message)
        }
        do {
            let probe = try await callDesktopResync(
                strategy: "nudge",
                allowDuringActiveRuns: false,
                relaunchApp: false,
                forceQuitApp: false
            )
            if probe.activeRunDetected {
                let message = "An active external run was detected. Forcing a relaunch may interrupt that run."
                codexActionMessage = message
                return .requiresConfirmation(message)
            }
            if let firstWarning = probe.warnings.first, !firstWarning.isEmpty {
                codexActionMessage = firstWarning
            } else {
                codexActionMessage = nil
            }
            return .safe
        } catch {
            let message = error.localizedDescription
            codexActionMessage = message
            return .unavailable(message)
        }
    }

    func relaunchCodex(forceWhenActiveRuns: Bool) async {
        guard !codexActionInFlight else { return }
        guard isRunning else {
            codexActionMessage = "The server must be running to relaunch Codex."
            return
        }
        codexActionInFlight = true
        defer { codexActionInFlight = false }

        do {
            let result = try await callDesktopResync(
                strategy: "nudge",
                allowDuringActiveRuns: forceWhenActiveRuns,
                relaunchApp: true,
                forceQuitApp: true
            )
            if result.appRelaunchTriggered {
                codexActionMessage = "Codex relaunched successfully."
            } else if let firstWarning = result.warnings.first, !firstWarning.isEmpty {
                codexActionMessage = firstWarning
            } else {
                codexActionMessage = "Relaunch completed with a partial result."
            }
        } catch {
            codexActionMessage = error.localizedDescription
        }
    }

    private func beginHealthPolling() {
        healthTask?.cancel()
        healthTask = Task { [weak self] in
            guard let self else { return }
            for _ in 0..<30 {
                if Task.isCancelled { return }
                let isHealthy = await self.checkHealthOnce()
                if isHealthy {
                    if case .starting = self.status {
                        self.status = .running
                        self.appendLog("Server is healthy at http://127.0.0.1:\(self.port)")
                    }
                    return
                }
                try? await Task.sleep(nanoseconds: 300_000_000)
            }

            if case .starting = self.status {
                let message = "Server started but /api/health timed out."
                self.lastErrorMessage = message
                self.status = .failed(message)
                self.appendLog(message)
                self.stop()
            }
        }
    }

    private func checkHealthOnce() async -> Bool {
        await checkHealth(on: port)
    }

    private func checkHealth(on port: Int) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.9
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return false }
            guard http.statusCode == 200 else { return false }
            if let payload = try? JSONDecoder().decode(HealthResponse.self, from: data) {
                return payload.ok == true
            }
            return false
        } catch {
            return false
        }
    }

    private func callDesktopResync(
        strategy: String,
        allowDuringActiveRuns: Bool,
        relaunchApp: Bool,
        forceQuitApp: Bool
    ) async throws -> DesktopResyncResponse {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/codex-desktop/resync") else {
            throw ServerManagerError.invalidResyncURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload = DesktopResyncRequest(
            strategy: strategy,
            allowDuringActiveRuns: allowDuringActiveRuns,
            relaunchApp: relaunchApp,
            forceQuitApp: forceQuitApp,
            rolloutTouchLimit: 8
        )
        request.httpBody = try JSONEncoder().encode(payload)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ServerManagerError.invalidResyncResponse
        }

        if (200..<300).contains(http.statusCode) {
            return try JSONDecoder().decode(DesktopResyncResponse.self, from: data)
        }

        if let apiError = try? JSONDecoder().decode(DesktopResyncErrorResponse.self, from: data),
           let message = apiError.error,
           !message.isEmpty {
            throw ServerManagerError.resyncRequestFailed(message)
        }

        throw ServerManagerError.resyncHTTPStatus(http.statusCode)
    }

    private func handleTermination(_ terminatedProcess: Process) {
        let pid = terminatedProcess.processIdentifier
        let code = terminatedProcess.terminationStatus
        cleanupProcessState()
        startupTask?.cancel()
        startupTask = nil

        if pendingRestart {
            pendingRestart = false
            appendLog("Server process \(pid) terminated. Restarting...")
            start()
            return
        }

        if case .stopping = status {
            status = .stopped
            appendLog("Server stopped.")
            return
        }

        if code == 0 {
            status = .stopped
            appendLog("Server exited cleanly.")
        } else {
            if recentLogsContainAddressInUse() {
                Task { @MainActor [weak self] in
                    await self?.recoverFromAddressInUse()
                }
                return
            }
            let message = "Server exited with code \(code)."
            lastErrorMessage = message
            status = .failed(message)
            appendLog(message)
        }
    }

    private func cleanupProcessState() {
        healthTask?.cancel()
        healthTask = nil
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        stdoutPipe = nil
        stderrPipe = nil
        process = nil
    }

    private func installReadHandler(for pipe: Pipe) {
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            guard let chunk = String(data: data, encoding: .utf8) else { return }
            let lines = chunk
                .split(whereSeparator: \.isNewline)
                .map { String($0) }
                .filter { !$0.isEmpty }
            guard !lines.isEmpty else { return }

            guard let self else { return }
            Task { @MainActor [self, lines] in
                for line in lines {
                    self.appendLog(line)
                }
            }
        }
    }

    private func appendLog(_ message: String) {
        let line = "[\(timestamp())] \(message)"
        logTail.append(line)
        if logTail.count > 120 {
            logTail.removeFirst(logTail.count - 120)
        }
        writePersistentLogLine(line)
    }

    private func timestamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: Date())
    }

    private func configurePersistentLogging() {
        let fileURL = resolvePersistentLogFileURL()
        do {
            let directoryURL = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: fileURL.path) {
                FileManager.default.createFile(atPath: fileURL.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: fileURL)
            handle.seekToEndOfFile()
            persistentLogFileURL = fileURL
            persistentLogFileHandle = handle
            persistentLogFilePath = fileURL.path
            writePersistentLogLine("[\(timestamp())] Logging started.")
        } catch {
            persistentLogFileURL = nil
            persistentLogFileHandle = nil
            persistentLogFilePath = nil
            logTail.append("[\(timestamp())] Persistent logging unavailable: \(error.localizedDescription)")
        }
    }

    private func resolvePersistentLogFileURL() -> URL {
        let env = ProcessInfo.processInfo.environment
        if let explicitPath = env["POCKETDEX_APP_LOG_FILE"], !explicitPath.isEmpty {
            return URL(fileURLWithPath: explicitPath)
        }
        let directoryURL: URL
        if let explicitDirectory = env["POCKETDEX_APP_LOG_DIR"], !explicitDirectory.isEmpty {
            directoryURL = URL(fileURLWithPath: explicitDirectory, isDirectory: true)
        } else {
            directoryURL = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Logs/PocketDex", isDirectory: true)
        }
        return directoryURL.appendingPathComponent("server.log")
    }

    private func writePersistentLogLine(_ line: String) {
        guard let handle = persistentLogFileHandle else { return }
        guard let data = (line + "\n").data(using: .utf8) else { return }
        handle.write(data)
    }

    private func closePersistentLogFile() {
        persistentLogFileHandle?.closeFile()
        persistentLogFileHandle = nil
    }

    private func resolveRuntimeConfiguration() throws -> RuntimeConfiguration {
        let root = try resolveProjectRoot()
        let serverEntry = root.appendingPathComponent("server/dist/index.js")
        guard FileManager.default.fileExists(atPath: serverEntry.path) else {
            throw ServerManagerError.missingServerBuild(serverEntry.path)
        }

        let webCandidates = [
            root.appendingPathComponent("web/out"),
            root.appendingPathComponent("artifacts/web"),
        ]
        guard let webDir = webCandidates.first(where: { containsIndexFile($0) }) else {
            throw ServerManagerError.missingWebBuild(root.path)
        }

        let launcher = try resolveNodeLauncher(serverEntry: serverEntry)
        var env: [String: String] = [
            "PORT": String(port),
            "NODE_ENV": "production",
            "POCKETDEX_WEB_DIR": webDir.path,
            "POCKETDEX_ENABLE_DESKTOP_RESYNC": "1",
            "POCKETDEX_PARENT_PID": String(getpid()),
        ]
        let configuredDeviceName = sanitizeDeviceName(
            ProcessInfo.processInfo.environment["POCKETDEX_DEVICE_NAME"]
        )
        env["POCKETDEX_DEVICE_NAME"] = configuredDeviceName.isEmpty
            ? resolveDefaultDeviceName()
            : configuredDeviceName
        if ProcessInfo.processInfo.environment["CODEX_BIN"] == nil {
            if let codexBinary = resolveCodexBinary() {
                env["CODEX_BIN"] = codexBinary.path
            } else {
                env["CODEX_BIN"] = "codex"
            }
        }

        return RuntimeConfiguration(
            projectRoot: root,
            executable: launcher.executable,
            arguments: launcher.arguments,
            environment: env
        )
    }

    private func resolveDefaultDeviceName() -> String {
        let candidates: [String?] = [
            Host.current().localizedName,
            Host.current().name,
            ProcessInfo.processInfo.hostName,
        ]
        for candidate in candidates {
            let cleaned = sanitizeDeviceName(candidate)
            if !cleaned.isEmpty {
                return cleaned
            }
        }
        return "Unknown device"
    }

    private func sanitizeDeviceName(_ rawName: String?) -> String {
        guard let rawName else { return "" }
        var cleaned = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.lowercased().hasSuffix(".local") {
            cleaned = String(cleaned.dropLast(6))
        }
        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func resolveProjectRoot() throws -> URL {
        let env = ProcessInfo.processInfo.environment
        if let explicitRoot = env["POCKETDEX_PROJECT_ROOT"], !explicitRoot.isEmpty {
            let url = URL(fileURLWithPath: explicitRoot, isDirectory: true)
            if isPocketDexRoot(url) {
                return url
            }
        }

        if let resourceURL = Bundle.main.resourceURL {
            let bundledRuntimeRoot = resourceURL.appendingPathComponent("runtime", isDirectory: true)
            if isPocketDexRoot(bundledRuntimeRoot) {
                return bundledRuntimeRoot
            }
        }

        let sourceFileDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        let bundleDir = Bundle.main.bundleURL
        let parentOfBundle = bundleDir.deletingLastPathComponent()

        let candidates = [sourceFileDir, cwd, bundleDir, parentOfBundle]
        for candidate in candidates {
            if let found = findPocketDexRoot(startingAt: candidate) {
                return found
            }
        }

        throw ServerManagerError.projectRootNotFound
    }

    private func resolveNodeLauncher(serverEntry: URL) throws -> (executable: URL, arguments: [String]) {
        let env = ProcessInfo.processInfo.environment
        if let explicitNode = env["POCKETDEX_NODE_BIN"], !explicitNode.isEmpty {
            let nodeURL = URL(fileURLWithPath: explicitNode)
            if FileManager.default.isExecutableFile(atPath: nodeURL.path) {
                return (nodeURL, [serverEntry.path])
            }
            throw ServerManagerError.invalidNodeBinary(explicitNode)
        }

        if let resourceURL = Bundle.main.resourceURL {
            let embeddedNode = resourceURL.appendingPathComponent("runtime/node/bin/node")
            if FileManager.default.isExecutableFile(atPath: embeddedNode.path) {
                return (embeddedNode, [serverEntry.path])
            }
        }

        if let pathNode = resolveNodeFromPATH() {
            return (pathNode, [serverEntry.path])
        }

        let commonCandidates = [
            "/opt/homebrew/bin/node",
            "/opt/homebrew/opt/node/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        for candidate in commonCandidates where FileManager.default.isExecutableFile(atPath: candidate) {
            return (URL(fileURLWithPath: candidate), [serverEntry.path])
        }

        if let voltaNode = resolveVoltaNodeBinary() {
            return (voltaNode, [serverEntry.path])
        }

        if let nvmNode = resolveNvmNodeBinary() {
            return (nvmNode, [serverEntry.path])
        }

        if let fnmNode = resolveFnmNodeBinary() {
            return (fnmNode, [serverEntry.path])
        }

        throw ServerManagerError.nodeBinaryNotFound
    }

    private func containsIndexFile(_ directory: URL) -> Bool {
        let index = directory.appendingPathComponent("index.html")
        return FileManager.default.fileExists(atPath: index.path)
    }

    private func resolveNodeFromPATH() -> URL? {
        guard let pathValue = ProcessInfo.processInfo.environment["PATH"], !pathValue.isEmpty else {
            return nil
        }
        for entry in pathValue.split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(entry), isDirectory: true).appendingPathComponent("node")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    private func resolveCodexBinary() -> URL? {
        if let pathCodex = resolveExecutableFromPATH(named: "codex") {
            return pathCodex
        }

        let commonCandidates = [
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
            "/Applications/Codex.app/Contents/Resources/codex",
        ]
        for candidate in commonCandidates where FileManager.default.isExecutableFile(atPath: candidate) {
            return URL(fileURLWithPath: candidate)
        }
        return nil
    }

    private func resolveExecutableFromPATH(named executableName: String) -> URL? {
        guard let pathValue = ProcessInfo.processInfo.environment["PATH"], !pathValue.isEmpty else {
            return nil
        }
        for entry in pathValue.split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(entry), isDirectory: true).appendingPathComponent(executableName)
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    private func resolveVoltaNodeBinary() -> URL? {
        let candidate = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".volta/bin/node")
        return FileManager.default.isExecutableFile(atPath: candidate.path) ? candidate : nil
    }

    private func resolveNvmNodeBinary() -> URL? {
        let versionsRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".nvm/versions/node", isDirectory: true)
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: versionsRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return nil
        }
        let directories = entries.filter { url in
            (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
        }
        let sorted = directories.sorted { lhs, rhs in
            compareNodeVersions(lhs.lastPathComponent, rhs.lastPathComponent) == .orderedDescending
        }
        for directory in sorted {
            let candidate = directory.appendingPathComponent("bin/node")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    private func resolveFnmNodeBinary() -> URL? {
        let versionsRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".fnm/node-versions", isDirectory: true)
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: versionsRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return nil
        }
        let directories = entries.filter { url in
            (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
        }
        let sorted = directories.sorted { lhs, rhs in
            compareNodeVersions(lhs.lastPathComponent, rhs.lastPathComponent) == .orderedDescending
        }
        for directory in sorted {
            let candidate = directory.appendingPathComponent("installation/bin/node")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    private func compareNodeVersions(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let left = parseNodeVersion(lhs)
        let right = parseNodeVersion(rhs)
        for index in 0..<max(left.count, right.count) {
            let l = index < left.count ? left[index] : 0
            let r = index < right.count ? right[index] : 0
            if l == r { continue }
            return l < r ? .orderedAscending : .orderedDescending
        }
        return .orderedSame
    }

    private func parseNodeVersion(_ raw: String) -> [Int] {
        let trimmed = raw.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
        return trimmed
            .split(separator: ".")
            .map { Int($0.filter { $0.isNumber }) ?? 0 }
    }

    private func waitForProcessExit(pid: Int32, timeoutNanoseconds: UInt64) -> Bool {
        guard pid > 0 else { return true }
        let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds
        repeat {
            if !isChildProcessRunning(pid) {
                return true
            }
            usleep(20_000)
        } while DispatchTime.now().uptimeNanoseconds < deadline
        return !isChildProcessRunning(pid)
    }

    private func isChildProcessRunning(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        var status: Int32 = 0
        let waitResult = waitpid(pid, &status, WNOHANG)
        if waitResult == pid {
            return false
        }
        if waitResult == 0 {
            return true
        }
        if waitResult == -1 && errno == ECHILD {
            if kill(pid, 0) == 0 {
                return true
            }
            return errno != ESRCH
        }
        return false
    }

    @objc private func handleAppWillTerminate() {
        terminateForAppExit()
    }

    private func listListeningProcesses(onPort port: Int) throws -> [ListeningProcess] {
        let lsof = try runCommand(
            executable: "/usr/sbin/lsof",
            arguments: ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"]
        )
        if lsof.status != 0 {
            return []
        }

        let pids = lsof.stdout
            .split(whereSeparator: \.isNewline)
            .compactMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
        if pids.isEmpty {
            return []
        }

        var result: [ListeningProcess] = []
        for pid in pids {
            let ps = try runCommand(
                executable: "/bin/ps",
                arguments: ["-p", "\(pid)", "-o", "command="]
            )
            let command = ps.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !command.isEmpty else { continue }
            result.append(ListeningProcess(pid: pid, command: command))
        }
        return result
    }

    private func runCommand(executable: String, arguments: [String]) throws -> CommandResult {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: executable)
        task.arguments = arguments

        let stdout = Pipe()
        let stderr = Pipe()
        task.standardOutput = stdout
        task.standardError = stderr

        try task.run()
        task.waitUntilExit()

        let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
        return CommandResult(
            status: task.terminationStatus,
            stdout: String(data: stdoutData, encoding: .utf8) ?? "",
            stderr: String(data: stderrData, encoding: .utf8) ?? ""
        )
    }

    private func recentLogsContainAddressInUse() -> Bool {
        let recent = logTail.suffix(30).joined(separator: "\n").lowercased()
        return recent.contains("eaddrinuse") || recent.contains("address already in use")
    }

    private func recoverFromAddressInUse() async {
        let previousPort = port
        do {
            let retryPort = try findFirstAvailablePort(startingAt: previousPort + 1)
            port = retryPort
            status = .starting
            lastErrorMessage = nil
            appendLog("Port \(previousPort) was claimed during startup. Retrying on port \(retryPort).")
            launchManagedServerProcess()
        } catch {
            let message = "No free port found starting from \(previousPort + 1)."
            lastErrorMessage = message
            status = .failed(message)
            appendLog("Failed to recover from EADDRINUSE: \(error.localizedDescription)")
        }
    }

    private func findFirstAvailablePort(startingAt initialPort: Int) throws -> Int {
        let startPort = max(1, initialPort)
        guard startPort <= 65_535 else {
            throw ServerManagerError.noAvailablePort(startPort: startPort)
        }

        for candidate in startPort...65_535 {
            let listeners = try listListeningProcesses(onPort: candidate)
            if listeners.isEmpty {
                return candidate
            }
        }

        throw ServerManagerError.noAvailablePort(startPort: startPort)
    }

    private func findPocketDexRoot(startingAt start: URL) -> URL? {
        var cursor = start.standardizedFileURL
        let rootPath = cursor.pathComponents.first ?? "/"

        while !cursor.path.isEmpty && cursor.path != rootPath {
            if isPocketDexRoot(cursor) {
                return cursor
            }
            let parent = cursor.deletingLastPathComponent()
            if parent == cursor { break }
            cursor = parent
        }

        if isPocketDexRoot(cursor) {
            return cursor
        }
        return nil
    }

    private func isPocketDexRoot(_ directory: URL) -> Bool {
        let serverPackage = directory.appendingPathComponent("server/package.json")
        let webPackage = directory.appendingPathComponent("web/package.json")
        if FileManager.default.fileExists(atPath: serverPackage.path) &&
            FileManager.default.fileExists(atPath: webPackage.path)
        {
            return true
        }

        let serverEntry = directory.appendingPathComponent("server/dist/index.js")
        let webOutIndex = directory.appendingPathComponent("web/out/index.html")
        let artifactsWebIndex = directory.appendingPathComponent("artifacts/web/index.html")
        return FileManager.default.fileExists(atPath: serverEntry.path) &&
            (FileManager.default.fileExists(atPath: webOutIndex.path) ||
                FileManager.default.fileExists(atPath: artifactsWebIndex.path))
    }
}

private struct HealthResponse: Decodable {
    let ok: Bool?
}

private struct ListeningProcess {
    let pid: Int32
    let command: String
}

private struct CommandResult {
    let status: Int32
    let stdout: String
    let stderr: String
}

private struct RuntimeConfiguration {
    let projectRoot: URL
    let executable: URL
    let arguments: [String]
    let environment: [String: String]
}

private struct DesktopResyncRequest: Encodable {
    let strategy: String
    let allowDuringActiveRuns: Bool
    let relaunchApp: Bool
    let forceQuitApp: Bool
    let rolloutTouchLimit: Int
}

private struct DesktopResyncResponse: Decodable {
    let activeRunDetected: Bool
    let appRelaunchTriggered: Bool
    let warnings: [String]
}

private struct DesktopResyncErrorResponse: Decodable {
    let error: String?
}

private enum ServerManagerError: LocalizedError {
    case projectRootNotFound
    case missingServerBuild(String)
    case missingWebBuild(String)
    case invalidNodeBinary(String)
    case nodeBinaryNotFound
    case invalidResyncURL
    case invalidResyncResponse
    case resyncHTTPStatus(Int)
    case resyncRequestFailed(String)
    case noAvailablePort(startPort: Int)

    var errorDescription: String? {
        switch self {
        case .projectRootNotFound:
            return
                "PocketDex runtime not found. Reinstall PocketDex, or set POCKETDEX_PROJECT_ROOT in your Xcode scheme."
        case .missingServerBuild(let expectedPath):
            return "Server build not found at \(expectedPath). Run: npm run build (in /server)."
        case .missingWebBuild(let rootPath):
            return "Web static build missing under \(rootPath). Run: npm run build (in /web)."
        case .invalidNodeBinary(let configuredPath):
            return "POCKETDEX_NODE_BIN points to an invalid executable: \(configuredPath)"
        case .nodeBinaryNotFound:
            return "Node.js binary not found. Set POCKETDEX_NODE_BIN in the Xcode scheme, or embed node in the app bundle."
        case .invalidResyncURL:
            return "Invalid Codex relaunch URL."
        case .invalidResyncResponse:
            return "Invalid Codex relaunch response."
        case .resyncHTTPStatus(let code):
            return "Codex relaunch failed (HTTP \(code))."
        case .resyncRequestFailed(let message):
            return message
        case .noAvailablePort(let startPort):
            return "No free TCP port found from \(startPort) to 65535."
        }
    }
}
