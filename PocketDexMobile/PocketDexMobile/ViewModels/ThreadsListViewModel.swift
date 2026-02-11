import Foundation
import Combine

@MainActor
final class ThreadsListViewModel: ObservableObject {
    enum ConnectionState {
        case idle
        case checking
        case connected
        case failed
    }

    private struct PendingThreadHydration {
        var thread: PocketDexThreadSummary
        var expiresAt: Date
    }

    @Published private(set) var threads: [PocketDexThreadSummary] = []
    @Published private(set) var workspaceRoots: [String] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isCreatingThread = false
    @Published private(set) var isCreatingProject = false
    @Published private(set) var connectionState: ConnectionState = .idle
    @Published private(set) var serverDeviceName: String?
    @Published private(set) var isRetryingConnection = false
    @Published private(set) var projectOrderIDs: [String] = []
    @Published private(set) var archivingThreadIDs: Set<String> = []
    @Published var errorMessage: String?

    private let apiClient: PocketDexAPIClient
    private var configuration: ServerConfiguration?
    private var pollingTask: Task<Void, Never>?
    private var deferredRefreshTask: Task<Void, Never>?
    private var streamClient: PocketDexStreamClient?
    private var storedSeqByThreadID: [String: Int] = [:]
    private var pendingThreadHydrationByID: [String: PendingThreadHydration] = [:]
    private static let streamRefreshDelayNanos: UInt64 = 220_000_000
    private static let pendingThreadHydrationWindow: TimeInterval = 45
    private var isRefreshInFlight = false
    private let idlePollingIntervalNanos: UInt64 = 60_000_000_000
    private let activePollingIntervalNanos: UInt64 = 20_000_000_000
    nonisolated private static let threadSeqStorePrefix = "pocketdex.stream.seq."

    init(apiClient: PocketDexAPIClient) {
        self.apiClient = apiClient
    }

    deinit {
        pollingTask?.cancel()
        deferredRefreshTask?.cancel()
    }

    var connectionLabel: String {
        switch connectionState {
        case .idle:
            return "Not configured"
        case .checking:
            return "Connecting..."
        case .connected:
            return "Connected"
        case .failed:
            return "Connection failed"
        }
    }

    func setConfiguration(_ configuration: ServerConfiguration?) {
        guard self.configuration != configuration else { return }
        self.configuration = configuration
        pollingTask?.cancel()
        pollingTask = nil
        deferredRefreshTask?.cancel()
        deferredRefreshTask = nil
        streamClient?.disconnect()
        streamClient = nil
        pendingThreadHydrationByID = [:]
        threads = []
        workspaceRoots = []
        projectOrderIDs = []
        archivingThreadIDs = []
        serverDeviceName = nil
        errorMessage = nil
        connectionState = configuration == nil ? .idle : .checking
        guard configuration != nil else { return }
        startPolling()
    }

    func refresh(
        showLoader: Bool,
        showCheckingState: Bool = false,
        minimumCheckingDuration: TimeInterval = 0
    ) async {
        guard let configuration else { return }
        guard !isRefreshInFlight else { return }
        isRefreshInFlight = true

        let startedAt = Date()
        if showLoader {
            isLoading = true
        }
        if showCheckingState {
            connectionState = .checking
            isRetryingConnection = true
        }
        defer {
            isLoading = false
            isRefreshInFlight = false
        }

        do {
            let health = try await apiClient.checkHealth(config: configuration)
            connectionState = health.ok ? .connected : .failed
            serverDeviceName = Self.normalizedServerName(health.deviceName)
        } catch {
            connectionState = .failed
            serverDeviceName = nil
        }

        do {
            let fetchedThreads = try await apiClient.listThreads(config: configuration)
            let hydratedThreads = mergeThreadsWithPendingHydration(fetchedThreads)
            threads = hydratedThreads.map(ThreadRunOptimismStore.apply(to:))
            syncStreamSubscriptions()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
            if threads.isEmpty {
                threads = []
            }
        }

        do {
            workspaceRoots = try await apiClient.listWorkspaceRoots(config: configuration)
        } catch {
            workspaceRoots = Self.workspaceRootsFromThreads(threads)
        }

        if showCheckingState {
            let elapsed = Date().timeIntervalSince(startedAt)
            let remaining = minimumCheckingDuration - elapsed
            if remaining > 0 {
                let nanos = UInt64(max(0, remaining) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: nanos)
            }
            isRetryingConnection = false
        }
    }

