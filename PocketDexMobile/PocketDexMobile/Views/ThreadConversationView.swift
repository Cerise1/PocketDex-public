import Foundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

struct ThreadConversationView: View {
    let threadSummary: PocketDexThreadSummary
    let apiClient: PocketDexAPIClient

    private let composerBarBackground = Color(red: 0.10, green: 0.10, blue: 0.11)

    @EnvironmentObject private var settingsStore: AppSettingsStore
    @StateObject private var viewModel: ThreadDetailViewModel
    @State private var isComposerFocused = false
    private let thinkingIndicatorID = "thread-thinking-indicator"

    init(threadSummary: PocketDexThreadSummary, apiClient: PocketDexAPIClient) {
        self.threadSummary = threadSummary
        self.apiClient = apiClient
        _viewModel = StateObject(
            wrappedValue: ThreadDetailViewModel(
                threadSummary: threadSummary,
                apiClient: apiClient
            )
        )
    }

    var body: some View {
        ZStack(alignment: .top) {
            PocketDexBackground()

            VStack(spacing: 0) {
                if let outOfCreditMessage = viewModel.outOfCreditMessage, !outOfCreditMessage.isEmpty {
                    HStack(spacing: 10) {
                        Text("OUT OF CREDIT")
                            .font(.caption2.weight(.semibold))
                            .kerning(1.1)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.red.opacity(0.18), in: Capsule())
                            .overlay(
                                Capsule()
                                    .stroke(Color.red.opacity(0.35), lineWidth: 1)
                            )
                        Text(outOfCreditMessage)
                            .font(.footnote)
                            .lineLimit(2)
                        Spacer()
                    }
                    .padding(.horizontal, 26)
                    .padding(.vertical, 10)
                    .foregroundStyle(Color(red: 1.0, green: 0.86, blue: 0.86))
                    .background(
                        LinearGradient(
                            colors: [
                                Color(red: 0.34, green: 0.05, blue: 0.09).opacity(0.82),
                                Color(red: 0.20, green: 0.08, blue: 0.08).opacity(0.9),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                }
                if let errorMessage = viewModel.errorMessage, !errorMessage.isEmpty {
                    HStack(spacing: 10) {
                        Image(systemName: "exclamationmark.triangle.fill")
                        Text(errorMessage)
                            .font(.footnote)
                            .lineLimit(2)
                        Spacer()
                    }
                    .padding(.horizontal, 26)
                    .padding(.vertical, 10)
                    .foregroundStyle(.red.opacity(0.9))
                    .background(Color.red.opacity(0.12))
                }

                conversationBody
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            composerBar
                .padding(.horizontal, 24)
                .padding(.top, 10)
                .padding(.bottom, 10)
                .background(composerBarBackground)
                .overlay(
                    Rectangle()
                        .fill(PocketDexTheme.border)
                        .frame(height: 1),
                    alignment: .top
                )
        }
        .navigationTitle(viewModel.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarBackground(PocketDexTheme.backgroundTop.opacity(0.96), for: .navigationBar)
        .tint(.white)
        .toolbar {
            if viewModel.canInterruptActiveRun {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Stop") {
                        Task { await viewModel.interruptActiveTurn() }
                    }
                }
            }
        }
        .task(id: settingsStore.serverConfiguration) {
            viewModel.setConfiguration(settingsStore.serverConfiguration)
            viewModel.start()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            Task { await viewModel.handleAppBecameActive() }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            Task { await viewModel.handleAppBecameActive() }
        }
        .onDisappear {
            viewModel.stop()
        }
    }

    private var conversationBody: some View {
        ConversationTimelineView(
            timeline: viewModel.timeline,
            isLoading: viewModel.isLoading,
            isSyncing: viewModel.isSyncing,
            thinkingIndicatorID: thinkingIndicatorID,
            composerIsFocused: isComposerFocused,
            configuration: settingsStore.serverConfiguration,
            apiClient: apiClient
        )
        .equatable()
        // Decouple timeline layout from keyboard transitions to avoid mid-gesture scroll jitter.
        .ignoresSafeArea(.keyboard, edges: .bottom)
    }

    private var composerBar: some View {
        ThreadComposerBar(viewModel: viewModel) { isFocused in
            isComposerFocused = isFocused
        }
    }
}

private struct ConversationTimelineView: View, Equatable {
    let timeline: [ConversationTimelineItem]
    let isLoading: Bool
    let isSyncing: Bool
    let thinkingIndicatorID: String
    let composerIsFocused: Bool
    let configuration: ServerConfiguration?
    let apiClient: PocketDexAPIClient

    @State private var viewportHeight: CGFloat = 0
    @State private var isFollowingLatest = true
    @State private var isNearBottom = true
    @State private var latestBottomDistance: CGFloat = 0
    @State private var hasDoneInitialBottomScroll = false
    @State private var initialLockToBottom = true

    private let scrollSpaceName = "thread-timeline-scroll-space"
    private let bottomAnchorID = "thread-timeline-bottom-anchor"
    private let followThreshold: CGFloat = 72
    private let bottomContentInset: CGFloat = 28
    private let keyboardViewportDeltaThreshold: CGFloat = 20

    private struct TimelineVersion: Equatable {
        let itemCount: Int
        let lastItemID: String?
        let tailSignal: Int
        let isSyncing: Bool
    }

    private var timelineVersion: TimelineVersion {
        let renderedTimeline = displayedTimeline
        return TimelineVersion(
            itemCount: renderedTimeline.count,
            lastItemID: renderedTimeline.last?.id,
            tailSignal: timelineTailSignal(for: renderedTimeline.last),
            isSyncing: isSyncing
        )
    }

    private var displayedTimeline: [ConversationTimelineItem] {
        return timeline.filter { item in
            switch item.kind {
            case .command, .fileChange:
                return false
            default:
                return true
            }
        }
    }

    private func timelineTailSignal(for item: ConversationTimelineItem?) -> Int {
        guard let item else { return 0 }
        let finalFlag = item.isFinal ? 1 : 0

        switch item.kind {
        case let .userText(text), let .assistantMarkdown(text), let .plan(text):
            return (text.utf16.count &* 3) &+ finalFlag
        case let .userImage(path, remoteURL):
            return ((path?.utf16.count ?? 0) &* 3) &+ (remoteURL?.utf16.count ?? 0) &+ finalFlag
        case let .userImageData(data):
            return (data.count &* 3) &+ finalFlag
        case let .userFile(name, path):
            return (name.utf16.count &* 3) &+ (path?.utf16.count ?? 0) &+ finalFlag
        case let .reasoning(summary, content):
            let summaryTail = summary.last?.utf16.count ?? 0
            let contentTail = content.last?.utf16.count ?? 0
            return (summaryTail &* 7) &+ (contentTail &* 5) &+ summary.count &+ content.count &+ finalFlag
        case let .command(command, output, status, durationMs, actions):
            let durationBucket = durationMs.map { Int($0 / 100) } ?? 0
            return (command.utf16.count &* 3)
                &+ output.utf16.count
                &+ status.utf16.count
                &+ actions.count
                &+ durationBucket
                &+ finalFlag
        case let .fileChange(status, changes):
            let lastDiffSize = changes.last?.diff.utf16.count ?? 0
            return status.utf16.count &+ (changes.count &* 11) &+ lastDiffSize &+ finalFlag
        case .contextCompaction:
            return 19 &+ finalFlag
        case let .system(label, detail):
            return label.utf16.count &+ (detail?.utf16.count ?? 0) &+ finalFlag
        }
    }

    static func == (lhs: ConversationTimelineView, rhs: ConversationTimelineView) -> Bool {
        lhs.isLoading == rhs.isLoading
            && lhs.isSyncing == rhs.isSyncing
            && lhs.thinkingIndicatorID == rhs.thinkingIndicatorID
            && lhs.composerIsFocused == rhs.composerIsFocused
            && lhs.configuration == rhs.configuration
            && lhs.timelineVersion == rhs.timelineVersion
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        if isLoading && displayedTimeline.isEmpty {
                            PocketDexWebSpinner(size: 18, lineWidth: 2.0, color: .white.opacity(0.72))
                                .padding(.top, 30)
                        } else if displayedTimeline.isEmpty {
                            VStack(spacing: 10) {
                                Image(systemName: "bubble.left.and.bubble.right")
                                    .font(.system(size: 30, weight: .semibold))
                                    .foregroundStyle(PocketDexTheme.secondaryText)
                                Text("Start the conversation")
                                    .font(.system(size: 24, weight: .semibold, design: .rounded))
                                    .foregroundStyle(.white.opacity(0.9))
                                Text("Let's Build")
                                    .font(.system(size: 16, weight: .medium, design: .rounded))
                                    .foregroundStyle(PocketDexTheme.secondaryText)
                            }
                            .padding(.top, 36)
                        } else {
                            ForEach(displayedTimeline) { item in
                                TimelineRow(
                                    item: item,
                                    configuration: configuration,
                                    apiClient: apiClient
                                )
                                .id(item.id)
                            }
                        }
                        if isSyncing {
                            thinkingTimelineRow
                                .id(thinkingIndicatorID)
                        }

                        Color.clear
                            .frame(height: bottomContentInset)
                            .id(bottomAnchorID)
                            .background(
                                GeometryReader { anchorGeo in
                                    Color.clear.preference(
                                        key: TimelineBottomAnchorMaxYKey.self,
                                        value: anchorGeo.frame(in: .named(scrollSpaceName)).maxY
                                    )
                                }
                            )
                    }
                    .padding(.horizontal, 26)
                    .padding(.top, 14)
                    .padding(.bottom, 8)
                }
                .coordinateSpace(name: scrollSpaceName)
                // Match native interactive keyboard dismissal behavior while keeping timeline layout stable.
                .scrollDismissesKeyboard(.interactively)
                .background(Color.clear)
                .onAppear {
                    viewportHeight = geometry.size.height
                    initialLockToBottom = true
                    isFollowingLatest = true
                    isNearBottom = true
                    latestBottomDistance = 0
                    scrollToBottom(proxy: proxy, animated: false)
                    hasDoneInitialBottomScroll = true
                }
                .onChange(of: geometry.size.height) { _, newHeight in
                    let oldHeight = viewportHeight
                    viewportHeight = newHeight
                    let viewportShrank = newHeight < (oldHeight - keyboardViewportDeltaThreshold)
                    guard viewportShrank else { return }
                    guard composerIsFocused, isFollowingLatest else { return }
                    Task { @MainActor in
                        // Avoid a synchronous, expensive scroll pass in the same frame as keyboard frame updates.
                        try? await Task.sleep(nanoseconds: 16_000_000)
                        guard composerIsFocused, isFollowingLatest else { return }
                        scrollToBottom(proxy: proxy, animated: false)
                    }
                }
                .onPreferenceChange(TimelineBottomAnchorMaxYKey.self) { maxY in
                    guard viewportHeight > 0, maxY.isFinite else { return }
                    let bottomDistance = maxY - viewportHeight
                    latestBottomDistance = bottomDistance
                    let wasNearBottom = isNearBottom
                    let nearBottom = bottomDistance <= followThreshold
                    _ = wasNearBottom
                    isNearBottom = nearBottom
                    if initialLockToBottom {
                        isFollowingLatest = true
                        return
                    }
                    if composerIsFocused {
                        if nearBottom && !isFollowingLatest { isFollowingLatest = true }
                        return
                    }
                    if nearBottom {
                        isFollowingLatest = true
                        return
                    }
                    isFollowingLatest = false
                }
                .onChange(of: timelineVersion) { _, _ in
                    if !hasDoneInitialBottomScroll {
                        scrollToBottom(proxy: proxy, animated: false)
                        hasDoneInitialBottomScroll = true
                        return
                    }
                    if initialLockToBottom {
                        scrollToBottom(proxy: proxy, animated: false)
                        if !displayedTimeline.isEmpty {
                            initialLockToBottom = false
                        }
                        return
                    }
                    guard isFollowingLatest else { return }
                    scrollToBottom(
                        proxy: proxy,
                        animated: !composerIsFocused
                    )
                }
                .onChange(of: composerIsFocused) { _, isFocused in
                    guard isFocused else {
                        if !isNearBottom, !initialLockToBottom {
                            isFollowingLatest = false
                        }
                        return
                    }
                    let shouldFollowNow = (latestBottomDistance <= followThreshold)
                        || isNearBottom
                        || displayedTimeline.isEmpty
                        || initialLockToBottom
                    guard shouldFollowNow else {
                        isFollowingLatest = false
                        return
                    }
                    isFollowingLatest = true
                }
            }
        }
    }

    private func scrollToBottom(
        proxy: ScrollViewProxy,
        animated: Bool
    ) {
        if animated {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo(bottomAnchorID, anchor: .bottom)
            }
            return
        }
        proxy.scrollTo(bottomAnchorID, anchor: .bottom)
    }

    private var thinkingTimelineRow: some View {
        HStack(spacing: 8) {
            Text("Thinking")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white.opacity(0.72))
            PocketDexThinkingDots(dotSize: 4.5, color: .white.opacity(0.72))
            Spacer(minLength: 30)
        }
        .padding(.vertical, 2)
    }
}

