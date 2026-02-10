import SwiftUI
import UIKit

struct ServerSetupView: View {
    enum Mode {
        case onboarding
        case inApp
    }

    let mode: Mode

    @EnvironmentObject private var settingsStore: AppSettingsStore
    @Environment(\.dismiss) private var dismiss

    @State private var host = ""
    @State private var port = "8787"
    @State private var validationMessage: String?
    @State private var isTailscaleInstalled = false

    var body: some View {
        ZStack {
            PocketDexBackground()

            ScrollView {
                VStack(spacing: mode == .onboarding ? 14 : 10) {
                    if mode == .onboarding {
                        header
                    }
                    formCard
                }
                .padding(.horizontal, mode == .onboarding ? 18 : 14)
                .padding(.vertical, mode == .onboarding ? 20 : 12)
            }
        }
        .navigationTitle("Serveur")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarBackground(PocketDexTheme.backgroundTop.opacity(0.96), for: .navigationBar)
        .tint(.white)
        .toolbar {
            if mode == .inApp {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Fermer") {
                        dismiss()
                    }
                }
            }
        }
        .onAppear {
            hydrateFromStoredSettings()
            refreshTailscaleAvailability()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Connexion serveur")
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundStyle(.white.opacity(0.96))
            Text("Renseigne l'adresse IP/hostname et le port.")
                .font(.system(size: 14, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.72))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var formCard: some View {
        VStack(spacing: mode == .onboarding ? 16 : 14) {
            VStack(spacing: 14) {
                labeledField("Adresse IP / Host") {
                    TextField("192.168.1.10 ou mon-serveur.local", text: $host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }

                tailscaleShortcutButton

                labeledField("Port") {
                    TextField("8787", text: $port)
                        .keyboardType(.numberPad)
                }
            }

            if let validationMessage, !validationMessage.isEmpty {
                statusLine(text: validationMessage, color: .red.opacity(0.9))
            }

            Button {
                saveConfiguration()
            } label: {
                Text(mode == .onboarding ? "Continuer" : "Sauvegarder")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.black.opacity(0.9))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(
                                LinearGradient(
                                    colors: [
                                        Color.white.opacity(0.97),
                                        Color(red: 0.90, green: 0.90, blue: 0.92).opacity(0.93),
                                    ],
                                    startPoint: .top,
                                    endPoint: .bottom
                                )
                            )
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(Color.white.opacity(0.34), lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
        }
        .padding(mode == .onboarding ? 16 : 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: mode == .onboarding ? 20 : 16, style: .continuous)
                .fill(PocketDexTheme.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: mode == .onboarding ? 20 : 16, style: .continuous)
                .stroke(PocketDexTheme.border, lineWidth: 1)
        )
    }

    private func labeledField<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white.opacity(0.78))
            content()
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.black.opacity(0.56),
                                    Color.black.opacity(0.44),
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                )
                .foregroundStyle(.white.opacity(0.95))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Color.white.opacity(0.20), lineWidth: 1)
                )
        }
    }

    private func statusLine(text: String, color: Color) -> some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var tailscaleShortcutButton: some View {
        Button {
            openTailscaleApp()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "arrow.up.right.app")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.9))
                Text(isTailscaleInstalled ? "Open Tailscale" : "Install Tailscale")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.95))
                Image("TailscaleIcon")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 13, height: 13)
                    .accessibilityHidden(true)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.white.opacity(0.65))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.black.opacity(0.80),
                                Color.black.opacity(0.68),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.white.opacity(0.28), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.32), radius: 8, x: 0, y: 4)
        }
        .buttonStyle(.plain)
    }

    private func hydrateFromStoredSettings() {
        if let current = settingsStore.serverConfiguration {
            host = current.host
            port = String(current.port)
        } else {
            host = ""
            port = "8787"
        }
    }

    private func makeConfiguration() throws -> ServerConfiguration {
        let parsedPort = Int(port.trimmingCharacters(in: .whitespacesAndNewlines)) ?? -1
        let resolvedScheme = ServerConfiguration.inferredScheme(for: host)
        return try ServerConfiguration(
            scheme: resolvedScheme,
            host: host,
            port: parsedPort
        ).validated()
    }

    private func saveConfiguration() {
        validationMessage = nil
        do {
            let config = try makeConfiguration()
            settingsStore.update(serverConfiguration: config)
            if mode == .inApp {
                dismiss()
            }
        } catch {
            validationMessage = error.localizedDescription
        }
    }

    private func refreshTailscaleAvailability() {
        guard let appURL = URL(string: "tailscale://") else {
            isTailscaleInstalled = false
            return
        }
        isTailscaleInstalled = UIApplication.shared.canOpenURL(appURL)
    }

    private func openTailscaleApp() {
        let appURL = URL(string: "tailscale://")
        let appStoreURL = URL(string: "https://apps.apple.com/app/tailscale/id1470499037")

        if let appURL, UIApplication.shared.canOpenURL(appURL) {
            UIApplication.shared.open(appURL, options: [:], completionHandler: nil)
        } else if let appStoreURL {
            UIApplication.shared.open(appStoreURL, options: [:], completionHandler: nil)
        }
    }
}
