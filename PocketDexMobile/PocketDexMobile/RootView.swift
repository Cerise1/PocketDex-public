import SwiftUI

struct RootView: View {
    let apiClient: PocketDexAPIClient
    @EnvironmentObject private var settingsStore: AppSettingsStore
    @State private var showLaunchSplash = true
    @State private var launchProgress: CGFloat = 0.04

    var body: some View {
        ZStack {
            mainContent
                .opacity(showLaunchSplash ? 0 : 1)

            if showLaunchSplash {
                LaunchSplashView(progress: launchProgress)
                    .transition(.opacity)
            }
        }
        .task {
            await runLaunchSplash()
        }
        .animation(.easeOut(duration: 0.28), value: showLaunchSplash)
    }

    private var mainContent: some View {
        Group {
            if settingsStore.serverConfiguration == nil {
                NavigationStack {
                    ServerSetupView(mode: .onboarding)
                }
            } else {
                ThreadsListView(apiClient: apiClient)
            }
        }
        .animation(.snappy, value: settingsStore.serverConfiguration != nil)
    }

    @MainActor
    private func runLaunchSplash() async {
        guard showLaunchSplash else { return }
        withAnimation(.timingCurve(0.22, 1, 0.36, 1, duration: 1.55)) {
            launchProgress = 1
        }
        try? await Task.sleep(nanoseconds: 1_650_000_000)
        guard !Task.isCancelled else { return }
        withAnimation(.easeOut(duration: 0.28)) {
            showLaunchSplash = false
        }
    }
}
