//
//  PocketDexAppApp.swift
//  PocketDexApp
//
//  Created by Valence on 06/02/2026.
//

import SwiftUI

@main
struct PocketDexAppApp: App {
    @StateObject private var serverManager = ServerManager()
    @StateObject private var sparkleUpdater = SparkleUpdaterController()
    @StateObject private var codexAccountsManager = CodexAccountsManager()

    var body: some Scene {
        MenuBarExtra {
            MenuBarContentView(
                serverManager: serverManager,
                sparkleUpdater: sparkleUpdater,
                codexAccountsManager: codexAccountsManager
            )
        } label: {
            Image("MenuBarIcon")
                .renderingMode(.template)
        }
        .menuBarExtraStyle(.window)

        Window("Codex Accounts", id: "codex-accounts") {
            CodexAccountsSheetView(
                accountsManager: codexAccountsManager,
                serverManager: serverManager
            )
        }
        .defaultSize(width: 620, height: 320)
        .windowResizability(.contentSize)
    }
}
