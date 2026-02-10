import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ThreadsListView: View {
    private struct ProjectGroup: Identifiable {
        let id: String
        let cwd: String
        let header: String
        let threads: [PocketDexThreadSummary]
    }

    private enum ProjectDropPosition {
        case before
        case after
    }

    private struct ProjectDropTarget: Equatable {
        let id: String
        let position: ProjectDropPosition
    }

    private let projectThreadViewportCount = 4
    private let projectThreadRowHeight: CGFloat = 96
    private let projectThreadViewportVerticalPadding: CGFloat = 8

    let apiClient: PocketDexAPIClient

    @EnvironmentObject private var settingsStore: AppSettingsStore
    @StateObject private var viewModel: ThreadsListViewModel
    @State private var showServerPopup = false
    @State private var showProjectPopup = false
    @State private var showDevServerPopup = false
    @State private var showCodexSettingsPopup = false
    @State private var serverHostDraft = ""
    @State private var serverPortDraft = "8787"
    @State private var serverValidationMessage: String?
    @State private var devServerPortDraft = ""
    @State private var devServerValidationMessage: String?
    @State private var codexSettingsDraft = PocketDexCodexPreferences.default
    @State private var codexSettingsValidationMessage: String?
    @State private var isSavingCodexSettings = false
    @State private var projectNameDraft = ""
    @State private var projectValidationMessage: String?
    @State private var isTailscaleInstalled = false
    @State private var collapsedProjectIDs: Set<String> = []
    @State private var pushedThread: PocketDexThreadSummary?
    @State private var groupedThreadsCache: [ProjectGroup] = []
    @State private var availableProjectGroupsCache: [ProjectGroup] = []
    @State private var unreadCompletedThreadIDs: Set<String> = []
    @State private var previousActiveByThreadID: [String: Bool] = [:]
    @State private var hasInitializedActivityTracking = false
    @State private var activeConversationThreadID: String?
    @State private var projectOrderIDs: [String] = []
    @State private var hasHydratedLocalProjectOrder = false
    @State private var draggingProjectID: String?
    @State private var liftedProjectID: String?
    @State private var projectDropTarget: ProjectDropTarget?

    private let projectOrderStorageKey = "pocketdex.mobile.project-order.v1"
    private let commonDevServerPorts = ["3000", "3001", "3002", "5173", "8080"]

    init(apiClient: PocketDexAPIClient) {
        self.apiClient = apiClient
        _viewModel = StateObject(wrappedValue: ThreadsListViewModel(apiClient: apiClient))
    }

    private struct ProjectHeaderDropDelegate: DropDelegate {
        let targetProjectID: String
        @Binding var draggingProjectID: String?
        @Binding var liftedProjectID: String?
        @Binding var projectDropTarget: ProjectDropTarget?
        let reorderPreview: (_ draggedProjectID: String, _ targetProjectID: String, _ position: ProjectDropPosition) -> Void
        let commitOrder: () -> Void

        func dropEntered(info: DropInfo) {
            updateDropState(with: info)
        }

        func dropUpdated(info: DropInfo) -> DropProposal? {
            updateDropState(with: info)
            return DropProposal(operation: .move)
        }

        func dropExited(info: DropInfo) {
            if projectDropTarget?.id == targetProjectID {
                projectDropTarget = nil
            }
        }

        func performDrop(info: DropInfo) -> Bool {
            updateDropState(with: info)
            commitOrder()
            draggingProjectID = nil
            liftedProjectID = nil
            projectDropTarget = nil
            return true
        }

        private func updateDropState(with info: DropInfo) {
            guard let draggedProjectID = draggingProjectID else { return }
            guard draggedProjectID != targetProjectID else { return }
            let position: ProjectDropPosition = info.location.y < 22 ? .before : .after
            let nextTarget = ProjectDropTarget(id: targetProjectID, position: position)
            if projectDropTarget != nextTarget {
                projectDropTarget = nextTarget
            }
            reorderPreview(draggedProjectID, targetProjectID, position)
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                PocketDexBackground()

                VStack(spacing: 0) {
                    topHeader
                    threadsList
                }

                if showServerPopup {
                    serverPopupOverlay
                }

                if showDevServerPopup {
                    devServerPopupOverlay
                }

                if showCodexSettingsPopup {
                    codexSettingsPopupOverlay
                }

                if showProjectPopup {
                    projectPopupOverlay
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .refreshable {
                await viewModel.retryConnection()
            }
            .navigationDestination(item: $pushedThread) { thread in
                ThreadConversationView(threadSummary: thread, apiClient: apiClient)
                    .onAppear {
                        activeConversationThreadID = thread.id
                        markThreadAsRead(thread.id)
                    }
                    .onDisappear {
                        if activeConversationThreadID == thread.id {
                            activeConversationThreadID = nil
                        }
                    }
            }
            .task(id: settingsStore.serverConfiguration) {
                viewModel.setConfiguration(settingsStore.serverConfiguration)
                await hydrateCodexPreferencesFromServer()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
                Task { await viewModel.handleAppBecameActive() }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                Task { await viewModel.handleAppBecameActive() }
            }
            .onAppear {
                hydrateLocalProjectOrderIfNeeded()
                viewModel.applyOptimisticRunMarkers()
                rebuildProjectGroups()
                updateUnreadCompletedNotifications(with: viewModel.threads)
                codexSettingsDraft = settingsStore.codexPreferences
            }
            .onChange(of: viewModel.threads) { _, _ in
                rebuildProjectGroups()
                updateUnreadCompletedNotifications(with: viewModel.threads)
            }
            .onChange(of: viewModel.workspaceRoots) { _, _ in
                rebuildProjectGroups()
            }
            .onChange(of: viewModel.projectOrderIDs) { _, incomingOrder in
                applyIncomingProjectOrder(incomingOrder)
            }
            .onChange(of: projectOrderIDs) { _, nextOrder in
                persistProjectOrderLocally(nextOrder)
            }
            .onChange(of: draggingProjectID) { _, nextDraggingProjectID in
                if nextDraggingProjectID == nil && projectDropTarget == nil && liftedProjectID != nil {
                    withAnimation(.interactiveSpring(response: 0.18, dampingFraction: 0.92)) {
                        liftedProjectID = nil
                    }
                }
            }
            .onChange(of: settingsStore.codexPreferences) { _, nextPreferences in
                if !showCodexSettingsPopup {
                    codexSettingsDraft = nextPreferences
                }
            }
        }
    }

    private var threadsList: some View {
        List {
            connectionCard
                .listRowBackground(PocketDexTheme.surface)
                .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))

            devServerCard
                .listRowBackground(PocketDexTheme.surface)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 10, trailing: 16))

            if let errorMessage = viewModel.errorMessage, !errorMessage.isEmpty {
                Section {
                    Text(errorMessage)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.red)
                }
                .listRowBackground(PocketDexTheme.surface)
                .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
            }

            if viewModel.isLoading && viewModel.threads.isEmpty {
                Section {
                    HStack {
                        Spacer()
                        PocketDexWebSpinner(size: 16, lineWidth: 2.0, color: .white.opacity(0.72))
                        Spacer()
                    }
                }
                .listRowBackground(PocketDexTheme.surface)
                .listRowInsets(EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16))
            } else if groupedThreadsCache.isEmpty {
                Section("Threads") {
                    Text("No threads available right now.")
                        .font(.body)
                        .foregroundStyle(PocketDexTheme.secondaryText)
                }
                .listRowBackground(PocketDexTheme.surface)
                .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
            } else {
                ForEach(groupedThreadsCache) { group in
                    Section {
                        if !isProjectCollapsed(group) {
                            if group.threads.isEmpty {
                                emptyProjectStateRow(for: group)
                                    .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 12, trailing: 16))
                            } else {
                                projectThreadsScrollBox(for: group)
                                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 10, trailing: 16))
                            }
                        }
                    } header: {
                        projectHeaderWithReordering(group)
                            .textCase(nil)
                    }
                    .listRowBackground(PocketDexTheme.surface)
                }
            }

            Section {
                Button {
                    openProjectPopup()
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "folder.badge.plus")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.9))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(viewModel.isCreatingProject ? "Creating project..." : "New Project")
                                .font(.system(size: 16, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white.opacity(0.94))
                            Text("Create a new project folder on your server.")
                                .font(.system(size: 13, weight: .regular, design: .rounded))
                                .foregroundStyle(PocketDexTheme.secondaryText)
                                .lineLimit(2)
                        }
                        Spacer()
                    }
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isCreatingProject)
                .opacity(viewModel.isCreatingProject ? 0.6 : 1)
            }
            .listRowBackground(PocketDexTheme.surface)
            .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 12, trailing: 16))
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .contentMargins(.horizontal, 20, for: .scrollContent)
        .listRowSeparatorTint(PocketDexTheme.border)
        .tint(.white)
    }

    private var topHeader: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .center, spacing: 12) {
                Text("PocketDex")
                    .font(.system(size: 44, weight: .semibold, design: .serif))
                    .tracking(-0.8)
                    .foregroundStyle(.white)
                    .lineLimit(1)

                Spacer()

                Button {
                    openCodexSettingsPopup()
                } label: {
                    topHeaderActionButton(systemName: "gearshape.fill")
                }
                .buttonStyle(.plain)
                .disabled(isSavingCodexSettings)
                .opacity(isSavingCodexSettings ? 0.45 : 1)

                Menu {
                    ForEach(availableProjectGroupsCache) { group in
                        Button {
                            createThread(for: group)
                        } label: {
                            Label(group.header, systemImage: "folder")
                        }
                    }

                    if !availableProjectGroupsCache.isEmpty {
                        Divider()
                    }

                    Button {
                        openProjectPopup()
                    } label: {
                        Label("New Project", systemImage: "folder.badge.plus")
                    }
                } label: {
                    topHeaderActionButton(systemName: "plus")
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isCreatingThread || viewModel.isCreatingProject)
                .opacity((viewModel.isCreatingThread || viewModel.isCreatingProject) ? 0.45 : 1)
            }

            if showProjectsSyncing {
                HStack(spacing: 6) {
                    SyncBlinkDot(
                        color: .white.opacity(0.64),
                        glowColor: .white.opacity(0.34),
                        size: 7
                    )
                    PocketDexWebSpinner(size: 11, lineWidth: 1.6, color: .white.opacity(0.68))
                    Text("Syncing your projects")
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(PocketDexTheme.secondaryText)
                }
                .padding(.leading, 2)
            }
        }
        .padding(.horizontal, 26)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }

    private func topHeaderActionButton(systemName: String) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(.white.opacity(0.92))
            .frame(width: 34, height: 34)
            .background(
                LinearGradient(
                    colors: [
                        Color.white.opacity(0.14),
                        Color.white.opacity(0.07),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                ),
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(PocketDexTheme.border, lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.24), radius: 8, y: 4)
    }

    private var showProjectsSyncing: Bool {
        viewModel.isLoading || viewModel.connectionState == .checking || viewModel.isRetryingConnection
    }

    @ViewBuilder
    private func projectHeaderWithReordering(_ group: ProjectGroup) -> some View {
        let isReorderable = isProjectReorderable(group)
        let isLifted = draggingProjectID == group.id || liftedProjectID == group.id
        let showDropBefore =
            projectDropTarget?.id == group.id &&
            projectDropTarget?.position == .before &&
            draggingProjectID != group.id
        let showDropAfter =
            projectDropTarget?.id == group.id &&
            projectDropTarget?.position == .after &&
            draggingProjectID != group.id

        let header = projectHeader(group)
            .scaleEffect(isLifted ? 1.035 : 1.0)
            .shadow(
                color: isLifted ? Color.black.opacity(0.26) : .clear,
                radius: isLifted ? 9 : 0,
                x: 0,
                y: isLifted ? 6 : 0
            )
            .animation(.interactiveSpring(response: 0.24, dampingFraction: 0.82), value: isLifted)
            .overlay(alignment: .top) {
                if showDropBefore {
                    Capsule(style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color(red: 0.52, green: 0.84, blue: 1.0).opacity(0.95),
                                    Color(red: 0.32, green: 0.73, blue: 1.0).opacity(0.95),
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(height: 4)
                        .padding(.horizontal, 4)
                        .shadow(color: Color(red: 0.35, green: 0.76, blue: 1.0).opacity(0.5), radius: 7, y: 1)
                        .offset(y: -2)
                }
            }
            .overlay(alignment: .bottom) {
                if showDropAfter {
                    Capsule(style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color(red: 0.52, green: 0.84, blue: 1.0).opacity(0.95),
                                    Color(red: 0.32, green: 0.73, blue: 1.0).opacity(0.95),
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(height: 4)
                        .padding(.horizontal, 4)
                        .shadow(color: Color(red: 0.35, green: 0.76, blue: 1.0).opacity(0.5), radius: 7, y: 1)
                        .offset(y: 2)
                }
            }

        if isReorderable {
            header
                .onLongPressGesture(
                    minimumDuration: 0.22,
                    maximumDistance: 16,
                    pressing: { pressing in
                        if pressing {
                            withAnimation(.interactiveSpring(response: 0.2, dampingFraction: 0.82)) {
                                liftedProjectID = group.id
                            }
                        } else if draggingProjectID != group.id && liftedProjectID == group.id {
                            withAnimation(.interactiveSpring(response: 0.18, dampingFraction: 0.92)) {
                                liftedProjectID = nil
                            }
                        }
                    },
                    perform: {}
                )
                .onDrag {
                    draggingProjectID = group.id
                    liftedProjectID = group.id
                    projectDropTarget = nil
                    return NSItemProvider(object: group.id as NSString)
                } preview: {
                    projectHeader(group)
                        .scaleEffect(1.04)
                }
                .onDrop(
                    of: [UTType.plainText.identifier],
                    delegate: ProjectHeaderDropDelegate(
                        targetProjectID: group.id,
                        draggingProjectID: $draggingProjectID,
                        liftedProjectID: $liftedProjectID,
                        projectDropTarget: $projectDropTarget,
                        reorderPreview: previewProjectReorder,
                        commitOrder: commitProjectOrderFromCurrentGroups
                    )
                )
        } else {
            header
        }
    }

    private func projectHeader(_ group: ProjectGroup) -> some View {
        let isCollapsed = isProjectCollapsed(group)
        let showCollapsedActivitySpinner = isCollapsed && group.threads.contains { $0.isActive }

        return HStack(spacing: 8) {
            Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(PocketDexTheme.secondaryText)
            Text(group.header)
                .font(.system(size: 18, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.92))
                .lineLimit(1)
            if showCollapsedActivitySpinner {
                PocketDexWebSpinner(size: 10, lineWidth: 1.5, color: .white.opacity(0.65))
                    .frame(width: 10, height: 10)
                    .accessibilityHidden(true)
            }
            Spacer()
            Text("\(group.threads.count)")
                .font(.footnote.monospacedDigit())
                .foregroundStyle(PocketDexTheme.secondaryText)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            toggleProjectCollapsed(group)
        }
        .accessibilityAddTraits(.isButton)
    }

    private func isProjectCollapsed(_ group: ProjectGroup) -> Bool {
        collapsedProjectIDs.contains(group.id)
    }

    private func toggleProjectCollapsed(_ group: ProjectGroup) {
        withAnimation(.easeInOut(duration: 0.2)) {
            if collapsedProjectIDs.contains(group.id) {
                collapsedProjectIDs.remove(group.id)
            } else {
                collapsedProjectIDs.insert(group.id)
            }
        }
    }

    private func projectThreadsScrollBox(for group: ProjectGroup) -> some View {
        let visibleRowCount = min(CGFloat(group.threads.count), CGFloat(projectThreadViewportCount))
        let viewportHeight = max(
            visibleRowCount * projectThreadRowHeight + projectThreadViewportVerticalPadding,
            projectThreadRowHeight
        )

        return ScrollView(.vertical, showsIndicators: group.threads.count > projectThreadViewportCount) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(group.threads.enumerated()), id: \.element.id) { index, thread in
                    NavigationLink {
                        ThreadConversationView(threadSummary: thread, apiClient: apiClient)
                            .onAppear {
                                activeConversationThreadID = thread.id
                                markThreadAsRead(thread.id)
                            }
                            .onDisappear {
                                if activeConversationThreadID == thread.id {
                                    activeConversationThreadID = nil
                                }
                            }
                    } label: {
                        threadRow(thread)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .frame(minHeight: projectThreadRowHeight, alignment: .topLeading)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .contentShape(Rectangle())
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .simultaneousGesture(
                        TapGesture().onEnded {
                            activeConversationThreadID = thread.id
                            markThreadAsRead(thread.id)
                        }
                    )
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) {
                            archiveThreadFromList(thread)
                        } label: {
                            Label("Archive", systemImage: "archivebox")
                        }
                    }
                    .buttonStyle(.plain)

                    if index < group.threads.count - 1 {
                        Divider()
                            .overlay(PocketDexTheme.border)
                            .padding(.leading, 24)
                    }
                }
            }
            .padding(.vertical, 4)
        }
        .frame(height: viewportHeight)
    }

    private func emptyProjectStateRow(for group: ProjectGroup) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("No threads yet")
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.84))
            Text("Create a new thread for \(group.header) with the + button.")
                .font(.system(size: 13, weight: .regular, design: .rounded))
                .foregroundStyle(PocketDexTheme.secondaryText)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
    }

    private var connectionCard: some View {
        Section {
            HStack(spacing: 12) {
                Button {
                    openServerPopup()
                } label: {
                    HStack(spacing: 12) {
                        connectionStatusIndicator
                            .frame(width: 9, height: 9)

                        VStack(alignment: .leading, spacing: 5) {
                            Text(viewModel.isRetryingConnection ? "Reconnecting..." : viewModel.connectionLabel)
                                .font(.system(size: 16, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white.opacity(0.95))

                            if !viewModel.isRetryingConnection,
                               let serverDeviceName = viewModel.serverDeviceName,
                               !serverDeviceName.isEmpty
                            {
                                Text(serverDeviceName)
                                    .font(.footnote)
                                    .foregroundStyle(PocketDexTheme.secondaryText)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)

                Button {
                    Task { await viewModel.retryConnection() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white.opacity(viewModel.isRetryingConnection ? 0.70 : 0.52))
                }
                .buttonStyle(.borderless)
                .disabled(viewModel.isRetryingConnection)
            }
            .padding(.vertical, 4)
        } header: {
            Text("Server")
                .font(.caption.weight(.semibold))
                .foregroundStyle(PocketDexTheme.secondaryText)
        }
    }

    private var devServerCard: some View {
        Section {
            Button {
                openDevServerPopup()
            } label: {
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: "safari")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.9))
                        .frame(width: 18, height: 18)

                    Text("Access dev server")
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.95))
                        .lineLimit(1)
                        .frame(maxHeight: .infinity, alignment: .center)

                    Spacer(minLength: 0)

                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.52))
                        .frame(width: 18, height: 18)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 42, alignment: .center)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(settingsStore.serverConfiguration == nil)
            .opacity(settingsStore.serverConfiguration == nil ? 0.55 : 1)
        } header: {
            Text("Dev Server")
                .font(.caption.weight(.semibold))
                .foregroundStyle(PocketDexTheme.secondaryText)
        }
    }

    @ViewBuilder
    private var connectionStatusIndicator: some View {
        if viewModel.connectionState == .checking || viewModel.isRetryingConnection {
            SyncBlinkDot(
                color: .white.opacity(0.58),
                glowColor: .white.opacity(0.32),
                size: 9
            )
        } else {
            Circle()
                .fill(connectionColor)
                .frame(width: 9, height: 9)
        }
    }

    private var connectionColor: Color {
        if viewModel.isRetryingConnection {
            return .gray.opacity(0.82)
        }
        switch viewModel.connectionState {
        case .idle:
            return .gray
        case .checking:
            return .gray.opacity(0.8)
        case .connected:
            return .green
        case .failed:
            return .red
        }
    }

    private var devServerHostLabel: String? {
        guard let configuration = settingsStore.serverConfiguration else { return nil }
        let host = configuration.normalizedHost
        return host.isEmpty ? nil : host
    }

    private func threadRow(_ thread: PocketDexThreadSummary) -> some View {
        let isArchiving = viewModel.archivingThreadIDs.contains(thread.id)
        return HStack(alignment: .center, spacing: 10) {
            threadActivityIndicator(thread)
                .frame(width: 14, height: 14)

            VStack(alignment: .leading, spacing: 6) {
                Text(thread.displayTitle)
                    .font(.system(size: 18, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.92))
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .layoutPriority(1)
                if !thread.preview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(thread.preview)
                        .font(.system(size: 15, weight: .regular, design: .rounded))
                        .foregroundStyle(PocketDexTheme.secondaryText)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(1)

            HStack(alignment: .center, spacing: 8) {
                if isArchiving {
                    PocketDexWebSpinner(size: 10, lineWidth: 1.7, color: .white.opacity(0.72))
                        .frame(width: 12, height: 12)
                    Text("Archiving")
                        .font(.footnote)
                        .foregroundStyle(PocketDexTheme.secondaryText)
                } else {
                    if let updatedDate = thread.updatedDate {
                        Text(relativeUpdatedLabel(for: updatedDate))
                            .font(.footnote)
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                            .foregroundStyle(PocketDexTheme.secondaryText)
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(PocketDexTheme.secondaryText.opacity(0.85))
                }
            }
            .frame(minWidth: 54, alignment: .trailing)
        }
        .padding(.vertical, 8)
        .opacity(isArchiving ? 0.72 : 1)
    }

    @ViewBuilder
    private func threadActivityIndicator(_ thread: PocketDexThreadSummary) -> some View {
        if thread.isActive {
            PocketDexWebSpinner(size: 12, lineWidth: 1.8, color: .white.opacity(0.7))
        } else if isThreadUnreadCompleted(thread.id) {
            Circle()
                .fill(Color(red: 0.51, green: 0.83, blue: 1.0).opacity(0.95))
                .frame(width: 8, height: 8)
                .shadow(color: Color(red: 0.51, green: 0.83, blue: 1.0).opacity(0.55), radius: 4)
        } else {
            Circle()
                .fill(Color.clear)
                .frame(width: 8, height: 8)
        }
    }

    private var serverPopupOverlay: some View {
        ZStack {
            Color.black.opacity(0.58)
                .ignoresSafeArea()
                .onTapGesture {
                    closeServerPopup()
                }

            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Server")
                        .font(.system(size: 20, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.95))
                    Spacer()
                    Button {
                        closeServerPopup()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.72))
                            .frame(width: 30, height: 30)
                            .background(PocketDexTheme.mutedSurface, in: Circle())
                    }
                    .buttonStyle(.plain)
                }

                serverPopupField(
                    title: "Host / IP Address",
                    text: $serverHostDraft,
                    keyboardType: .URL
                )

                tailscaleShortcutButton

                serverPopupField(
                    title: "Port",
                    text: $serverPortDraft,
                    keyboardType: .numberPad
                )

                if let serverValidationMessage, !serverValidationMessage.isEmpty {
                    Text(serverValidationMessage)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.red.opacity(0.9))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button {
                    saveServerConfiguration()
                } label: {
                    Text("Save")
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
            .padding(18)
            .frame(maxWidth: 360, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(PocketDexTheme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(PocketDexTheme.border, lineWidth: 1)
            )
            .padding(.horizontal, 28)
        }
        .transition(.opacity.combined(with: .scale(scale: 0.96)))
    }

    private var devServerPopupOverlay: some View {
        ZStack {
            Color.black.opacity(0.58)
                .ignoresSafeArea()
                .onTapGesture {
                    closeDevServerPopup()
                }

            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Access dev server")
                        .font(.system(size: 20, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.95))
                    Spacer()
                    Button {
                        closeDevServerPopup()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.72))
                            .frame(width: 30, height: 30)
                            .background(PocketDexTheme.mutedSurface, in: Circle())
                    }
                    .buttonStyle(.plain)
                }

                serverPopupField(
                    title: "Port",
                    text: $devServerPortDraft,
                    keyboardType: .numberPad
                )

                VStack(alignment: .leading, spacing: 8) {
                    Text("Quick ports")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.78))

                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 70), spacing: 8)], spacing: 8) {
                        ForEach(commonDevServerPorts, id: \.self) { port in
                            Button {
                                devServerPortDraft = port
                                devServerValidationMessage = nil
                            } label: {
                                Text(port)
                                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                                    .foregroundStyle(
                                        devServerPortDraft.trimmingCharacters(in: .whitespacesAndNewlines) == port
                                            ? .white.opacity(0.95)
                                            : .white.opacity(0.8)
                                    )
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 8)
                                    .background(
                                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                                            .fill(
                                                devServerPortDraft.trimmingCharacters(in: .whitespacesAndNewlines) == port
                                                    ? Color.white.opacity(0.16)
                                                    : Color.black.opacity(0.42)
                                            )
                                    )
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                                            .stroke(Color.white.opacity(0.22), lineWidth: 1)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if let devServerValidationMessage, !devServerValidationMessage.isEmpty {
                    Text(devServerValidationMessage)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.red.opacity(0.9))
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text("Safari will open \(devServerHostLabel ?? "your server host") with the selected port.")
                        .font(.footnote)
                        .foregroundStyle(PocketDexTheme.secondaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button {
                    openDevServerInSafari()
                } label: {
                    Text("Open in Safari")
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
            .padding(18)
            .frame(maxWidth: 360, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(PocketDexTheme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(PocketDexTheme.border, lineWidth: 1)
            )
            .padding(.horizontal, 28)
        }
        .transition(.opacity.combined(with: .scale(scale: 0.96)))
    }

    private var codexSettingsPopupOverlay: some View {
        ZStack {
            Color.black.opacity(0.58)
                .ignoresSafeArea()
                .onTapGesture {
                    closeCodexSettingsPopup()
                }

            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Codex Access Settings")
                        .font(.system(size: 20, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.95))
                    Spacer()
                    Button {
                        closeCodexSettingsPopup()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.72))
                            .frame(width: 30, height: 30)
                            .background(PocketDexTheme.mutedSurface, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(isSavingCodexSettings)
                    .opacity(isSavingCodexSettings ? 0.5 : 1)
                }

                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Full access")
                            .font(.system(size: 15, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white.opacity(0.92))
                        Text(
                            codexSettingsDraft.accessMode == .fullAccess
                                ? "No sandbox restrictions for new threads."
                                : "Disabled: workspace mode for new threads."
                        )
                        .font(.footnote)
                        .foregroundStyle(PocketDexTheme.secondaryText)
                    }
                    Spacer()
                    Button {
                        codexSettingsDraft.accessMode =
                            codexSettingsDraft.accessMode == .fullAccess
                            ? .workspaceWrite
                            : .fullAccess
                    } label: {
                        ZStack(alignment: codexSettingsDraft.accessMode == .fullAccess ? .trailing : .leading) {
                            Capsule(style: .continuous)
                                .fill(
                                    codexSettingsDraft.accessMode == .fullAccess
                                        ? Color(red: 0.39, green: 0.78, blue: 0.52).opacity(0.9)
                                        : Color.white.opacity(0.2)
                                )
                                .frame(width: 48, height: 28)
                            Circle()
                                .fill(Color.white.opacity(0.94))
                                .frame(width: 22, height: 22)
                                .padding(.horizontal, 3)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(isSavingCodexSettings)
                    .opacity(isSavingCodexSettings ? 0.6 : 1)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.black.opacity(0.50),
                                    Color.black.opacity(0.38),
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Color.white.opacity(0.20), lineWidth: 1)
                )

                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Internet access")
                            .font(.system(size: 15, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white.opacity(0.92))
                        Text("Applied to new threads only.")
                            .font(.footnote)
                            .foregroundStyle(PocketDexTheme.secondaryText)
                    }
                    Spacer()
                    Button {
                        codexSettingsDraft.internetAccessEnabled.toggle()
                    } label: {
                        ZStack(alignment: codexSettingsDraft.internetAccessEnabled ? .trailing : .leading) {
                            Capsule(style: .continuous)
                                .fill(
                                    codexSettingsDraft.internetAccessEnabled
                                        ? Color(red: 0.39, green: 0.78, blue: 0.52).opacity(0.9)
                                        : Color.white.opacity(0.2)
                                )
                                .frame(width: 48, height: 28)
                            Circle()
                                .fill(Color.white.opacity(0.94))
                                .frame(width: 22, height: 22)
                                .padding(.horizontal, 3)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(isSavingCodexSettings)
                    .opacity(isSavingCodexSettings ? 0.6 : 1)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.black.opacity(0.50),
                                    Color.black.opacity(0.38),
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Color.white.opacity(0.20), lineWidth: 1)
                )

                if let codexSettingsRuntimeNotice {
                    Text(codexSettingsRuntimeNotice)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Color(red: 0.96, green: 0.87, blue: 0.62))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let codexSettingsValidationMessage, !codexSettingsValidationMessage.isEmpty {
                    Text(codexSettingsValidationMessage)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.red.opacity(0.9))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                HStack(spacing: 10) {
                    Button {
                        closeCodexSettingsPopup()
                    } label: {
                        Text("Cancel")
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.9))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(
                                RoundedRectangle(cornerRadius: 11, style: .continuous)
                                    .fill(Color.white.opacity(0.08))
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 11, style: .continuous)
                                    .stroke(Color.white.opacity(0.18), lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(isSavingCodexSettings)
                    .opacity(isSavingCodexSettings ? 0.6 : 1)

                    Button {
                        saveCodexSettings()
                    } label: {
                        Text(isSavingCodexSettings ? "Saving..." : "Save")
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(.black.opacity(0.9))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(
                                RoundedRectangle(cornerRadius: 11, style: .continuous)
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
                                RoundedRectangle(cornerRadius: 11, style: .continuous)
                                    .stroke(Color.white.opacity(0.34), lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(isSavingCodexSettings)
                    .opacity(isSavingCodexSettings ? 0.6 : 1)
                }
            }
            .padding(18)
            .frame(maxWidth: 360, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(PocketDexTheme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(PocketDexTheme.border, lineWidth: 1)
            )
            .padding(.horizontal, 28)
        }
        .transition(.opacity.combined(with: .scale(scale: 0.96)))
    }

    private var codexSettingsRuntimeNotice: String? {
        if codexSettingsDraft.accessMode == .workspaceWrite && codexSettingsDraft.internetAccessEnabled {
            return "Workspace mode remains sandboxed on this runtime, so internet stays restricted."
        }
        if codexSettingsDraft.accessMode == .fullAccess && !codexSettingsDraft.internetAccessEnabled {
            return "This runtime cannot combine full access with internet disabled, so threads fall back to workspace mode."
        }
        return nil
    }

    private var projectPopupOverlay: some View {
        ZStack {
            Color.black.opacity(0.58)
                .ignoresSafeArea()
                .onTapGesture {
                    closeProjectPopup()
                }

            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("New Project")
                        .font(.system(size: 20, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.95))
                    Spacer()
                    Button {
                        closeProjectPopup()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.72))
                            .frame(width: 30, height: 30)
                            .background(PocketDexTheme.mutedSurface, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(viewModel.isCreatingProject || viewModel.isCreatingThread)
                    .opacity((viewModel.isCreatingProject || viewModel.isCreatingThread) ? 0.5 : 1)
                }

                popupField(
                    title: "Project Name",
                    text: $projectNameDraft,
                    keyboardType: .default
                )

                if let projectValidationMessage, !projectValidationMessage.isEmpty {
                    Text(projectValidationMessage)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.red.opacity(0.9))
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text("A folder with this name will be created on your server.")
                        .font(.footnote)
                        .foregroundStyle(PocketDexTheme.secondaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button {
                    createProjectFromPopup()
                } label: {
                    Text(viewModel.isCreatingProject ? "Creating..." : "Create Project")
                        .font(.headline)
                        .foregroundStyle(.black)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                }
                .buttonStyle(.borderedProminent)
                .tint(.white.opacity(0.92))
                .disabled(viewModel.isCreatingProject || viewModel.isCreatingThread)
                .opacity((viewModel.isCreatingProject || viewModel.isCreatingThread) ? 0.6 : 1)
            }
            .padding(18)
            .frame(maxWidth: 360, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(PocketDexTheme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(PocketDexTheme.border, lineWidth: 1)
            )
            .padding(.horizontal, 28)
        }
        .transition(.opacity.combined(with: .scale(scale: 0.96)))
    }

    private func popupField(
        title: String,
        text: Binding<String>,
        keyboardType: UIKeyboardType
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white.opacity(0.78))
            TextField("", text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(keyboardType)
                .padding(12)
                .background(PocketDexTheme.mutedSurface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .foregroundStyle(.white.opacity(0.92))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(PocketDexTheme.border, lineWidth: 1)
                )
        }
    }

    private func serverPopupField(
        title: String,
        text: Binding<String>,
        keyboardType: UIKeyboardType
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white.opacity(0.78))
            TextField("", text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(keyboardType)
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

    private func openServerPopup() {
        if let current = settingsStore.serverConfiguration {
            serverHostDraft = current.host
            serverPortDraft = String(current.port)
        } else {
            serverHostDraft = ""
            serverPortDraft = "8787"
        }
        refreshTailscaleAvailability()
        serverValidationMessage = nil
        withAnimation(.easeInOut(duration: 0.16)) {
            showServerPopup = true
        }
    }

    private func closeServerPopup() {
        withAnimation(.easeInOut(duration: 0.16)) {
            showServerPopup = false
        }
    }

    private func openDevServerPopup() {
        devServerPortDraft = ""
        devServerValidationMessage = nil
        withAnimation(.easeInOut(duration: 0.16)) {
            showDevServerPopup = true
        }
    }

    private func closeDevServerPopup() {
        withAnimation(.easeInOut(duration: 0.16)) {
            showDevServerPopup = false
        }
    }

    private func openCodexSettingsPopup() {
        codexSettingsDraft = settingsStore.codexPreferences
        codexSettingsValidationMessage = nil
        withAnimation(.easeInOut(duration: 0.16)) {
            showCodexSettingsPopup = true
        }
    }

    private func closeCodexSettingsPopup() {
        guard !isSavingCodexSettings else { return }
        withAnimation(.easeInOut(duration: 0.16)) {
            showCodexSettingsPopup = false
        }
    }

    private func saveCodexSettings() {
        guard !isSavingCodexSettings else { return }
        codexSettingsValidationMessage = nil
        let draft = codexSettingsDraft
        settingsStore.update(codexPreferences: draft)

        guard let configuration = settingsStore.serverConfiguration else {
            closeCodexSettingsPopup()
            return
        }

        isSavingCodexSettings = true
        Task {
            do {
                let persisted = try await apiClient.updateCodexPreferences(draft, config: configuration)
                settingsStore.update(codexPreferences: persisted)
                isSavingCodexSettings = false
                closeCodexSettingsPopup()
            } catch {
                isSavingCodexSettings = false
                codexSettingsValidationMessage = "Saved locally, but server sync failed. Try again when connected."
            }
        }
    }

    private func hydrateCodexPreferencesFromServer() async {
        guard let configuration = settingsStore.serverConfiguration else { return }
        do {
            let fetched = try await apiClient.fetchCodexPreferences(config: configuration)
            if fetched != settingsStore.codexPreferences {
                settingsStore.update(codexPreferences: fetched)
            }
        } catch {
            // Keep local preferences if server sync is unavailable.
        }
    }

    private func openDevServerInSafari() {
        devServerValidationMessage = nil
        let trimmedPort = devServerPortDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsedPort = Int(trimmedPort), (1...65535).contains(parsedPort) else {
            devServerValidationMessage = "Enter a valid port between 1 and 65535."
            return
        }

        guard let baseURL = settingsStore.serverConfiguration?.baseURL,
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        else {
            devServerValidationMessage = "Server address unavailable."
            return
        }

        components.port = parsedPort
        components.path = "/"
        components.query = nil
        components.fragment = nil
        guard let targetURL = components.url else {
            devServerValidationMessage = "Could not build the dev server URL."
            return
        }

        UIApplication.shared.open(targetURL, options: [:], completionHandler: nil)
        closeDevServerPopup()
    }

    private func openProjectPopup() {
        projectNameDraft = ""
        projectValidationMessage = nil
        withAnimation(.easeInOut(duration: 0.16)) {
            showProjectPopup = true
        }
    }

    private func closeProjectPopup() {
        if viewModel.isCreatingProject || viewModel.isCreatingThread {
            return
        }
        withAnimation(.easeInOut(duration: 0.16)) {
            showProjectPopup = false
        }
    }

    private func createProjectFromPopup() {
        let trimmed = projectNameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            projectValidationMessage = "Project name is required."
            return
        }
        projectValidationMessage = nil
        Task {
            if let createdCwd = await viewModel.createProject(name: trimmed) {
                if let createdThread = await viewModel.createThread(
                    cwd: createdCwd,
                    securityOptions: resolveThreadStartSecurityPreferences(settingsStore.codexPreferences)
                ) {
                    closeProjectPopup()
                    pushedThread = createdThread
                } else {
                    projectValidationMessage = viewModel.errorMessage ?? "Project created, but thread creation failed."
                }
            } else {
                projectValidationMessage = viewModel.errorMessage ?? "Failed to create project."
            }
        }
    }

    private func saveServerConfiguration() {
        serverValidationMessage = nil
        let parsedPort = Int(serverPortDraft.trimmingCharacters(in: .whitespacesAndNewlines)) ?? -1
        let resolvedScheme = ServerConfiguration.inferredScheme(for: serverHostDraft)
        do {
            let config = try ServerConfiguration(
                scheme: resolvedScheme,
                host: serverHostDraft,
                port: parsedPort
            ).validated()
            settingsStore.update(serverConfiguration: config)
            closeServerPopup()
        } catch {
            serverValidationMessage = error.localizedDescription
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

    private func createThread(for group: ProjectGroup) {
        guard !viewModel.isCreatingThread else { return }
        Task {
            if let created = await viewModel.createThread(
                cwd: group.cwd,
                securityOptions: resolveThreadStartSecurityPreferences(settingsStore.codexPreferences)
            ) {
                pushedThread = created
            }
        }
    }

    private func resolveThreadStartSecurityPreferences(
        _ preferences: PocketDexCodexPreferences
    ) -> PocketDexAPIClient.ThreadStartSecurityOptions {
        if preferences.accessMode == .fullAccess && preferences.internetAccessEnabled {
            return .init(
                approvalPolicy: "never",
                sandbox: "danger-full-access"
            )
        }
        return .init(
            approvalPolicy: "on-request",
            sandbox: "workspace-write"
        )
    }

    private func archiveThreadFromList(_ thread: PocketDexThreadSummary) {
        Task {
            let archived = await viewModel.archiveThread(thread)
            guard archived else { return }
            markThreadAsRead(thread.id)
            previousActiveByThreadID.removeValue(forKey: thread.id)
            if activeConversationThreadID == thread.id {
                activeConversationThreadID = nil
            }
            if pushedThread?.id == thread.id {
                pushedThread = nil
            }
        }
    }

    private func hydrateLocalProjectOrderIfNeeded() {
        if hasHydratedLocalProjectOrder {
            return
        }
        hasHydratedLocalProjectOrder = true
        let storedOrder = UserDefaults.standard.stringArray(forKey: projectOrderStorageKey) ?? []
        projectOrderIDs = normalizeProjectOrderIDs(storedOrder)
    }

    private func persistProjectOrderLocally(_ orderIDs: [String]) {
        UserDefaults.standard.set(orderIDs, forKey: projectOrderStorageKey)
    }

    private func applyIncomingProjectOrder(_ incomingOrderIDs: [String]) {
        let normalizedIncoming = normalizeProjectOrderIDs(incomingOrderIDs)
        guard !normalizedIncoming.isEmpty else { return }
        if normalizedIncoming == projectOrderIDs {
            return
        }
        projectOrderIDs = normalizedIncoming
        rebuildProjectGroups()
    }

    private func isProjectReorderable(_ group: ProjectGroup) -> Bool {
        let reorderableCount = groupedThreadsCache.filter { $0.id != "(unknown)" }.count
        return reorderableCount > 1 && group.id != "(unknown)"
    }

    private func normalizeProjectOrderIDs(_ orderIDs: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for entry in orderIDs {
            let trimmed = entry.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || seen.contains(trimmed) || trimmed == "(unknown)" {
                continue
            }
            seen.insert(trimmed)
            result.append(trimmed)
        }
        return result
    }

    private func normalizedProjectOrder(for groups: [ProjectGroup], preferredOrder: [String]) -> [String] {
        let reorderableIDs = groups
            .map(\.id)
            .filter { $0 != "(unknown)" }
        guard !reorderableIDs.isEmpty else {
            return normalizeProjectOrderIDs(preferredOrder)
        }

        let preferred = normalizeProjectOrderIDs(preferredOrder)
        let validIDSet = Set(reorderableIDs)
        var seen = Set<String>()
        var result: [String] = []

        for id in preferred where validIDSet.contains(id) {
            if seen.contains(id) { continue }
            seen.insert(id)
            result.append(id)
        }

        for id in reorderableIDs where !seen.contains(id) {
            seen.insert(id)
            result.append(id)
        }

        return result
    }

    private func orderedProjectGroups(from groups: [ProjectGroup], preferredOrder: [String]) -> [ProjectGroup] {
        guard !groups.isEmpty else { return groups }
        let reorderableGroups = groups.filter { $0.id != "(unknown)" }
        let unknownGroup = groups.first(where: { $0.id == "(unknown)" })
        let finalOrder = normalizedProjectOrder(for: groups, preferredOrder: preferredOrder)
        let groupByID = Dictionary(uniqueKeysWithValues: reorderableGroups.map { ($0.id, $0) })

        var ordered: [ProjectGroup] = []
        ordered.reserveCapacity(groups.count)
        for id in finalOrder {
            if let group = groupByID[id] {
                ordered.append(group)
            }
        }
        if let unknownGroup {
            ordered.append(unknownGroup)
        }
        return ordered
    }

    private func reorderedProjectIDs(
        _ currentOrder: [String],
        sourceID: String,
        targetID: String,
        position: ProjectDropPosition
    ) -> [String] {
        guard let sourceIndex = currentOrder.firstIndex(of: sourceID),
              let targetIndex = currentOrder.firstIndex(of: targetID),
              sourceIndex != targetIndex
        else {
            return currentOrder
        }

        var nextOrder = currentOrder
        let movedID = nextOrder.remove(at: sourceIndex)
        let adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
        let destinationIndex = position == .before ? adjustedTargetIndex : adjustedTargetIndex + 1
        let boundedIndex = min(max(destinationIndex, 0), nextOrder.count)
        nextOrder.insert(movedID, at: boundedIndex)
        return nextOrder
    }

    private func previewProjectReorder(_ draggedProjectID: String, _ targetProjectID: String, _ position: ProjectDropPosition) {
        let currentOrder = groupedThreadsCache.map(\.id).filter { $0 != "(unknown)" }
        guard currentOrder.contains(draggedProjectID), currentOrder.contains(targetProjectID) else { return }
        let nextOrder = reorderedProjectIDs(
            currentOrder,
            sourceID: draggedProjectID,
            targetID: targetProjectID,
            position: position
        )
        if nextOrder == currentOrder {
            return
        }

        withAnimation(.interactiveSpring(response: 0.24, dampingFraction: 0.84, blendDuration: 0.08)) {
            groupedThreadsCache = orderedProjectGroups(from: groupedThreadsCache, preferredOrder: nextOrder)
            availableProjectGroupsCache = groupedThreadsCache.filter { $0.cwd != "(unknown)" }
        }
    }

    private func commitProjectOrderFromCurrentGroups() {
        let nextOrder = groupedThreadsCache
            .map(\.id)
            .filter { $0 != "(unknown)" }
        let normalized = normalizeProjectOrderIDs(nextOrder)
        if normalized == projectOrderIDs {
            return
        }
        projectOrderIDs = normalized
        Task {
            await viewModel.persistProjectOrder(normalized)
        }
    }

    private func rebuildProjectGroups() {
        let groupedByWorkspace = Dictionary(grouping: viewModel.threads) { thread in
            let cwd = thread.cwd.trimmingCharacters(in: .whitespacesAndNewlines)
            return cwd.isEmpty ? "(unknown)" : cwd
        }

        var workspaceCwds = Set(viewModel.workspaceRoots.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) })
        workspaceCwds = Set(workspaceCwds.filter { !$0.isEmpty })
        for cwd in groupedByWorkspace.keys where cwd != "(unknown)" {
            workspaceCwds.insert(cwd)
        }

        var regrouped: [ProjectGroup] = workspaceCwds.map { cwd in
            let threads = (groupedByWorkspace[cwd] ?? []).sorted { lhs, rhs in
                (lhs.updatedAt ?? 0) > (rhs.updatedAt ?? 0)
            }
            return ProjectGroup(
                id: cwd,
                cwd: cwd,
                header: workspaceHeader(from: cwd),
                threads: threads
            )
        }

        if let unknownThreads = groupedByWorkspace["(unknown)"] {
            let sortedUnknownThreads = unknownThreads.sorted { lhs, rhs in
                (lhs.updatedAt ?? 0) > (rhs.updatedAt ?? 0)
            }
            regrouped.append(
                ProjectGroup(
                    id: "(unknown)",
                    cwd: "(unknown)",
                    header: "Unknown workspace",
                    threads: sortedUnknownThreads
                )
            )
        }

        regrouped.sort { lhs, rhs in
            if lhs.id == "(unknown)" { return false }
            if rhs.id == "(unknown)" { return true }

            let lhsHasThreads = !lhs.threads.isEmpty
            let rhsHasThreads = !rhs.threads.isEmpty
            if lhsHasThreads != rhsHasThreads {
                return lhsHasThreads
            }

            let leftValue = lhs.threads.first?.updatedAt ?? 0
            let rightValue = rhs.threads.first?.updatedAt ?? 0
            if leftValue != rightValue {
                return leftValue > rightValue
            }
            return lhs.header.localizedCaseInsensitiveCompare(rhs.header) == .orderedAscending
        }

        if !projectOrderIDs.isEmpty {
            let resolvedOrder = normalizedProjectOrder(for: regrouped, preferredOrder: projectOrderIDs)
            regrouped = orderedProjectGroups(from: regrouped, preferredOrder: resolvedOrder)
            if resolvedOrder != projectOrderIDs {
                projectOrderIDs = resolvedOrder
            }
        }

        groupedThreadsCache = regrouped
        availableProjectGroupsCache = regrouped.filter { $0.cwd != "(unknown)" }

        let validProjectIDs = Set(regrouped.map(\.id))
        collapsedProjectIDs = collapsedProjectIDs.intersection(validProjectIDs)
        if let draggingProjectID, !validProjectIDs.contains(draggingProjectID) {
            self.draggingProjectID = nil
            projectDropTarget = nil
        }
        if let liftedProjectID, !validProjectIDs.contains(liftedProjectID) {
            self.liftedProjectID = nil
        }
    }

    private func workspaceHeader(from cwd: String) -> String {
        let trimmed = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == "(unknown)" {
            return "Unknown workspace"
        }
        let url = URL(fileURLWithPath: trimmed)
        return url.lastPathComponent.isEmpty ? trimmed : url.lastPathComponent
    }

    private func isThreadUnreadCompleted(_ threadID: String) -> Bool {
        unreadCompletedThreadIDs.contains(threadID)
    }

    private func markThreadAsRead(_ threadID: String) {
        unreadCompletedThreadIDs.remove(threadID)
    }

    private func updateUnreadCompletedNotifications(with threads: [PocketDexThreadSummary]) {
        var nextActiveByThreadID: [String: Bool] = [:]
        for thread in threads {
            nextActiveByThreadID[thread.id] = thread.isActive
        }

        if !hasInitializedActivityTracking {
            previousActiveByThreadID = nextActiveByThreadID
            unreadCompletedThreadIDs = unreadCompletedThreadIDs.intersection(Set(nextActiveByThreadID.keys))
            hasInitializedActivityTracking = true
            return
        }

        let validThreadIDs = Set(nextActiveByThreadID.keys)
        unreadCompletedThreadIDs = unreadCompletedThreadIDs.intersection(validThreadIDs)

        for thread in threads {
            let wasActive = previousActiveByThreadID[thread.id] ?? false
            let isActive = thread.isActive

            if isActive {
                unreadCompletedThreadIDs.remove(thread.id)
                continue
            }

            if wasActive && !isActive && activeConversationThreadID != thread.id {
                unreadCompletedThreadIDs.insert(thread.id)
            }
        }

        previousActiveByThreadID = nextActiveByThreadID
    }

    private func relativeUpdatedLabel(for date: Date) -> String {
        let delta = max(0, Int(Date().timeIntervalSince(date)))
        if delta < 60 {
            return "1 m"
        }
        if delta < 3600 {
            return "\(delta / 60) m"
        }
        if delta < 86_400 {
            return "\(delta / 3600) h"
        }
        if delta < 604_800 {
            return "\(delta / 86_400) d"
        }
        return "\(delta / 604_800) w"
    }
}

private struct SyncBlinkDot: View {
    let color: Color
    let glowColor: Color
    let size: CGFloat

    @State private var isAnimating = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .scaleEffect(isAnimating ? 1.0 : 0.72)
            .opacity(isAnimating ? 1.0 : 0.42)
            .shadow(color: glowColor, radius: isAnimating ? 4 : 1)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.92).repeatForever(autoreverses: true)) {
                    isAnimating = true
                }
            }
            .onDisappear {
                isAnimating = false
            }
    }
}