private struct TimelineBottomAnchorMaxYKey: PreferenceKey {
    static var defaultValue: CGFloat = .nan

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private struct ThreadComposerBar: View {
    @ObservedObject var viewModel: ThreadDetailViewModel
    let onFocusChange: (Bool) -> Void

    @State private var isAttachmentMenuExpanded = false
    @State private var isShowingFileImporter = false
    @State private var isShowingPhotoLibrary = false
    @State private var isShowingCamera = false
    @State private var showCameraUnavailableAlert = false
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var draftText = ""
    @FocusState private var isComposerTextFieldFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if viewModel.queuedCount > 0 {
                let visibleQueuedRows = Array(viewModel.queuedRows.prefix(3))
                let firstQueuedID = viewModel.queuedRows.first?.id
                VStack(alignment: .leading, spacing: 6) {
                    Text("Queue \(viewModel.queuedCount)")
                        .font(.caption2.weight(.semibold))
                        .kerning(1.2)
                        .foregroundStyle(.white.opacity(0.62))
                        .padding(.horizontal, 2)

                    ForEach(visibleQueuedRows) { queued in
                        HStack(spacing: 10) {
                            Image(systemName: "arrowshape.turn.up.left")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.white.opacity(0.38))

                            VStack(alignment: .leading, spacing: 2) {
                                Text(queued.preview.isEmpty ? "Pending message" : queued.preview)
                                    .font(.caption)
                                    .foregroundStyle(.white.opacity(0.86))
                                    .lineLimit(1)
                                if let detail = queued.detail, !detail.isEmpty {
                                    Text(detail)
                                        .font(.caption2)
                                        .foregroundStyle(.white.opacity(0.52))
                                        .lineLimit(1)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)

                            if queued.id == firstQueuedID {
                                Button("Steer") {
                                    let shouldRestoreComposerFocus = isComposerTextFieldFocused
                                    if viewModel.canSteerQueuedDraft {
                                        Task { await viewModel.steerQueuedDraft() }
                                    } else if let blockedMessage = viewModel.steerQueuedDraftBlockedMessage {
                                        viewModel.errorMessage = blockedMessage
                                        if shouldRestoreComposerFocus {
                                            Task { @MainActor in
                                                await Task.yield()
                                                isComposerTextFieldFocused = true
                                            }
                                        }
                                    }
                                }
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                                .background(PocketDexTheme.mutedSurface, in: Capsule())
                                .overlay(
                                    Capsule()
                                        .stroke(PocketDexTheme.border, lineWidth: 1)
                                )
                                .foregroundStyle(.white.opacity(0.92))
                                .opacity(viewModel.canSteerQueuedDraft ? 1 : 0.45)
                            }

                            Button {
                                viewModel.removeQueuedDraft(id: queued.id)
                            } label: {
                                Image(systemName: "trash")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.white.opacity(0.58))
                                    .frame(width: 28, height: 28)
                                    .background(PocketDexTheme.mutedSurface.opacity(0.62), in: Circle())
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(PocketDexTheme.mutedSurface.opacity(0.58), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(PocketDexTheme.border, lineWidth: 1)
                        )
                    }

                    if viewModel.queuedRows.count > visibleQueuedRows.count {
                        Text("+\(viewModel.queuedRows.count - visibleQueuedRows.count) more queued")
                            .font(.caption2)
                            .foregroundStyle(.white.opacity(0.48))
                            .padding(.horizontal, 4)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(PocketDexTheme.mutedSurface.opacity(0.65), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(PocketDexTheme.border, lineWidth: 1)
                )
            }

            if !viewModel.pendingAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(viewModel.pendingAttachments) { attachment in
                            ZStack(alignment: .topTrailing) {
                                Group {
                                    if attachment.isImage, let image = attachment.previewImage {
                                        Image(uiImage: image)
                                            .resizable()
                                            .scaledToFill()
                                    } else {
                                        fileAttachmentPreview(attachment)
                                    }
                                }
                                .frame(width: 76, height: 76)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                                Button {
                                    viewModel.removeAttachment(id: attachment.id)
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.title3)
                                        .symbolRenderingMode(.hierarchical)
                                        .foregroundStyle(.white)
                                }
                                .offset(x: 6, y: -6)
                            }
                            .overlay(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .stroke(PocketDexTheme.border, lineWidth: 1)
                            )
                        }
                    }
                    .padding(.horizontal, 2)
                }
            }

