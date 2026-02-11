import Foundation

enum ThreadRunOptimismStore {
    private static let userDefaultsKeyPrefix = "pocketdex.thread.optimistic-run."
    private static let defaultTTL: TimeInterval = 20

    static func markActive(threadID: String, ttl: TimeInterval = defaultTTL) {
        let expiry = Date().addingTimeInterval(max(1, ttl)).timeIntervalSince1970
        UserDefaults.standard.set(expiry, forKey: key(for: threadID))
    }

    static func clear(threadID: String) {
        UserDefaults.standard.removeObject(forKey: key(for: threadID))
    }

    static func isActive(threadID: String) -> Bool {
        let key = key(for: threadID)
        let expiry = UserDefaults.standard.double(forKey: key)
        guard expiry > 0 else { return false }
        if expiry <= Date().timeIntervalSince1970 {
            UserDefaults.standard.removeObject(forKey: key)
            return false
        }
        return true
    }

    static func apply(to thread: PocketDexThreadSummary) -> PocketDexThreadSummary {
        if thread.isActive {
            return thread
        }
        guard isActive(threadID: thread.id) else {
            return thread
        }
        return PocketDexThreadSummary(
            id: thread.id,
            title: thread.title,
            preview: thread.preview,
            modelProvider: thread.modelProvider,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            path: thread.path,
            cwd: thread.cwd,
            cliVersion: thread.cliVersion,
            externalRun: PocketDexExternalRun(active: true)
        )
    }

    private static func key(for threadID: String) -> String {
        userDefaultsKeyPrefix + threadID
    }
}
