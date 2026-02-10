import SwiftUI

@main
struct PocketDexMobileApp: App {
    @StateObject private var settingsStore = AppSettingsStore()
    private let apiClient = PocketDexAPIClient()

    var body: some Scene {
        WindowGroup {
            RootView(apiClient: apiClient)
                .environmentObject(settingsStore)
                .preferredColorScheme(.dark)
        }
    }
}