            HStack(alignment: .bottom, spacing: 8) {
                attachmentLauncher

                TextField("Message", text: $draftText, axis: .vertical)
                    .font(.title3)
                    .lineLimit(1...5)
                    .focused($isComposerTextFieldFocused)
                    .autocorrectionDisabled(true)
                    .textInputAutocapitalization(.never)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(PocketDexTheme.mutedSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .foregroundStyle(.white.opacity(0.92))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(PocketDexTheme.border, lineWidth: 1)
                    )

                Button {
                    isAttachmentMenuExpanded = false
                    let outgoingText = draftText
                    draftText = ""
                    Task {
                        let accepted = await viewModel.sendDraft(text: outgoingText)
                        if !accepted && draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            draftText = outgoingText
                        }
                    }
                } label: {
                    if viewModel.isSending {
                        PocketDexWebSpinner(size: 24, lineWidth: 2.2, color: .white.opacity(0.86))
                            .frame(width: 34, height: 34)
                    } else {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 34))
                            .foregroundStyle(.white)
                    }
                }
                .disabled(!viewModel.canSendDraft(text: draftText))
            }
        }
        .onChange(of: pickerItems) { _, newItems in
            loadSelectedImages(newItems)
        }
        .onChange(of: isComposerTextFieldFocused) { _, isFocused in
            if isFocused {
                withAnimation(.spring(response: 0.24, dampingFraction: 0.85)) {
                    isAttachmentMenuExpanded = false
                }
            }
            onFocusChange(isFocused)
        }
        .photosPicker(
            isPresented: $isShowingPhotoLibrary,
            selection: $pickerItems,
            maxSelectionCount: 5,
            matching: .images
        )
        .fileImporter(
            isPresented: $isShowingFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true,
            onCompletion: handleImportedFiles
        )
        .sheet(isPresented: $isShowingCamera) {
            CameraCaptureView(
                onCapture: { image in
                    isShowingCamera = false
                    Task(priority: .userInitiated) {
                        guard let data = image.jpegData(compressionQuality: 0.9) else { return }
                        await viewModel.addAttachment(from: data)
                    }
                },
                onCancel: {
                    isShowingCamera = false
                }
            )
            .ignoresSafeArea()
        }
        .alert("Camera unavailable", isPresented: $showCameraUnavailableAlert) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("This device does not provide a camera source.")
        }
        .onDisappear {
            onFocusChange(false)
        }
    }

    private var attachmentLauncher: some View {
        ZStack(alignment: .bottomLeading) {
            if isAttachmentMenuExpanded {
                VStack(alignment: .leading, spacing: 8) {
                    attachmentActionButton(icon: "photo.on.rectangle.angled", label: "Photo Library") {
                        isShowingPhotoLibrary = true
                    }
                    attachmentActionButton(icon: "camera.fill", label: "Take Photo") {
                        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
                            showCameraUnavailableAlert = true
                            return
                        }
                        isShowingCamera = true
                    }
                    attachmentActionButton(icon: "doc", label: "File") {
                        isShowingFileImporter = true
                    }
                }
                .frame(width: 196, alignment: .leading)
                .padding(8)
                .background(PocketDexTheme.elevatedSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(PocketDexTheme.border, lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.24), radius: 10, y: 4)
                .padding(.bottom, 52)
                .transition(.scale(scale: 0.86, anchor: .bottomLeading).combined(with: .opacity))
            }

            Button {
                withAnimation(.spring(response: 0.24, dampingFraction: 0.82)) {
                    isAttachmentMenuExpanded.toggle()
                }
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } label: {
                Image(systemName: isAttachmentMenuExpanded ? "xmark" : "plus")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 34, height: 34)
                    .foregroundStyle(.white.opacity(0.9))
            }
            .padding(6)
            .background(PocketDexTheme.mutedSurface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(PocketDexTheme.border, lineWidth: 1)
            )
            .buttonStyle(.plain)
        }
        .frame(width: 46, alignment: .leading)
        .animation(.spring(response: 0.24, dampingFraction: 0.82), value: isAttachmentMenuExpanded)
    }

    private func attachmentActionButton(icon: String, label: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button {
            withAnimation(.spring(response: 0.24, dampingFraction: 0.82)) {
                isAttachmentMenuExpanded = false
            }
            action()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 18, height: 18)
                    .foregroundStyle(.white.opacity(0.92))

                Text(label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.92))

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PocketDexTheme.mutedSurface.opacity(0.96), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(PocketDexTheme.border, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }

    @ViewBuilder
    private func fileAttachmentPreview(_ attachment: PendingImageAttachment) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(PocketDexTheme.mutedSurface)
            VStack(spacing: 4) {
                Image(systemName: attachment.isImage ? "photo" : "doc")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.88))
                Text(shortAttachmentName(attachment.filename))
                    .font(.system(size: 9.5, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.72))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .padding(.horizontal, 6)
            }
        }
    }

    private func shortAttachmentName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 18 else { return trimmed }
        let prefix = trimmed.prefix(8)
        let suffix = trimmed.suffix(7)
        return "\(prefix)…\(suffix)"
    }

    private func loadSelectedImages(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        let selectedItems = items
        pickerItems.removeAll()
        Task(priority: .userInitiated) {
            for item in selectedItems {
                guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                await viewModel.addAttachment(from: data)
            }
        }
    }

    private func handleImportedFiles(_ result: Result<[URL], Error>) {
        switch result {
        case let .success(urls):
            guard !urls.isEmpty else { return }
            Task(priority: .userInitiated) {
                for url in urls {
                    guard let payload = await loadImportedFile(from: url) else { continue }
                    await viewModel.addAttachment(
                        filename: payload.filename,
                        mimeType: payload.mimeType,
                        data: payload.data
                    )
                }
            }
        case let .failure(error):
            viewModel.errorMessage = error.localizedDescription
        }
    }

    private func loadImportedFile(from url: URL) async -> ImportedFilePayload? {
        let task = Task.detached(priority: .userInitiated) { () -> ImportedFilePayload? in
            let didAccessSecurityScope = url.startAccessingSecurityScopedResource()
            defer {
                if didAccessSecurityScope {
                    url.stopAccessingSecurityScopedResource()
                }
            }

            guard
                let payload = try? Data(contentsOf: url, options: [.mappedIfSafe]),
                !payload.isEmpty
            else {
                return nil
            }

            let filename = url.lastPathComponent.isEmpty ? "attachment.bin" : url.lastPathComponent
            let mimeType = Self.resolvedMimeType(for: url)
            return ImportedFilePayload(
                filename: filename,
                mimeType: mimeType,
                data: payload
            )
        }
        return await task.value
    }

    nonisolated private static func resolvedMimeType(for url: URL) -> String {
        if let values = try? url.resourceValues(forKeys: [.contentTypeKey]),
            let contentType = values.contentType,
            let mime = contentType.preferredMIMEType
        {
            return mime
        }
        if let contentType = UTType(filenameExtension: url.pathExtension),
            let mime = contentType.preferredMIMEType
        {
            return mime
        }
        return "application/octet-stream"
    }

    private struct ImportedFilePayload: Sendable {
        let filename: String
        let mimeType: String
        let data: Data
    }
}

