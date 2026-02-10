import Foundation
import Combine

@MainActor
final class AppSettingsStore: ObservableObject {
    @Published var serverConfiguration: ServerConfiguration? {
        didSet { persistIfReady() }
    }
    @Published var defaultWorkspacePath: String {
        didSet { persistIfReady() }
    }
    @Published var codexPreferences: PocketDexCodexPreferences {
        didSet { persistIfReady() }
    }

    private struct PersistedSettings: Codable {
        var serverConfiguration: ServerConfiguration?
        var defaultWorkspacePath: String
        var codexPreferences: PocketDexCodexPreferences?
    }

    private let defaults: UserDefaults
    private let storageKey = "pocketdex.mobile.settings.v1"
    private var isHydrating = true

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.serverConfiguration = nil
        self.defaultWorkspacePath = ""
        self.codexPreferences = .default
        load()
        isHydrating = false
    }

    func update(serverConfiguration: ServerConfiguration, defaultWorkspacePath: String) {
        self.serverConfiguration = serverConfiguration
        self.defaultWorkspacePath = defaultWorkspacePath.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func update(serverConfiguration: ServerConfiguration) {
        self.serverConfiguration = serverConfiguration
    }

    func clearServerConfiguration() {
        serverConfiguration = nil
    }

    func update(codexPreferences: PocketDexCodexPreferences) {
        self.codexPreferences = codexPreferences
    }

    private func load() {
        guard let data = defaults.data(forKey: storageKey) else { return }
        do {
            let decoded = try JSONDecoder().decode(PersistedSettings.self, from: data)
            serverConfiguration = decoded.serverConfiguration
            defaultWorkspacePath = decoded.defaultWorkspacePath
            codexPreferences = decoded.codexPreferences ?? .default
        } catch {
            serverConfiguration = nil
            defaultWorkspacePath = ""
            codexPreferences = .default
        }
    }

    private func persistIfReady() {
        guard !isHydrating else { return }
        let payload = PersistedSettings(
            serverConfiguration: serverConfiguration,
            defaultWorkspacePath: defaultWorkspacePath,
            codexPreferences: codexPreferences
        )
        do {
            let encoded = try JSONEncoder().encode(payload)
            defaults.set(encoded, forKey: storageKey)
        } catch {
            // Ignore persistence failures to avoid interrupting runtime use.
        }
    }
}