    func retryConnection() async {
        await refresh(showLoader: false, showCheckingState: true, minimumCheckingDuration: 1.5)
    }

    func handleAppBecameActive() async {
        guard configuration != nil else { return }
        streamClient?.disconnect()
        streamClient = nil
        connectStream()
        await refresh(showLoader: false)
    }

    func applyOptimisticRunMarkers() {
        guard !threads.isEmpty else { return }
        let updated = threads.map(ThreadRunOptimismStore.apply(to:))
        if updated != threads {
            threads = updated
        }
    }

    func createThread(
        cwd: String,
        securityOptions: PocketDexAPIClient.ThreadStartSecurityOptions? = nil
    ) async -> PocketDexThreadSummary? {
        let trimmed = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            errorMessage = "Workspace path is required."
            return nil
        }
        guard let configuration else {
            errorMessage = "Configure your server before creating a thread."
            return nil
        }
        isCreatingThread = true
        defer { isCreatingThread = false }
        do {
            let created = try await apiClient.createThread(
                cwd: trimmed,
                securityOptions: securityOptions,
                config: configuration
            )
            let optimistic = normalizedThreadForImmediateInsertion(created, fallbackCwd: trimmed)
            rememberPendingThreadHydration(optimistic)
            insertOrUpdateThread(optimistic)
            includeWorkspaceRoot(trimmed)
            syncStreamSubscriptions()
            errorMessage = nil
            Task { [weak self] in
                await self?.refresh(showLoader: false)
            }
            return optimistic
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func createProject(name: String) async -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            errorMessage = "Project name is required."
            return nil
        }
        guard let configuration else {
            errorMessage = "Configure your server before creating a project."
            return nil
        }
        isCreatingProject = true
        defer { isCreatingProject = false }
        do {
            let project = try await apiClient.createProject(name: trimmed, config: configuration)
            let normalizedPath = project.path.trimmingCharacters(in: .whitespacesAndNewlines)
            errorMessage = nil
            if !normalizedPath.isEmpty {
                var updatedRoots = Set(workspaceRoots)
                updatedRoots.insert(normalizedPath)
                workspaceRoots = Array(updatedRoots).sorted()
            }
            await refresh(showLoader: false)
            return normalizedPath.isEmpty ? nil : normalizedPath
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func archiveThread(_ thread: PocketDexThreadSummary) async -> Bool {
        let threadID = thread.id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !threadID.isEmpty else { return false }
        guard let configuration else {
            errorMessage = "Configure your server before archiving a thread."
            return false
        }
        if archivingThreadIDs.contains(threadID) {
            return false
        }
        archivingThreadIDs.insert(threadID)
        defer {
            archivingThreadIDs.remove(threadID)
        }
        do {
            _ = try await apiClient.archiveThread(threadID: threadID, config: configuration)
            streamClient?.unsubscribe(threadID: threadID)
            pendingThreadHydrationByID.removeValue(forKey: threadID)
            storedSeqByThreadID.removeValue(forKey: threadID)
            let key = Self.threadSeqStorePrefix + threadID
            UserDefaults.standard.removeObject(forKey: key)
            threads.removeAll { $0.id == threadID }
            syncStreamSubscriptions()
            errorMessage = nil
            Task { [weak self] in
                await self?.refresh(showLoader: false)
            }
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func persistProjectOrder(_ orderIDs: [String]) async {
        let normalized = Self.normalizeProjectOrder(orderIDs)
        projectOrderIDs = normalized
        guard let configuration else { return }
        do {
            let persisted = try await apiClient.updateProjectOrder(order: normalized, config: configuration)
            projectOrderIDs = Self.normalizeProjectOrder(persisted)
        } catch {
            // Non-fatal: keep local ordering even if server persistence fails.
        }
    }

    private func startPolling() {
        pollingTask = Task { [weak self] in
            guard let self else { return }
            guard let configuration else { return }
            connectStream()
            await loadProjectOrder(config: configuration)
            await refresh(showLoader: true)
            while !Task.isCancelled {
                let interval = threads.contains(where: \.isActive)
                    ? activePollingIntervalNanos
                    : idlePollingIntervalNanos
                try? await Task.sleep(nanoseconds: interval)
                if Task.isCancelled { break }
                await refresh(showLoader: false)
            }
        }
    }

    private func connectStream() {
        guard let configuration else { return }
        let stream = PocketDexStreamClient()
        stream.onEvent = { [weak self] event in
            guard let self else { return }
            self.handleStreamEvent(event)
        }
        streamClient = stream
        stream.connect(config: configuration)
        syncStreamSubscriptions()
    }

    private func syncStreamSubscriptions() {
        guard streamClient != nil else { return }
        for thread in threads {
            let storedSeq = lastStoredSeq(for: thread.id)
            streamClient?.subscribe(
                threadID: thread.id,
                resume: true,
                resumeFrom: storedSeq > 0 ? storedSeq : nil
            )
        }
    }

    private func handleStreamEvent(_ event: PocketDexStreamEvent) {
        switch event {
        case .connected:
            syncStreamSubscriptions()
            Task { [weak self] in
                guard let self else { return }
                await refresh(showLoader: false)
            }
        case .disconnected:
            break
        case .error:
            break
        case let .threadSync(threadID: threadID, latestSeq: latestSeq):
            rememberSeq(latestSeq, threadID: threadID)
        case let .threadSnapshot(threadID: threadID, seqBase: seqBase, thread: _):
            rememberSeq(seqBase, threadID: threadID)
            scheduleDeferredRefresh()
        case let .notification(method, params, seq, threadID: eventThreadID):
            let resolvedThreadID = eventThreadID ?? Self.extractThreadID(from: params)
            if let resolvedThreadID, let seq {
                let previous = lastStoredSeq(for: resolvedThreadID)
                if seq <= previous {
                    return
                }
                if previous > 0 && seq > previous + 1 {
                    streamClient?.subscribe(threadID: resolvedThreadID, resume: true, resumeFrom: previous)
                    return
                }
                rememberSeq(seq, threadID: resolvedThreadID)
            }

            if method.hasPrefix("turn/") || method.hasPrefix("item/") || method.hasPrefix("thread/") || method == "pocketdex/external-run-state" {
                scheduleDeferredRefresh()
            }
        case .request:
            break
        }
    }

    private func scheduleDeferredRefresh() {
        if deferredRefreshTask != nil { return }
        deferredRefreshTask = Task { [weak self] in
            guard let self else { return }
            defer { self.deferredRefreshTask = nil }
            try? await Task.sleep(nanoseconds: Self.streamRefreshDelayNanos)
            if Task.isCancelled { return }
            await self.refresh(showLoader: false)
        }
    }

    private func mergeThreadsWithPendingHydration(_ fetchedThreads: [PocketDexThreadSummary]) -> [PocketDexThreadSummary] {
        let now = Date()
        pendingThreadHydrationByID = pendingThreadHydrationByID.filter { _, value in
            value.expiresAt > now
        }

        for thread in fetchedThreads {
            pendingThreadHydrationByID.removeValue(forKey: thread.id)
        }

        var merged = fetchedThreads
        let knownIDs = Set(fetchedThreads.map(\.id))
        for pending in pendingThreadHydrationByID.values where !knownIDs.contains(pending.thread.id) {
            merged.append(pending.thread)
        }
        merged.sort { lhs, rhs in
            (lhs.updatedAt ?? 0) > (rhs.updatedAt ?? 0)
        }
        return merged
    }

    private func rememberPendingThreadHydration(_ thread: PocketDexThreadSummary) {
        pendingThreadHydrationByID[thread.id] = PendingThreadHydration(
            thread: thread,
            expiresAt: Date().addingTimeInterval(Self.pendingThreadHydrationWindow)
        )
    }

    private func insertOrUpdateThread(_ thread: PocketDexThreadSummary) {
        if let index = threads.firstIndex(where: { $0.id == thread.id }) {
            threads[index] = thread
        } else {
            threads.append(thread)
        }
        threads.sort { lhs, rhs in
            (lhs.updatedAt ?? 0) > (rhs.updatedAt ?? 0)
        }
    }

    private func includeWorkspaceRoot(_ cwd: String) {
        let normalized = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return }
        var roots = Set(workspaceRoots)
        if roots.insert(normalized).inserted {
            workspaceRoots = Array(roots).sorted()
        }
    }

    private func normalizedThreadForImmediateInsertion(
        _ thread: PocketDexThreadSummary,
        fallbackCwd: String
    ) -> PocketDexThreadSummary {
        let normalizedCwd = thread.cwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? fallbackCwd
            : thread.cwd
        let fallbackTimestamp = Date().timeIntervalSince1970
        let normalizedUpdatedAt = thread.updatedAt ?? thread.createdAt ?? fallbackTimestamp
        let normalizedCreatedAt = thread.createdAt ?? normalizedUpdatedAt
        return PocketDexThreadSummary(
            id: thread.id,
            title: thread.title,
            preview: thread.preview,
            modelProvider: thread.modelProvider,
            createdAt: normalizedCreatedAt,
            updatedAt: normalizedUpdatedAt,
            path: thread.path,
            cwd: normalizedCwd,
            cliVersion: thread.cliVersion,
            externalRun: thread.externalRun
        )
    }

    private func lastStoredSeq(for threadID: String) -> Int {
        if let cached = storedSeqByThreadID[threadID] {
            return cached
        }
        let key = Self.threadSeqStorePrefix + threadID
        let value = max(0, UserDefaults.standard.integer(forKey: key))
        storedSeqByThreadID[threadID] = value
        return value
    }

    private func rememberSeq(_ seq: Int, threadID: String) {
        let normalizedSeq = max(0, seq)
        let previous = lastStoredSeq(for: threadID)
        if normalizedSeq <= previous { return }
        storedSeqByThreadID[threadID] = normalizedSeq
        let key = Self.threadSeqStorePrefix + threadID
        UserDefaults.standard.set(normalizedSeq, forKey: key)
    }

    private func loadProjectOrder(config: ServerConfiguration) async {
        do {
            let order = try await apiClient.fetchProjectOrder(config: config)
            projectOrderIDs = Self.normalizeProjectOrder(order)
        } catch {
            // Ignore project-order hydration errors; ordering can still be changed locally.
        }
    }

    private static func normalizeProjectOrder(_ orderIDs: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for entry in orderIDs {
            let trimmed = entry.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || seen.contains(trimmed) {
                continue
            }
            seen.insert(trimmed)
            result.append(trimmed)
        }
        return result
    }

    private static func normalizedServerName(_ rawName: String?) -> String? {
        guard let rawName else { return nil }
        var cleaned = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        if cleaned.lowercased().hasSuffix(".local") {
            cleaned = String(cleaned.dropLast(6))
        }
        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func workspaceRootsFromThreads(_ threads: [PocketDexThreadSummary]) -> [String] {
        let values = threads
            .map { $0.cwd.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return Array(Set(values)).sorted()
    }

    private static func extractThreadID(from payload: [String: Any]) -> String? {
        if let threadID = payload["threadId"] as? String {
            let trimmed = threadID.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        if let threadID = payload["thread_id"] as? String {
            let trimmed = threadID.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        if let msg = payload["msg"] as? [String: Any] {
            if let threadID = msg["threadId"] as? String {
                let trimmed = threadID.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
            if let threadID = msg["thread_id"] as? String {
                let trimmed = threadID.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
        }
        return nil
    }
}