private struct CameraCaptureView: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    let onCancel: () -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.delegate = context.coordinator
        controller.sourceType = .camera
        controller.mediaTypes = [UTType.image.identifier]
        controller.cameraCaptureMode = .photo
        controller.allowsEditing = false
        return controller
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, onCancel: onCancel)
    }

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let onCapture: (UIImage) -> Void
        let onCancel: () -> Void

        init(onCapture: @escaping (UIImage) -> Void, onCancel: @escaping () -> Void) {
            self.onCapture = onCapture
            self.onCancel = onCancel
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.editedImage] as? UIImage ?? info[.originalImage] as? UIImage {
                onCapture(image)
                return
            }
            onCancel()
        }
    }
}

private struct TimelineRow: View {
    let item: ConversationTimelineItem
    let configuration: ServerConfiguration?
    let apiClient: PocketDexAPIClient

    var body: some View {
        switch item.kind {
        case let .userText(text):
            userTextRow(text)
        case let .assistantMarkdown(text):
            assistantTextRow(text, isFinal: item.isFinal, workedMs: item.workedMs)
        case let .plan(text):
            bubble(alignment: .leading, background: PocketDexTheme.mutedSurface) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Plan")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.72))
                    markdownText(text, textStyle: .body, opacity: 0.9)
                }
            }
        case let .reasoning(summary, content):
            reasoningRow(summary: summary, content: content)
        case let .command(command, output, status, durationMs, actions):
            commandRow(command: command, output: output, status: status, durationMs: durationMs, actions: actions)
        case let .fileChange(status, changes):
            fileChangeRow(status: status, changes: changes)
        case let .userImage(path, remoteURL):
            bubble(alignment: .trailing, background: Color.clear) {
                imageView(path: path, remoteURL: remoteURL)
            }
        case let .userImageData(data):
            bubble(alignment: .trailing, background: Color.clear) {
                imageDataView(data)
            }
        case let .userFile(name, path):
            userFileRow(name: name, path: path)
        case .contextCompaction:
            contextCompactionRow()
        case let .system(label, detail):
            bubble(alignment: .leading, background: PocketDexTheme.mutedSurface) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(label.capitalized)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.72))
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.82))
                    }
                }
            }
        }
    }

    private func userTextRow(_ text: String) -> some View {
        HStack {
            Spacer(minLength: 30)
            VStack(alignment: .leading, spacing: 8) {
                Text("YOU")
                    .font(.caption2.weight(.semibold))
                    .kerning(1.6)
                    .foregroundStyle(.white.opacity(0.78))
                markdownText(text, textStyle: .body, opacity: 1.0)
            }
            .padding(12)
            .background(Color.black.opacity(0.36), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Color.white.opacity(0.1), lineWidth: 1)
            )
        }
    }

    private func userFileRow(name: String, path: String?) -> some View {
        let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallbackFromPath: String
        if let path, !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            fallbackFromPath = shortPath(path)
        } else {
            fallbackFromPath = "attachment"
        }
        let displayName = normalizedName.isEmpty ? fallbackFromPath : normalizedName

        return bubble(alignment: .trailing, background: Color.black.opacity(0.32)) {
            HStack(spacing: 8) {
                Image(systemName: "doc")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.8))
                Text(displayName)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.92))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: 240, alignment: .leading)
        }
    }

    private func assistantTextRow(_ text: String, isFinal: Bool, workedMs: Double?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if isFinal {
                HStack(spacing: 12) {
                    Rectangle()
                        .fill(Color.white.opacity(0.12))
                        .frame(height: 1)
                        .frame(maxWidth: .infinity)

                    Text(finalResponseLabel(for: workedMs))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.white.opacity(0.55))

                    Rectangle()
                        .fill(Color.white.opacity(0.12))
                        .frame(height: 1)
                        .frame(maxWidth: .infinity)
                }
                .padding(.bottom, 2)
            }

            HStack {
                markdownText(text, textStyle: .body, opacity: 0.92)
                Spacer(minLength: 30)
            }
        }
        .padding(.vertical, 2)
    }

    private func reasoningRow(summary: [String], content: [String]) -> some View {
        HStack {
            ReasoningRowView(summary: summary, content: content)
            Spacer(minLength: 30)
        }
        .padding(.vertical, 2)
    }

    private func commandRow(
        command: String,
        output: String,
        status: String,
        durationMs: Double?,
        actions: [PocketDexCommandAction]
    ) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 6) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("Action")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(PocketDexTheme.secondaryText)

                        Text(commandActionSummary(actions: actions, fallbackCommand: command))
                            .font(.system(.footnote, design: .monospaced).weight(.semibold))
                            .foregroundStyle(Color(red: 0.46, green: 0.79, blue: 0.98))
                            .lineLimit(1)
                            .truncationMode(.tail)

                        if let durationMs, durationMs > 0 {
                            Text("\(Int(durationMs.rounded()))ms")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.white.opacity(0.35))
                        }
                    }

                    let normalizedStatus = status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                    if !normalizedStatus.isEmpty, normalizedStatus != "completed" {
                        Text(normalizedStatus.uppercased())
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.45))
                    }

                    if !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(output)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.68))
                            .textSelection(.enabled)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(PocketDexTheme.mutedSurface.opacity(0.75), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(PocketDexTheme.border, lineWidth: 1)
                )
            }

            Spacer(minLength: 30)
        }
        .padding(.vertical, 2)
    }

    private func fileChangeRow(status: String, changes: [PocketDexFileChange]) -> some View {
        let validChanges = changes.filter { !$0.path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return HStack {
            VStack(alignment: .leading, spacing: 6) {
                VStack(alignment: .leading, spacing: 6) {
                    let normalizedStatus = status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                    if !normalizedStatus.isEmpty, normalizedStatus != "completed" {
                        Text(normalizedStatus.uppercased())
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.45))
                    }

                    ForEach(Array(validChanges.enumerated()), id: \.offset) { entry in
                        let change = entry.element
                        let counts = countDiffLines(change.diff)
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("Edited")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(PocketDexTheme.secondaryText)

                            Text(basename(change.path))
                                .font(.system(.footnote, design: .monospaced).weight(.semibold))
                                .foregroundStyle(Color(red: 0.46, green: 0.79, blue: 0.98))

                            if counts.added > 0 {
                                Text("+\(counts.added)")
                                    .font(.caption2.monospacedDigit().weight(.semibold))
                                    .foregroundStyle(.green.opacity(0.85))
                            }

                            if counts.removed > 0 {
                                Text("-\(counts.removed)")
                                    .font(.caption2.monospacedDigit().weight(.semibold))
                                    .foregroundStyle(.red.opacity(0.85))
                            }
                        }
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(PocketDexTheme.mutedSurface.opacity(0.75), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(PocketDexTheme.border, lineWidth: 1)
                )
            }

            Spacer(minLength: 30)
        }
        .padding(.vertical, 2)
    }

    private func contextCompactionRow() -> some View {
        HStack(spacing: 10) {
            Rectangle()
                .fill(Color.white.opacity(0.12))
                .frame(height: 1)
                .frame(maxWidth: .infinity)

            HStack(spacing: 6) {
                Image(systemName: "list.bullet.indent")
                    .font(.system(size: 11, weight: .semibold))
                Text("Context automatically compacted")
                    .font(.caption.weight(.semibold))
            }
            .foregroundStyle(.white.opacity(0.62))

            Rectangle()
                .fill(Color.white.opacity(0.12))
                .frame(height: 1)
                .frame(maxWidth: .infinity)
        }
        .padding(.vertical, 4)
    }

    private func bubble<Content: View>(
        alignment: HorizontalAlignment,
        background: Color,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack {
            if alignment == .trailing { Spacer(minLength: 30) }
            content()
                .padding(12)
                .background(background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            if alignment == .leading { Spacer(minLength: 30) }
        }
    }

    @ViewBuilder
    private func markdownText(
        _ text: String,
        textStyle: UIFont.TextStyle = .body,
        opacity: CGFloat = 1.0,
        allowsSelection: Bool = true
    ) -> some View {
        MarkdownTextView(
            markdown: text,
            textStyle: textStyle,
            textColor: UIColor.white.withAlphaComponent(opacity),
            allowsSelection: allowsSelection
        )
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func imageView(path: String?, remoteURL: String?) -> some View {
        if let remoteURL, let url = URL(string: remoteURL) {
            AsyncImage(url: url) { phase in
                switch phase {
                case let .success(image):
                    image.resizable().scaledToFill()
                case .failure:
                    placeholderImage
                case .empty:
                    PocketDexWebSpinner(size: 16, lineWidth: 2.0, color: .white.opacity(0.7))
                @unknown default:
                    placeholderImage
                }
            }
            .frame(width: 190, height: 190)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        } else if let path, let configuration, let localURL = apiClient.localImageURL(path: path, config: configuration) {
            AsyncImage(url: localURL) { phase in
                switch phase {
                case let .success(image):
                    image.resizable().scaledToFill()
                case .failure:
                    placeholderImage
                case .empty:
                    PocketDexWebSpinner(size: 16, lineWidth: 2.0, color: .white.opacity(0.7))
                @unknown default:
                    placeholderImage
                }
            }
            .frame(width: 190, height: 190)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        } else {
            placeholderImage
        }
    }

    @ViewBuilder
    private func imageDataView(_ data: Data) -> some View {
        if let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 190, height: 190)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        } else {
            placeholderImage
        }
    }

    private var placeholderImage: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(PocketDexTheme.mutedSurface)
            Image(systemName: "photo")
                .font(.title2)
                .foregroundStyle(PocketDexTheme.secondaryText)
        }
        .frame(width: 190, height: 190)
    }

    private func commandActionSummary(actions: [PocketDexCommandAction], fallbackCommand: String) -> String {
        guard let first = actions.first else {
            return summarizeCommandTitle(from: fallbackCommand)
        }

        let summary: String
        switch first.type {
        case "read":
            summary = first.path.map { "Read \(shortPath($0))" } ?? summarizeCommandTitle(from: first.command ?? fallbackCommand)
        case "listFiles":
            if let path = first.path, !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                summary = "List files \(shortPath(path))"
            } else {
                summary = "List files"
            }
        case "search":
            let query = first.query?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let pathSuffix: String
            if let path = first.path, !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                pathSuffix = " in \(shortPath(path))"
            } else {
                pathSuffix = ""
            }
            if !query.isEmpty {
                summary = "Search \"\(query)\"\(pathSuffix)"
            } else {
                summary = "Search\(pathSuffix)"
            }
        default:
            summary = summarizeCommandTitle(from: first.command ?? fallbackCommand)
        }

        if actions.count > 1 {
            return "\(summary) +\(actions.count - 1)"
        }
        return summary
    }

    private func summarizeCommandTitle(from rawCommand: String) -> String {
        let trimmed = stripShellWrapper(rawCommand)
        let firstToken = trimmed.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
        let executable = firstToken.split(separator: "/").last.map(String.init) ?? ""
        if executable.isEmpty || executable.contains("|") || executable.contains(";") {
            return "Run command"
        }
        return "Run \(executable)"
    }

    private func stripShellWrapper(_ command: String) -> String {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }

        let wrappers = [
            "/bin/zsh -lc ",
            "zsh -lc ",
            "/bin/bash -lc ",
            "bash -lc ",
            "sh -lc ",
            "/usr/bin/env zsh -lc ",
            "/usr/bin/env bash -lc ",
        ]

        for wrapper in wrappers where trimmed.lowercased().hasPrefix(wrapper.lowercased()) {
            return String(trimmed.dropFirst(wrapper.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return trimmed
    }

    private func shortPath(_ path: String) -> String {
        let normalized = path.replacingOccurrences(of: "\\", with: "/")
        let parts = normalized.split(separator: "/").map(String.init)
        guard !parts.isEmpty else { return path }
        return parts.suffix(3).joined(separator: "/")
    }

    private func basename(_ path: String) -> String {
        let normalized = path.replacingOccurrences(of: "\\", with: "/")
        return normalized.split(separator: "/").last.map(String.init) ?? path
    }

    private func countDiffLines(_ diff: String) -> (added: Int, removed: Int) {
        var added = 0
        var removed = 0
        for line in diff.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if line.isEmpty { continue }
            if line.hasPrefix("+++ ") || line.hasPrefix("--- ") || line.hasPrefix("@@") { continue }
            if line.hasPrefix("+") {
                added += 1
            } else if line.hasPrefix("-") {
                removed += 1
            }
        }
        return (added, removed)
    }

    private func finalResponseLabel(for workedMs: Double?) -> String {
        guard let workedMs, workedMs.isFinite, workedMs >= 1000 else {
            return "Final response"
        }
        let totalSeconds = Int((workedMs / 1000).rounded())
        if totalSeconds < 60 {
            return "Worked for \(totalSeconds)s"
        }
        if totalSeconds < 3600 {
            let minutes = totalSeconds / 60
            let seconds = totalSeconds % 60
            if seconds > 0 {
                return "Worked for \(minutes)m \(seconds)s"
            }
            return "Worked for \(minutes)m"
        }

        let hours = totalSeconds / 3600
        let minutes = (totalSeconds % 3600) / 60
        if minutes > 0 {
            return "Worked for \(hours)h \(minutes)m"
        }
        return "Worked for \(hours)h"
    }
}

private struct ReasoningRowView: View {
    let summary: [String]
    let content: [String]

    @State private var isExpanded = false

    private var normalizedSummary: [String] {
        summary
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private var normalizedContent: [String] {
        content
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private var summaryLineRaw: String {
        firstLine(of: normalizedSummary.first ?? "")
    }

    private var contentLineRaw: String {
        firstLine(of: normalizedContent.first ?? "")
    }

    private var summaryLine: String {
        sanitizeReasoningHeadline(summaryLineRaw)
    }

    private var contentLine: String {
        sanitizeReasoningHeadline(contentLineRaw)
    }

    private var baseLineRaw: String {
        if !summaryLine.isEmpty {
            return summaryLineRaw
        }
        if !contentLine.isEmpty {
            return contentLineRaw
        }
        return ""
    }

    private var baseLine: String {
        if !summaryLine.isEmpty {
            return summaryLine
        }
        return contentLine
    }

    private var words: [String] {
        baseLine
            .split { $0.isWhitespace || $0.isNewline }
            .map(String.init)
    }

    private var isTrimmed: Bool {
        words.count > 6
    }

    private var trimmedHeadline: String {
        if isTrimmed {
            return "\(words.prefix(6).joined(separator: " "))…"
        }
        return baseLine
    }

    private var displayHeadline: String {
        plainTextFromMarkdown(trimmedHeadline)
    }

    private var remainder: String {
        guard isTrimmed else { return "" }
        return words.dropFirst(6).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var summaryText: String {
        normalizedSummary.joined(separator: "\n")
    }

    private var contentText: String {
        normalizedContent.joined(separator: "\n")
    }

    private var expandedSummary: String {
        guard !summaryText.isEmpty else { return "" }
        return stripFirstLine(summaryText)
    }

    private var expandedContent: String {
        guard !contentText.isEmpty else { return "" }
        return stripFirstLine(contentText)
    }

    private var hasExpandableContent: Bool {
        !expandedSummary.isEmpty || !expandedContent.isEmpty || !remainder.isEmpty
    }

    var body: some View {
        if !baseLine.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                let headlineRow = HStack(alignment: .top, spacing: 6) {
                    Text(displayHeadline)
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.46))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.white.opacity(hasExpandableContent ? 0.30 : 0.0))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }

                if hasExpandableContent {
                    Button {
                        withAnimation(.easeInOut(duration: 0.16)) {
                            isExpanded.toggle()
                        }
                    } label: {
                        headlineRow
                    }
                    .buttonStyle(.plain)
                } else {
                    headlineRow
                }

                if hasExpandableContent && isExpanded {
                    VStack(alignment: .leading, spacing: 6) {
                        if !expandedSummary.isEmpty {
                            markdownText(expandedSummary, textStyle: .footnote, opacity: 0.52)
                        }
                        if !expandedContent.isEmpty {
                            markdownText(expandedContent, textStyle: .footnote, opacity: 0.52)
                        }
                        if expandedSummary.isEmpty && expandedContent.isEmpty && !remainder.isEmpty {
                            markdownText(remainder, textStyle: .footnote, opacity: 0.52)
                        }
                    }
                }
            }
        }
    }

    private func firstLine(of text: String) -> String {
        text
            .split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
            .first?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private func sanitizeReasoningHeadline(_ text: String) -> String {
        guard !text.isEmpty else { return "" }
        let pattern = "^(?:reasoning|risoning)\\b[:\\-\\s]*"
        let range = NSRange(location: 0, length: text.utf16.count)
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let sanitized = regex.stringByReplacingMatches(
            in: text,
            options: [],
            range: range,
            withTemplate: ""
        )
        return sanitized.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func stripFirstLine(_ text: String) -> String {
        let lines = text.components(separatedBy: "\n")
        guard let first = lines.first else { return text }
        if first.trimmingCharacters(in: .whitespacesAndNewlines) == baseLineRaw.trimmingCharacters(in: .whitespacesAndNewlines) {
            return lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func plainTextFromMarkdown(_ text: String) -> String {
        guard !text.isEmpty else { return "" }
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        if let attributed = try? AttributedString(markdown: text, options: options) {
            let plain = String(attributed.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if !plain.isEmpty {
                return plain
            }
        }

        return text
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "__", with: "")
            .replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @ViewBuilder
    private func markdownText(
        _ text: String,
        textStyle: UIFont.TextStyle,
        opacity: CGFloat,
        allowsSelection: Bool = true
    ) -> some View {
        MarkdownTextView(
            markdown: text,
            textStyle: textStyle,
            textColor: UIColor.white.withAlphaComponent(opacity),
            allowsSelection: allowsSelection
        )
        .fixedSize(horizontal: false, vertical: true)
    }
}
