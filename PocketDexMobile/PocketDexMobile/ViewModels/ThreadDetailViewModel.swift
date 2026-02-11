import Foundation
import Combine
import ImageIO
import UIKit

@MainActor
final class ThreadDetailViewModel: ObservableObject {
    struct QueuedDraftRow: Identifiable {
        let id: UUID
        let preview: String
        let detail: String?
    }

    private struct QueuedDraft: Identifiable {
        let id: UUID
        let text: String
        let attachments: [PendingImageAttachment]
        let createdAt: Date
        let optimisticMessageID: String?
        let clientActionID: String?

        init(
            id: UUID = UUID(),
            text: String,
            attachments: [PendingImageAttachment],
            createdAt: Date = Date(),
            optimisticMessageID: String? = nil,
            clientActionID: String? = nil
        ) {
            self.id = id
            self.text = text
            self.attachments = attachments
            self.createdAt = createdAt
            self.optimisticMessageID = optimisticMessageID
            self.clientActionID = clientActionID
        }
    }

    private struct OptimisticMessage: Identifiable {
        let id: String
        let text: String
        let attachments: [OptimisticAttachment]
        let signature: String
    }

    private struct OptimisticAttachment {
        let filename: String
        let imageData: Data?
    }

    @Published private(set) var thread: PocketDexThreadDetail?
    @Published private(set) var timeline: [ConversationTimelineItem] = []
    @Published var pendingAttachments: [PendingImageAttachment] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isSending = false
    @Published private(set) var steeringInProgress = false
    @Published private(set) var interruptingOptimistically = false
    @Published private(set) var steerEnabled = true
    @Published private(set) var queuedCount = 0
    @Published private(set) var queuedPreview = ""
    @Published private(set) var queuedRows: [QueuedDraftRow] = []
    @Published private(set) var streamConnected = false
    @Published private(set) var optimisticThinkingVisible = false
    @Published private(set) var outOfCreditMessage: String?
    @Published var errorMessage: String? {
        didSet {
            scheduleTransientErrorAutoClearIfNeeded()
        }
    }
    @Published private(set) var displayTitle: String
    @Published private(set) var displaySubtitle: String

    private let threadID: String
    private let fallbackCwd: String
    private let apiClient: PocketDexAPIClient
    private let decoder = JSONDecoder()
    private var configuration: ServerConfiguration?
    private var pollingTask: Task<Void, Never>?
    private var deferredRefreshTask: Task<Void, Never>?
    private var streamClient: PocketDexStreamClient?
    private var queuedDrafts: [QueuedDraft] = []
    private var optimisticMessages: [OptimisticMessage] = []
    private var optimisticThinkingPending = false
    private var optimisticThinkingTask: Task<Void, Never>?
    private var optimisticHealTask: Task<Void, Never>?
    private var interruptVerificationTask: Task<Void, Never>?
    private var transientErrorAutoClearTask: Task<Void, Never>?
    private var streamInactivityWatchdogTask: Task<Void, Never>?
    private var capabilityCwd: String?
    private var knownUserMessageIDs: Set<String> = []
    private var lastSyncedSeq: Int
    private var started = false
    private var lastStreamActivityAt = Date()
    private var suppressRunActivityDueToInactivity = false
    private let stopFlowDebugSessionID = UUID().uuidString.lowercased()
    private var stopFlowDebugSequence = 0
    private var sendSequence = 0
    private var activeInterruptActionID: String?
    private static let streamRefreshDelayNanos: UInt64 = 120_000_000
    private static let streamDeltaRefreshDelayNanos: UInt64 = 80_000_000
    nonisolated private static let maxAttachmentPixelSize: CGFloat = 2048
    nonisolated private static let previewThumbnailSize = CGSize(width: 220, height: 220)
    nonisolated private static let threadSeqStorePrefix = "pocketdex.stream.seq."
    nonisolated private static let transientSurfaceControlErrorLifetimeNanos: UInt64 = 5_000_000_000
    nonisolated private static let streamInactivityWatchdogTickNanos: UInt64 = 15_000_000_000
    nonisolated private static let streamInactivityTimeoutSeconds: TimeInterval = 600

    init(threadSummary: PocketDexThreadSummary, apiClient: PocketDexAPIClient) {
        self.threadID = threadSummary.id
        self.fallbackCwd = threadSummary.cwd
        self.apiClient = apiClient
        self.lastSyncedSeq = Self.loadStoredSeq(for: threadSummary.id)
        self.displayTitle = threadSummary.displayTitle
        self.displaySubtitle = threadSummary.cwd
    }

    deinit {
        pollingTask?.cancel()
        deferredRefreshTask?.cancel()
        optimisticThinkingTask?.cancel()
        optimisticHealTask?.cancel()
        interruptVerificationTask?.cancel()
        transientErrorAutoClearTask?.cancel()
        streamInactivityWatchdogTask?.cancel()
    }

    func setConfiguration(_ configuration: ServerConfiguration?) {
        guard self.configuration != configuration else { return }
        self.configuration = configuration
        capabilityCwd = nil
        steerEnabled = true
        if started {
            restartNetworkCycle()
        }
    }

    func start() {
        guard !started else { return }
        started = true
        emitStopFlowDebug("viewmodel_started", detail: [:], configuration: configuration)
        restartNetworkCycle()
    }

    func stop() {
        started = false
        pollingTask?.cancel()
        pollingTask = nil
        deferredRefreshTask?.cancel()
        deferredRefreshTask = nil
        optimisticThinkingTask?.cancel()
        optimisticThinkingTask = nil
        optimisticHealTask?.cancel()
        optimisticHealTask = nil
        interruptVerificationTask?.cancel()
        interruptVerificationTask = nil
        transientErrorAutoClearTask?.cancel()
        transientErrorAutoClearTask = nil
        streamInactivityWatchdogTask?.cancel()
        streamInactivityWatchdogTask = nil
        interruptingOptimistically = false
        optimisticThinkingPending = false
        optimisticThinkingVisible = false
        streamClient?.disconnect()
        streamClient = nil
        streamConnected = false
        emitStopFlowDebug("viewmodel_stopped", detail: [:], configuration: configuration)
    }

    func handleAppBecameActive() async {
        guard started else { return }
        if !streamConnected {
            reconnectStream()
        }
        await refresh(showLoader: false)
    }

    func refresh(showLoader: Bool) async {
        guard let configuration else { return }
        if showLoader {
            isLoading = true
        }
        defer {
            isLoading = false
        }
        do {
            let loadedThread = try await apiClient.readThread(threadID: threadID, config: configuration)
            applyThreadSnapshot(loadedThread)
            await refreshSteerCapabilityIfNeeded(cwd: displaySubtitle, configuration: configuration)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
            emitStopFlowDebug(
                "refresh_failed",
                actionID: activeInterruptActionID,
                detail: ["error": error.localizedDescription],
                configuration: configuration
            )
        }
    }

    func addAttachment(from imageData: Data) async {
        let attachment = await Task.detached(priority: .userInitiated) {
            Self.prepareImageAttachment(from: imageData)
        }.value
        guard let attachment else { return }
        pendingAttachments.append(attachment)
    }

    func addAttachment(
        filename: String,
        mimeType: String,
        data: Data,
        previewImage: UIImage? = nil
    ) async {
        let attachment = await Task.detached(priority: .userInitiated) {
            Self.prepareFileAttachment(
                filename: filename,
                mimeType: mimeType,
                data: data,
                previewImage: previewImage
            )
        }.value
        guard let attachment else { return }
        pendingAttachments.append(attachment)
    }

    func removeAttachment(id: UUID) {
        pendingAttachments.removeAll { $0.id == id }
    }

    @discardableResult
    func sendDraft(text: String) async -> Bool {
        guard let configuration else { return false }
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedText.isEmpty && pendingAttachments.isEmpty {
            return false
        }
        sendSequence += 1
        let currentSendSequence = sendSequence
        let sendActionID = makeClientActionID(prefix: "mobile-send")
        emitStopFlowDebug(
            "send_draft_received",
            actionID: sendActionID,
            detail: [
                "sendSequence": currentSendSequence,
                "textLength": trimmedText.count,
                "attachmentCount": pendingAttachments.count,
                "isBusy": isBusy,
                "queuedBefore": queuedDrafts.count,
            ],
            configuration: configuration
        )
        markThreadRunOptimisticallyActive()

        let draft = QueuedDraft(
            text: trimmedText,
            attachments: pendingAttachments,
            clientActionID: sendActionID
        )
        pendingAttachments.removeAll()
        errorMessage = nil

        if isBusy || !queuedDrafts.isEmpty {
            let optimisticID = appendOptimisticMessage(from: draft)
            let queuedDraft = QueuedDraft(
                id: draft.id,
                text: draft.text,
                attachments: draft.attachments,
                createdAt: draft.createdAt,
                optimisticMessageID: optimisticID,
                clientActionID: sendActionID
            )
            enqueueDraft(queuedDraft)
            emitStopFlowDebug(
                "send_draft_enqueued",
                actionID: sendActionID,
                detail: [
                    "sendSequence": currentSendSequence,
                    "queueAfter": queuedDrafts.count,
                    "reason": isBusy ? "busy" : "queued_drafts_present",
                ],
                configuration: configuration
            )
            return true
        }

        let optimisticID = appendOptimisticMessage(from: draft)
        let sent = await sendQueuedDraft(
            draft,
            configuration: configuration,
            clientActionID: sendActionID,
            sendSequence: currentSendSequence
        )
        if !sent {
            let queuedDraft = QueuedDraft(
                id: draft.id,
                text: draft.text,
                attachments: draft.attachments,
                createdAt: draft.createdAt,
                optimisticMessageID: optimisticID,
                clientActionID: sendActionID
            )
            enqueueDraft(queuedDraft)
            emitStopFlowDebug(
                "send_draft_requeued_after_failure",
                actionID: sendActionID,
                detail: [
                    "sendSequence": currentSendSequence,
                    "queueAfter": queuedDrafts.count,
                ],
                configuration: configuration
            )
        }
        return true
    }

    func steerQueuedDraft() async {
        guard let configuration else { return }
        guard !isSending, !steeringInProgress else { return }
        guard !queuedDrafts.isEmpty else { return }
        if let blockedMessage = steerQueuedDraftBlockedMessage {
            errorMessage = blockedMessage
            return
        }

        let draft = queuedDrafts.removeFirst()
        updateQueueMetadata()
        steeringInProgress = true
        defer { steeringInProgress = false }

        if draft.optimisticMessageID == nil {
            _ = appendOptimisticMessage(from: draft)
        }
        let success = await sendQueuedDraft(
            draft,
            configuration: configuration,
            clientActionID: draft.clientActionID,
            sendSequence: nil
        )
        if !success {
            queuedDrafts.insert(draft, at: 0)
            updateQueueMetadata()
        }
    }

    func removeQueuedDraft(id: UUID) {
        let originalCount = queuedDrafts.count
        if let removed = queuedDrafts.first(where: { $0.id == id }),
           let optimisticMessageID = removed.optimisticMessageID {
            removeOptimisticMessage(id: optimisticMessageID)
        }
        queuedDrafts.removeAll { $0.id == id }
        if queuedDrafts.count == originalCount { return }
        updateQueueMetadata()
    }

    func interruptActiveTurn() async {
        guard let configuration else { return }
        let interruptActionID = makeClientActionID(prefix: "mobile-stop")
        activeInterruptActionID = interruptActionID
        if hasExternalSurfaceRun {
            errorMessage = "You cannot stop the current run because it was started on another Codex surface."
            emitStopFlowDebug(
                "stop_rejected_external_surface",
                actionID: interruptActionID,
                detail: [:],
                configuration: configuration
            )
            activeInterruptActionID = nil
            return
        }
        interruptingOptimistically = true
        settleOptimisticThinking()
        interruptVerificationTask?.cancel()
        let interruptTurnID = activeTurnID ?? (hasUnderlyingActiveRun ? "external-run" : nil)
        emitStopFlowDebug(
            "stop_requested",
            actionID: interruptActionID,
            turnID: interruptTurnID,
            detail: [:],
            configuration: configuration
        )
        do {
            let ack = try await apiClient.interruptThread(
                threadID: threadID,
                turnID: interruptTurnID,
                clientActionID: interruptActionID,
                config: configuration
            )
            emitStopFlowDebug(
                "stop_request_accepted",
                actionID: interruptActionID,
                turnID: interruptTurnID,
                detail: [
                    "pending": ack.pending ?? false,
                    "deduped": ack.deduped ?? false,
                    "retargeted": ack.retargeted ?? false,
                    "dedupedFallbackTriggered": ack.dedupedFallbackTriggered ?? false,
                    "clientActionIdEcho": ack.clientActionID ?? "",
                ],
                configuration: configuration
            )
            errorMessage = nil
            startInterruptVerificationLoop(configuration: configuration, actionID: interruptActionID)
        } catch {
            let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            emitStopFlowDebug(
                "stop_request_failed",
                actionID: interruptActionID,
                turnID: interruptTurnID,
                detail: ["error": message.isEmpty ? error.localizedDescription : message],
                configuration: configuration
            )
            if Self.isNoActiveTurnInterruptErrorMessage(message), hasUnderlyingActiveRun {
                // Keep optimistic stop while polling/stream catches up and keep retrying.
                errorMessage = nil
                startInterruptVerificationLoop(configuration: configuration, actionID: interruptActionID)
                return
            }
            interruptVerificationTask?.cancel()
            interruptVerificationTask = nil
            interruptingOptimistically = false
            activeInterruptActionID = nil
            errorMessage = message.isEmpty ? error.localizedDescription : message
        }
    }

    private var hasUnderlyingActiveRun: Bool {
        if suppressRunActivityDueToInactivity { return false }
        if let thread, thread.hasActiveRun {
            return true
        }
        return activeTurnID != nil
    }

    private func startInterruptVerificationLoop(configuration: ServerConfiguration, actionID: String?) {
        interruptVerificationTask?.cancel()
        interruptVerificationTask = Task { [weak self] in
            guard let self else { return }
            var firstCycle = true
            var attempt = 0
            while !Task.isCancelled {
                if !firstCycle {
                    try? await Task.sleep(nanoseconds: 700_000_000)
                    if Task.isCancelled { return }
                }
                firstCycle = false
                attempt += 1

                guard self.interruptingOptimistically else { return }
                if !self.hasUnderlyingActiveRun {
                    self.interruptingOptimistically = false
                    self.activeInterruptActionID = nil
                    self.emitStopFlowDebug(
                        "stop_verify_loop_settled",
                        actionID: actionID,
                        detail: ["attempt": attempt],
                        configuration: configuration
                    )
                    return
                }

                do {
                    let interruptTurnID = self.activeTurnID ?? (self.hasUnderlyingActiveRun ? "external-run" : nil)
                    let ack = try await self.apiClient.interruptThread(
                        threadID: self.threadID,
                        turnID: interruptTurnID,
                        clientActionID: actionID,
                        config: configuration
                    )
                    self.emitStopFlowDebug(
                        "stop_verify_retry_sent",
                        actionID: actionID,
                        turnID: interruptTurnID,
                        detail: [
                            "attempt": attempt,
                            "pending": ack.pending ?? false,
                            "deduped": ack.deduped ?? false,
                            "retargeted": ack.retargeted ?? false,
                        ],
                        configuration: configuration
                    )
                } catch {
                    self.emitStopFlowDebug(
                        "stop_verify_retry_failed",
                        actionID: actionID,
                        detail: [
                            "attempt": attempt,
                            "error": error.localizedDescription,
                        ],
                        configuration: configuration
                    )
                    // Keep optimistic stop visible while stream/polling reconciliation continues.
                }
                await self.refresh(showLoader: false)
            }
        }
    }

    func canSendDraft(text: String) -> Bool {
        (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty) && !isSending
    }

    var steerQueuedDraftBlockedMessage: String? {
        if hasExternalSurfaceRun {
            return "You cannot steer because the current run was started on another Codex surface. Your queued message will send automatically when the current run finishes."
        }
        if hasActiveRun && !steerEnabled {
            return "Steer is disabled in this Codex config. Enable `features.steer` to steer during a run."
        }
        return nil
    }

    var canSteerQueuedDraft: Bool {
        queuedCount > 0 && !isSending && !steeringInProgress && steerQueuedDraftBlockedMessage == nil
    }

    var canInterruptActiveRun: Bool {
        hasActiveRun
    }

    var isSyncing: Bool {
        hasActiveRun || steeringInProgress || optimisticThinkingVisible
    }

    var isBusy: Bool {
        isSending || steeringInProgress || hasActiveRun
    }

    var activeTurnID: String? {
        guard let thread else { return nil }
        for turn in thread.turns.reversed() {
            if Self.isTurnRunning(turn.status) {
                return turn.id
            }
        }
        if thread.externalRun?.active == true,
           Self.normalizeExternalRunOwner(thread.externalRun?.owner) == "local",
           let externalTurnID = thread.externalRun?.turnID,
           !externalTurnID.isEmpty {
            return externalTurnID
        }
        return nil
    }

    private var hasActiveRun: Bool {
        if suppressRunActivityDueToInactivity { return false }
        if interruptingOptimistically { return false }
        if let thread, thread.hasActiveRun { return true }
        return activeTurnID != nil
    }

    private var hasExternalSurfaceRun: Bool {
        guard let thread else { return false }
        guard thread.externalRun?.active == true else { return false }
        let owner = Self.normalizeExternalRunOwner(thread.externalRun?.owner)
        if owner == "local" { return false }
        if owner == "external" { return true }
        guard !thread.turns.isEmpty else { return false }
        return activeTurnID == nil
    }

    private static func normalizeExternalRunOwner(_ value: String?) -> String {
        let normalized = (value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        if normalized == "local" || normalized == "external" || normalized == "none" {
            return normalized
        }
        return "none"
    }

    private static func isExternalSurfaceControlErrorMessage(_ message: String) -> Bool {
        let normalized = message
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        if normalized.isEmpty { return false }
        if !normalized.contains("another codex surface") { return false }
        return normalized.contains("cannot stop") || normalized.contains("cannot steer")
    }

    private static func isNoActiveTurnInterruptErrorMessage(_ message: String) -> Bool {
        let normalized = message
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        if normalized.isEmpty { return false }
        if !normalized.contains("no active turn") { return false }
        return normalized.contains("interrupt")
    }

    private static func isOutOfCreditErrorMessage(_ message: String) -> Bool {
        let normalized = message
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        if normalized.isEmpty { return false }
        if normalized.contains("insufficient_quota") || normalized.contains("out_of_credit") {
            return true
        }
        return normalized.contains("out of credit")
            || normalized.contains("out-of-credit")
            || normalized.contains("insufficient quota")
            || normalized.contains("exceeded your current quota")
            || normalized.contains("billing hard limit")
            || normalized.contains("quota exceeded")
            || normalized.contains("usage limit reached")
    }

    private static func outOfCreditBannerMessage(_ message: String?) -> String {
        let fallback = "Out of Credit. Please add billing credits to continue."
        guard let message else { return fallback }
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return fallback }
        if trimmed.count <= 220 { return trimmed }
        let index = trimmed.index(trimmed.startIndex, offsetBy: 217)
        return "\(trimmed[..<index])..."
    }

    private func noteStreamActivity() {
        lastStreamActivityAt = Date()
        if suppressRunActivityDueToInactivity {
            suppressRunActivityDueToInactivity = false
        }
    }

    private func forceStopSyncing(reason: String? = nil, outOfCredit: String? = nil) {
        suppressRunActivityDueToInactivity = true
        interruptingOptimistically = false
        interruptVerificationTask?.cancel()
        interruptVerificationTask = nil
        activeInterruptActionID = nil
        settleOptimisticThinking()
        clearThreadRunOptimisticMarker()
        if let reason {
            errorMessage = reason
        }
        if outOfCredit != nil {
            outOfCreditMessage = Self.outOfCreditBannerMessage(outOfCredit)
        }
    }

    @discardableResult
    private func detectOutOfCreditIfNeeded(_ message: String?) -> Bool {
        let trimmed = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard Self.isOutOfCreditErrorMessage(trimmed) else { return false }
        forceStopSyncing(outOfCredit: trimmed)
        return true
    }

    private func startStreamInactivityWatchdog() {
        streamInactivityWatchdogTask?.cancel()
        streamInactivityWatchdogTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.streamInactivityWatchdogTickNanos)
                if Task.isCancelled { return }
                let hasRunSignals =
                    hasUnderlyingActiveRun ||
                    optimisticThinkingPending ||
                    optimisticThinkingVisible ||
                    interruptingOptimistically
                if !hasRunSignals { continue }
                if suppressRunActivityDueToInactivity { continue }
                let idleSeconds = max(0, Date().timeIntervalSince(lastStreamActivityAt))
                if idleSeconds < Self.streamInactivityTimeoutSeconds { continue }
                forceStopSyncing(reason: "No updates for over 10 minutes. Stopped thinking spinner.")
            }
        }
    }

    private func scheduleTransientErrorAutoClearIfNeeded() {
        transientErrorAutoClearTask?.cancel()
        transientErrorAutoClearTask = nil

        guard let rawMessage = errorMessage else { return }
        let message = rawMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        guard Self.isExternalSurfaceControlErrorMessage(message) else { return }

        transientErrorAutoClearTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.transientSurfaceControlErrorLifetimeNanos)
            guard let self else { return }
            guard let current = self.errorMessage?.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
            guard current == message else { return }
            self.errorMessage = nil
        }
    }

    private func enqueueDraft(_ draft: QueuedDraft) {
        queuedDrafts.append(draft)
        updateQueueMetadata()
    }

    nonisolated private static func prepareImageAttachment(from imageData: Data) -> PendingImageAttachment? {
        autoreleasepool {
            guard let image = downsampledImage(from: imageData, maxPixelSize: maxAttachmentPixelSize)
                ?? UIImage(data: imageData)
            else {
                return nil
            }

            let normalizedData = image.jpegData(compressionQuality: 0.84) ?? imageData
            let previewImage = image.preparingThumbnail(of: previewThumbnailSize) ?? image
            let fileStamp = Int(Date().timeIntervalSince1970 * 1000)
            let uniqueSuffix = UUID().uuidString.lowercased().prefix(6)

            return PendingImageAttachment(
                filename: "photo-\(fileStamp)-\(uniqueSuffix).jpg",
                mimeType: "image/jpeg",
                data: normalizedData,
                previewImage: previewImage
            )
        }
    }

    nonisolated private static func prepareFileAttachment(
        filename: String,
        mimeType: String,
        data: Data,
        previewImage: UIImage?
    ) -> PendingImageAttachment? {
        guard !data.isEmpty else { return nil }
        let sanitizedName = filename.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedFilename = sanitizedName.isEmpty ? "attachment.bin" : sanitizedName
        let resolvedMimeType = mimeType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "application/octet-stream"
            : mimeType
        return PendingImageAttachment(
            filename: resolvedFilename,
            mimeType: resolvedMimeType,
            data: data,
            previewImage: previewImage
        )
    }

    nonisolated private static func downsampledImage(from data: Data, maxPixelSize: CGFloat) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            return nil
        }

        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(maxPixelSize.rounded(.up)),
        ]

        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }

        return UIImage(cgImage: cgImage)
    }

    private func updateQueueMetadata() {
        queuedCount = queuedDrafts.count
        queuedPreview = Self.queuedPreviewText(for: queuedDrafts.first)
        queuedRows = queuedDrafts.map(Self.queuedRow(for:))
    }

    private static func queuedPreviewText(for draft: QueuedDraft?) -> String {
        guard let draft else { return "" }
        let normalizedText = draft.text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalizedText.isEmpty {
            if normalizedText.count > 80 {
                let index = normalizedText.index(normalizedText.startIndex, offsetBy: 80)
                return "\(normalizedText[..<index])..."
            }
            return normalizedText
        }
        let attachmentCount = draft.attachments.count
        if attachmentCount <= 0 { return "Pending message" }
        return attachmentCount == 1 ? "1 attachment" : "\(attachmentCount) attachments"
    }

    private static func queuedDetailText(for draft: QueuedDraft) -> String? {
        let attachmentCount = draft.attachments.count
        if attachmentCount <= 0 {
            return nil
        }
        return attachmentCount == 1 ? "1 attachment" : "\(attachmentCount) attachments"
    }

    private static func queuedRow(for draft: QueuedDraft) -> QueuedDraftRow {
        QueuedDraftRow(
            id: draft.id,
            preview: queuedPreviewText(for: draft),
            detail: queuedDetailText(for: draft)
        )
    }

    private func sendQueuedDraft(
        _ draft: QueuedDraft,
        configuration: ServerConfiguration,
        clientActionID: String?,
        sendSequence: Int?
    ) async -> Bool {
        markThreadRunOptimisticallyActive()
        noteStreamActivity()
        isSending = true
        defer { isSending = false }
        beginOptimisticThinkingDelay()
        emitStopFlowDebug(
            "send_dispatch_started",
            actionID: clientActionID,
            detail: [
                "sendSequence": sendSequence ?? -1,
                "textLength": draft.text.count,
                "attachmentCount": draft.attachments.count,
                "queueSize": queuedDrafts.count,
            ],
            configuration: configuration
        )

        do {
            var preparedAttachments: [PocketDexPreparedAttachment] = []
            for attachment in draft.attachments {
                let uploaded = try await apiClient.uploadAttachment(
                    threadID: threadID,
                    attachment: attachment,
                    config: configuration
                )
                preparedAttachments.append(uploaded)
            }
            let ack = try await apiClient.sendMessage(
                threadID: threadID,
                text: draft.text,
                preparedAttachments: preparedAttachments,
                clientActionID: clientActionID,
                config: configuration
            )
            emitStopFlowDebug(
                "send_dispatch_accepted",
                actionID: clientActionID,
                detail: [
                    "sendSequence": sendSequence ?? -1,
                    "traceId": ack.traceID ?? "",
                    "accepted": ack.accepted ?? false,
                    "clientActionIdEcho": ack.clientActionID ?? "",
                ],
                configuration: configuration
            )
            errorMessage = nil
            outOfCreditMessage = nil
            scheduleDeferredRefresh(delayNanoseconds: 0, force: true)
            return true
        } catch {
            if !hasActiveRun {
                clearThreadRunOptimisticMarker()
            }
            beginOptimisticThinkingDelay()
            let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            if !detectOutOfCreditIfNeeded(message) {
                errorMessage = message.isEmpty ? error.localizedDescription : message
            } else {
                errorMessage = nil
            }
            emitStopFlowDebug(
                "send_dispatch_failed",
                actionID: clientActionID,
                detail: [
                    "sendSequence": sendSequence ?? -1,
                    "error": message.isEmpty ? error.localizedDescription : message,
                ],
                configuration: configuration
            )
            return false
        }
    }

    private func applyThreadSnapshot(_ loadedThread: PocketDexThreadDetail) {
        let previousHadActiveRun = hasActiveRun

        reconcileOptimisticMessages(with: loadedThread)

        thread = loadedThread
        displayTitle = loadedThread.displayTitle
        displaySubtitle = loadedThread.cwd.isEmpty ? fallbackCwd : loadedThread.cwd

        let rebuiltTimeline = buildTimeline(from: loadedThread)
        timeline = rebuiltTimeline

        if !loadedThread.hasActiveRun && optimisticMessages.isEmpty {
            settleOptimisticThinking()
        }
        if !loadedThread.hasActiveRun && interruptingOptimistically {
            interruptingOptimistically = false
            interruptVerificationTask?.cancel()
            interruptVerificationTask = nil
            activeInterruptActionID = nil
        }
        if previousHadActiveRun != loadedThread.hasActiveRun || interruptingOptimistically {
            emitStopFlowDebug(
                "thread_snapshot_state",
                actionID: activeInterruptActionID,
                turnID: activeTurnID,
                detail: [
                    "previousHadActiveRun": previousHadActiveRun,
                    "nextHadActiveRun": loadedThread.hasActiveRun,
                    "turnCount": loadedThread.turns.count,
                    "externalRunActive": loadedThread.externalRun?.active == true,
                    "externalRunOwner": loadedThread.externalRun?.owner ?? "none",
                    "externalRunTurnId": loadedThread.externalRun?.turnID ?? "",
                    "interruptingOptimistically": interruptingOptimistically,
                ],
                configuration: configuration
            )
        }
        maybeHealThreadRunOptimism(hasActiveRun: loadedThread.hasActiveRun)
        maybeAutoSendQueuedDraftAfterRunCompletion(previousHadActiveRun: previousHadActiveRun)
    }

    private func maybeAutoSendQueuedDraftAfterRunCompletion(previousHadActiveRun: Bool) {
        guard previousHadActiveRun else { return }
        guard !hasActiveRun else { return }
        guard !queuedDrafts.isEmpty else { return }
        guard !isSending, !steeringInProgress else { return }
        Task { [weak self] in
            guard let self else { return }
            await self.steerQueuedDraft()
        }
    }

    private func appendOptimisticMessage(from draft: QueuedDraft) -> String {
        let trimmed = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachmentCount = draft.attachments.count
        let fallbackText: String
        if !trimmed.isEmpty {
            fallbackText = trimmed
        } else if attachmentCount == 1 {
            fallbackText = "[1 attachment]"
        } else if attachmentCount == 0 {
            fallbackText = "Pending message"
        } else {
            fallbackText = "[\(attachmentCount) attachments]"
        }

        let optimisticAttachments = draft.attachments.map { attachment in
            let trimmedName = attachment.filename.trimmingCharacters(in: .whitespacesAndNewlines)
            let filename = trimmedName.isEmpty ? "attachment.bin" : trimmedName
            return OptimisticAttachment(
                filename: filename,
                imageData: attachment.isImage ? attachment.data : nil
            )
        }

        let id = "optimistic-user-\(UUID().uuidString.lowercased())"
        let signature = Self.userMessageSignature(text: trimmed, attachmentCount: attachmentCount)
        optimisticMessages.append(
            OptimisticMessage(
                id: id,
                text: fallbackText,
                attachments: optimisticAttachments,
                signature: signature
            )
        )
        if let thread {
            timeline = buildTimeline(from: thread)
        }
        return id
    }

    private func removeOptimisticMessage(id: String) {
        let previousCount = optimisticMessages.count
        optimisticMessages.removeAll { $0.id == id }
        if optimisticMessages.count == previousCount { return }
        if let thread {
            timeline = buildTimeline(from: thread)
        }
        if optimisticMessages.isEmpty && !(thread?.hasActiveRun ?? false) {
            settleOptimisticThinking()
        }
    }

    private func beginOptimisticThinkingDelay() {
        optimisticThinkingPending = true
        optimisticThinkingVisible = false
        optimisticThinkingTask?.cancel()
        optimisticHealTask?.cancel()
        optimisticThinkingTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: 500_000_000)
            if Task.isCancelled { return }
            guard optimisticThinkingPending else { return }
            guard !(thread?.hasActiveRun ?? false) else { return }
            optimisticThinkingPending = false
            optimisticThinkingVisible = true
        }
        optimisticHealTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            if Task.isCancelled { return }
            guard optimisticThinkingPending || optimisticThinkingVisible else { return }
            await refresh(showLoader: false)
        }
    }

    private func settleOptimisticThinking() {
        optimisticThinkingPending = false
        optimisticThinkingTask?.cancel()
        optimisticThinkingTask = nil
        optimisticHealTask?.cancel()
        optimisticHealTask = nil
        optimisticThinkingVisible = false
    }

    private func markThreadRunOptimisticallyActive() {
        ThreadRunOptimismStore.markActive(threadID: threadID)
    }

    private func clearThreadRunOptimisticMarker() {
        ThreadRunOptimismStore.clear(threadID: threadID)
    }

    private func maybeHealThreadRunOptimism(hasActiveRun: Bool) {
        guard !hasActiveRun else { return }
        guard !isSending, !steeringInProgress else { return }
        guard !optimisticThinkingPending, !optimisticThinkingVisible else { return }
        clearThreadRunOptimisticMarker()
    }

    private func refreshSteerCapabilityIfNeeded(cwd: String, configuration: ServerConfiguration) async {
        let normalized = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized == capabilityCwd { return }
        capabilityCwd = normalized
        do {
            let config = try await apiClient.readConfig(cwd: normalized, config: configuration)
            steerEnabled = config?.features?.steer != false
        } catch {
            // Keep optimistic steering enabled when config cannot be read.
            steerEnabled = true
        }
    }

    private func restartNetworkCycle() {
        pollingTask?.cancel()
        pollingTask = nil
        deferredRefreshTask?.cancel()
        deferredRefreshTask = nil
        streamInactivityWatchdogTask?.cancel()
        streamInactivityWatchdogTask = nil

        streamClient?.disconnect()
        streamClient = nil
        streamConnected = false
        suppressRunActivityDueToInactivity = false
        lastStreamActivityAt = Date()

        guard configuration != nil else {
            errorMessage = "Server configuration is missing."
            return
        }

        startStreamInactivityWatchdog()
        connectStream()
        pollingTask = Task { [weak self] in
            guard let self else { return }
            await refresh(showLoader: true)
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                if Task.isCancelled { break }
                await refresh(showLoader: false)
            }
        }
    }

    private func reconnectStream() {
        streamClient?.disconnect()
        streamClient = nil
        streamConnected = false
        connectStream()
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
        stream.subscribe(threadID: threadID, resume: true, resumeFrom: lastSyncedSeq > 0 ? lastSyncedSeq : nil)
    }

    private func handleStreamEvent(_ event: PocketDexStreamEvent) {
        switch event {
        case .connected:
            streamConnected = true
            noteStreamActivity()
            streamClient?.subscribe(threadID: threadID, resume: true, resumeFrom: lastSyncedSeq > 0 ? lastSyncedSeq : nil)
            Task { [weak self] in
                guard let self else { return }
                await refresh(showLoader: false)
            }
        case .disconnected:
            streamConnected = false
        case let .error(message):
            streamConnected = false
            if detectOutOfCreditIfNeeded(message) {
                errorMessage = nil
            } else if !message.isEmpty {
                errorMessage = message
            }
        case let .threadSync(threadID: syncedThreadID, latestSeq: latestSeq):
            guard syncedThreadID == threadID else { return }
            noteStreamActivity()
            rememberSyncedSeq(latestSeq)
        case let .threadSnapshot(threadID: snapshotThreadID, seqBase: seqBase, thread: threadPayload):
            guard snapshotThreadID == threadID else { return }
            noteStreamActivity()
            rememberSyncedSeq(seqBase)
            guard let threadPayload else {
                scheduleDeferredRefresh(delayNanoseconds: 0, force: true)
                return
            }

            guard let data = try? JSONSerialization.data(withJSONObject: threadPayload) else {
                scheduleDeferredRefresh(delayNanoseconds: 0, force: true)
                return
            }
            guard let snapshotThread = try? decoder.decode(PocketDexThreadDetail.self, from: data) else {
                scheduleDeferredRefresh(delayNanoseconds: 0, force: true)
                return
            }
            applyThreadSnapshot(snapshotThread)
            Task { [weak self] in
                guard let self else { return }
                guard let configuration = self.configuration else { return }
                await refreshSteerCapabilityIfNeeded(cwd: self.displaySubtitle, configuration: configuration)
            }
        case let .request(id, method, _):
            if method == "item/commandExecution/requestApproval" || method == "item/fileChange/requestApproval" {
                streamClient?.approveRequest(id: id)
            } else {
                streamClient?.rejectRequest(id: id, message: "Unsupported request")
            }
        case let .notification(method, params, seq, threadID: eventThreadID):
            let resolvedThreadID = eventThreadID ?? Self.extractThreadID(from: params)
            if let resolvedThreadID, resolvedThreadID != threadID {
                return
            }
            if let seq {
                if seq <= lastSyncedSeq {
                    return
                }
                if lastSyncedSeq > 0 && seq > lastSyncedSeq + 1 {
                    streamClient?.subscribe(threadID: threadID, resume: true, resumeFrom: lastSyncedSeq)
                    return
                }
                rememberSyncedSeq(seq)
            }
            noteStreamActivity()
            if method == "turn/started" || method == "item/started" {
                settleOptimisticThinking()
            }
            if method == "turn/started" || method == "turn/completed" || method == "turn/aborted" || method == "error" {
                emitStopFlowDebug(
                    "stream_turn_notification",
                    actionID: activeInterruptActionID,
                    turnID: Self.extractTurnID(from: params),
                    detail: [
                        "method": method,
                        "seq": seq ?? -1,
                        "resolvedThreadId": resolvedThreadID ?? "",
                    ],
                    configuration: configuration
                )
            }
            if method == "pocketdex/turn-start-failed" {
                optimisticMessages.removeAll()
                settleOptimisticThinking()
                let error = (params["error"] as? String) ?? ""
                if detectOutOfCreditIfNeeded(error) {
                    errorMessage = nil
                }
                if let thread {
                    timeline = buildTimeline(from: thread)
                }
                emitStopFlowDebug(
                    "stream_turn_start_failed",
                    actionID: activeInterruptActionID,
                    detail: [
                        "traceId": (params["traceId"] as? String) ?? "",
                        "error": (params["error"] as? String) ?? "",
                    ],
                    configuration: configuration
                )
            }
            if method == "error" {
                let message = (params["error"] as? String)
                    ?? (params["message"] as? String)
                    ?? ((params["turn"] as? [String: Any])?["error"] as? String)
                if detectOutOfCreditIfNeeded(message) {
                    errorMessage = nil
                }
            }
            guard shouldRefresh(for: method, params: params) else { return }
            if method.hasSuffix("/delta") || method.hasPrefix("codex/event/") {
                scheduleDeferredRefresh(delayNanoseconds: Self.streamDeltaRefreshDelayNanos)
            } else {
                scheduleDeferredRefresh(delayNanoseconds: Self.streamRefreshDelayNanos)
            }
        }
    }

    private func rememberSyncedSeq(_ seq: Int) {
        let normalized = max(0, seq)
        if normalized <= lastSyncedSeq { return }
        lastSyncedSeq = normalized
        Self.persistStoredSeq(normalized, for: threadID)
    }

    private static func loadStoredSeq(for threadID: String) -> Int {
        let key = threadSeqStorePrefix + threadID
        let value = UserDefaults.standard.integer(forKey: key)
        return max(0, value)
    }

    private static func persistStoredSeq(_ seq: Int, for threadID: String) {
        let key = threadSeqStorePrefix + threadID
        UserDefaults.standard.set(max(0, seq), forKey: key)
    }

    private func shouldRefresh(for method: String, params: [String: Any]) -> Bool {
        if method == "thread/name/updated" || method == "thread/started" || method == "turn/completed" || method == "pocketdex/external-run-state" {
            return true
        }
        if method.hasPrefix("item/") || method.hasPrefix("turn/") || method.hasPrefix("codex/event/") {
            if let eventThreadID = Self.extractThreadID(from: params) {
                return eventThreadID == threadID
            }
            return true
        }
        return false
    }

    private func scheduleDeferredRefresh(
        delayNanoseconds: UInt64,
        force: Bool = false
    ) {
        if force {
            deferredRefreshTask?.cancel()
            deferredRefreshTask = nil
        } else if deferredRefreshTask != nil {
            return
        }
        deferredRefreshTask = Task { [weak self] in
            guard let self else { return }
            defer { self.deferredRefreshTask = nil }
            if delayNanoseconds > 0 {
                try? await Task.sleep(nanoseconds: delayNanoseconds)
                if Task.isCancelled { return }
            }
            await self.refresh(showLoader: false)
        }
    }

    private func buildTimeline(from thread: PocketDexThreadDetail) -> [ConversationTimelineItem] {
        var rows: [ConversationTimelineItem] = []
        let suppressFinalMarkers = thread.hasActiveRun
        for turn in thread.turns {
            var turnRows: [ConversationTimelineItem] = []
            var lastAssistantIndex: Int?
            for (itemIndex, item) in turn.items.enumerated() {
                let itemBaseID = "turn-\(turn.id)-item-\(itemIndex)-\(item.id)"
                switch item.type {
                case "userMessage":
                    let parsed = parseUserInputs(item.userContent)
                    if !parsed.text.isEmpty {
                        turnRows.append(
                            ConversationTimelineItem(
                                id: "\(itemBaseID)-user-text",
                                kind: .userText(parsed.text)
                            )
                        )
                    }
                    for (index, attachment) in parsed.imageAttachments.enumerated() {
                        let rowID = "\(itemBaseID)-user-image-\(index)"
                        if attachment.path != nil || attachment.remoteURL != nil {
                            turnRows.append(
                                ConversationTimelineItem(
                                    id: rowID,
                                    kind: .userImage(path: attachment.path, remoteURL: attachment.remoteURL)
                                )
                            )
                        }
                    }
                    for (index, attachment) in parsed.fileAttachments.enumerated() {
                        turnRows.append(
                            ConversationTimelineItem(
                                id: "\(itemBaseID)-user-file-\(index)",
                                kind: .userFile(name: attachment.name, path: attachment.path)
                            )
                        )
                    }
                case "agentMessage":
                    let text = item.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    if !text.isEmpty {
                        turnRows.append(
                            ConversationTimelineItem(
                                id: "\(itemBaseID)-assistant",
                                kind: .assistantMarkdown(text)
                            )
                        )
                        lastAssistantIndex = turnRows.count - 1
                    }
                case "plan":
                    let text = item.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    if !text.isEmpty {
                        turnRows.append(
                            ConversationTimelineItem(
                                id: "\(itemBaseID)-plan",
                                kind: .plan(text)
                            )
                        )
                    }
                case "reasoning":
                    let summaryParts = item.summary
                        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                        .filter { !$0.isEmpty }
                    let contentParts = item.reasoningContent
                        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                        .filter { !$0.isEmpty }
                    if !summaryParts.isEmpty || !contentParts.isEmpty {
                        turnRows.append(
                            ConversationTimelineItem(
                                id: "\(itemBaseID)-reasoning",
                                kind: .reasoning(summary: summaryParts, content: contentParts)
                            )
                        )
                    }
                case "commandExecution", "command_execution":
                    let command = item.command?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Command"
                    let output = item.aggregatedOutput?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    turnRows.append(
                        ConversationTimelineItem(
                            id: "\(itemBaseID)-command",
                            kind: .command(
                                command: command,
                                output: output,
                                status: item.status ?? "",
                                durationMs: item.durationMs,
                                actions: item.commandActions
                            )
                        )
                    )
                case "fileChange", "file_change":
                    let validChanges = item.changes.filter { !$0.path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                    if !validChanges.isEmpty {
                        turnRows.append(
                            ConversationTimelineItem(
                                id: "\(itemBaseID)-file-change",
                                kind: .fileChange(status: item.status ?? "", changes: validChanges)
                            )
                        )
                    }
                case "turnDiff", "turn_diff":
                    let parsedChanges = Self.parseUnifiedDiffChanges(item.diff ?? "")
                    if !parsedChanges.isEmpty {
                        turnRows.append(
                            ConversationTimelineItem(
                                id: "\(itemBaseID)-turn-diff",
                                kind: .fileChange(status: item.status ?? "", changes: parsedChanges)
                            )
                        )
                    }
                case "contextCompaction", "context_compaction":
                    turnRows.append(
                        ConversationTimelineItem(
                            id: "\(itemBaseID)-context-compaction",
                            kind: .contextCompaction
                        )
                    )
                default:
                    continue
                }
            }

            if !suppressFinalMarkers, Self.isTurnTerminalStatus(turn.status), let lastAssistantIndex {
                let current = turnRows[lastAssistantIndex]
                turnRows[lastAssistantIndex] = ConversationTimelineItem(
                    id: current.id,
                    kind: current.kind,
                    isFinal: true,
                    workedMs: Self.turnWorkedMs(turn)
                )
            }

            rows.append(contentsOf: turnRows)
        }
        if !optimisticMessages.isEmpty {
            for optimistic in optimisticMessages {
                rows.append(
                    ConversationTimelineItem(
                        id: optimistic.id,
                        kind: .userText(optimistic.text)
                    )
                )
                for (index, attachment) in optimistic.attachments.enumerated() {
                    let attachmentID = "\(optimistic.id)-attachment-\(index)"
                    if let imageData = attachment.imageData {
                        rows.append(
                            ConversationTimelineItem(
                                id: attachmentID,
                                kind: .userImageData(imageData)
                            )
                        )
                    } else {
                        rows.append(
                            ConversationTimelineItem(
                                id: attachmentID,
                                kind: .userFile(name: attachment.filename, path: nil)
                            )
                        )
                    }
                }
            }
        }
        return rows
    }

    private func parseUserInputs(_ content: [PocketDexUserInput]) -> (
        text: String,
        imageAttachments: [(path: String?, remoteURL: String?)],
        fileAttachments: [(name: String, path: String?)]
    ) {
        var textParts: [String] = []
        var imageAttachments: [(path: String?, remoteURL: String?)] = []
        var fileAttachments: [(name: String, path: String?)] = []

        for input in content {
            switch input.type {
            case "text":
                if let text = input.text {
                    textParts.append(text)
                }
            case "image":
                imageAttachments.append((path: nil, remoteURL: input.url))
            case "localImage":
                imageAttachments.append((path: input.path, remoteURL: nil))
            case "mention":
                let normalizedPath = input.path?.trimmingCharacters(in: .whitespacesAndNewlines)
                let resolvedPath = normalizedPath.flatMap { $0.isEmpty ? nil : $0 }
                let normalizedName = input.name?.trimmingCharacters(in: .whitespacesAndNewlines)
                let fallbackName = resolvedPath.map(Self.basename) ?? "attachment"
                let resolvedName = normalizedName.flatMap { $0.isEmpty ? nil : $0 } ?? fallbackName
                fileAttachments.append((name: resolvedName, path: resolvedPath))
            default:
                continue
            }
        }

        let rawText = textParts.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return (
            text: Self.stripIDEContext(from: rawText),
            imageAttachments: imageAttachments,
            fileAttachments: fileAttachments
        )
    }

    private func reconcileOptimisticMessages(with loadedThread: PocketDexThreadDetail) {
        struct ServerUserMessage {
            let id: String
            let signature: String
        }

        var serverMessages: [ServerUserMessage] = []
        for turn in loadedThread.turns {
            for item in turn.items where item.type == "userMessage" {
                let parsed = parseUserInputs(item.userContent)
                let signature = Self.userMessageSignature(
                    text: parsed.text,
                    attachmentCount: parsed.imageAttachments.count + parsed.fileAttachments.count
                )
                serverMessages.append(ServerUserMessage(id: item.id, signature: signature))
            }
        }

        let currentUserMessageIDs = Set(serverMessages.map(\.id))
        let newServerMessages = serverMessages.filter { !knownUserMessageIDs.contains($0.id) }
        knownUserMessageIDs = currentUserMessageIDs

        guard !newServerMessages.isEmpty, !optimisticMessages.isEmpty else { return }

        var nextOptimisticMessages = optimisticMessages
        var didConsume = false
        for message in newServerMessages {
            guard let index = nextOptimisticMessages.firstIndex(where: { $0.signature == message.signature }) else {
                continue
            }
            nextOptimisticMessages.remove(at: index)
            didConsume = true
            if nextOptimisticMessages.isEmpty {
                break
            }
        }

        if didConsume {
            optimisticMessages = nextOptimisticMessages
        }
    }

    private static func userMessageSignature(text: String, attachmentCount: Int) -> String {
        let normalizedText = normalizeSignatureText(text)
        if !normalizedText.isEmpty {
            return "text:\(normalizedText)"
        }
        if attachmentCount > 0 {
            return "attachments:\(attachmentCount)"
        }
        return "empty"
    }

    private static func normalizeSignatureText(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\n", with: " ")
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func basename(_ path: String) -> String {
        let normalized = path.replacingOccurrences(of: "\\", with: "/")
        return normalized.split(separator: "/").last.map(String.init) ?? path
    }

    private static func parseUnifiedDiffChanges(_ diff: String) -> [PocketDexFileChange] {
        let normalized = diff.replacingOccurrences(of: "\r\n", with: "\n")
        guard !normalized.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return []
        }

        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var entries: [PocketDexFileChange] = []
        var currentPath: String?
        var currentLines: [String] = []

        func flushCurrent() {
            guard let currentPath else { return }
            let trimmedPath = currentPath.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedPath.isEmpty else { return }
            let chunk = currentLines.joined(separator: "\n")
            entries.append(
                PocketDexFileChange(
                    path: trimmedPath,
                    kind: "modify",
                    diff: chunk
                )
            )
        }

        for line in lines {
            if line.hasPrefix("diff --git ") {
                flushCurrent()
                currentLines = [line]
                currentPath = extractDiffPath(fromGitLine: line)
                continue
            }

            if currentPath == nil, line.hasPrefix("+++ b/") {
                currentPath = String(line.dropFirst(6))
                currentLines = [line]
                continue
            }

            if currentPath != nil {
                currentLines.append(line)
            }
        }

        flushCurrent()
        return entries
    }

    private static func extractDiffPath(fromGitLine line: String) -> String? {
        guard let range = line.range(of: " b/") else { return nil }
        let path = String(line[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? nil : path
    }

    private static func stripIDEContext(from text: String) -> String {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = normalized.lowercased()
        let marker = "my request for codex:"
        let header = "context from my ide setup"

        guard lower.contains(header) || lower.contains(marker) else {
            return normalized
        }

        guard let markerRange = normalized.range(of: marker, options: [.caseInsensitive]) else {
            return ""
        }

        let startIndex = markerRange.upperBound
        let suffix = normalized[startIndex...]
        return String(suffix).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func makeClientActionID(prefix: String) -> String {
        let normalizedPrefix = prefix.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalizedPrefix.isEmpty {
            return UUID().uuidString.lowercased()
        }
        return "\(normalizedPrefix)-\(UUID().uuidString.lowercased())"
    }

    private func stopFlowClientStateSnapshot() -> [String: Any] {
        let activeThread = thread
        return [
            "isLoading": isLoading,
            "isSending": isSending,
            "steeringInProgress": steeringInProgress,
            "interruptingOptimistically": interruptingOptimistically,
            "hasActiveRun": hasActiveRun,
            "hasUnderlyingActiveRun": hasUnderlyingActiveRun,
            "hasExternalSurfaceRun": hasExternalSurfaceRun,
            "activeTurnId": activeTurnID ?? "",
            "queuedCount": queuedCount,
            "timelineCount": timeline.count,
            "streamConnected": streamConnected,
            "optimisticThinkingVisible": optimisticThinkingVisible,
            "threadHasActiveRun": activeThread?.hasActiveRun ?? false,
            "externalRunActive": activeThread?.externalRun?.active ?? false,
            "externalRunOwner": activeThread?.externalRun?.owner ?? "none",
            "externalRunTurnId": activeThread?.externalRun?.turnID ?? "",
        ]
    }

    private func emitStopFlowDebug(
        _ event: String,
        actionID: String? = nil,
        turnID: String? = nil,
        detail: [String: Any],
        configuration: ServerConfiguration?
    ) {
        guard let configuration else { return }
        let trimmedEvent = event.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedEvent.isEmpty else { return }

        stopFlowDebugSequence += 1
        var payload: [String: Any] = detail
        payload["sessionId"] = stopFlowDebugSessionID
        payload["sequence"] = stopFlowDebugSequence
        if let actionID {
            let trimmedActionID = actionID.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedActionID.isEmpty {
                payload["clientActionId"] = trimmedActionID
            }
        }
        payload["clientState"] = stopFlowClientStateSnapshot()

        let resolvedTurnID = turnID ?? activeTurnID
        Task { [apiClient, threadID] in
            await apiClient.logStopFlowDebug(
                threadID: threadID,
                turnID: resolvedTurnID,
                event: trimmedEvent,
                detail: payload,
                config: configuration
            )
        }
    }

    private static func extractTurnID(from payload: [String: Any]) -> String? {
        if let turnID = payload["turnId"] as? String {
            return turnID
        }
        if let turnID = payload["turn_id"] as? String {
            return turnID
        }
        if let turn = payload["turn"] as? [String: Any] {
            if let turnID = turn["id"] as? String {
                return turnID
            }
            if let turnID = turn["turnId"] as? String {
                return turnID
            }
            if let turnID = turn["turn_id"] as? String {
                return turnID
            }
        }
        if let item = payload["item"] as? [String: Any] {
            if let turnID = item["turnId"] as? String {
                return turnID
            }
            if let turnID = item["turn_id"] as? String {
                return turnID
            }
            if let turn = item["turn"] as? [String: Any] {
                if let turnID = turn["id"] as? String {
                    return turnID
                }
                if let turnID = turn["turnId"] as? String {
                    return turnID
                }
                if let turnID = turn["turn_id"] as? String {
                    return turnID
                }
            }
        }
        return nil
    }

    private static func extractThreadID(from payload: [String: Any]) -> String? {
        if let threadID = payload["threadId"] as? String {
            return threadID
        }
        if let threadID = payload["thread_id"] as? String {
            return threadID
        }
        if let msg = payload["msg"] as? [String: Any] {
            if let threadID = msg["threadId"] as? String {
                return threadID
            }
            if let threadID = msg["thread_id"] as? String {
                return threadID
            }
        }
        return nil
    }

    private static func isTurnRunning(_ status: String) -> Bool {
        let normalized = normalizeTurnStatus(status)
        if normalized.isEmpty { return false }
        let runningStates: Set<String> = [
            "pending",
            "running",
            "inprogress",
            "active",
            "started",
            "executing",
        ]
        return runningStates.contains(normalized)
    }

    private static func isTurnTerminalStatus(_ status: String) -> Bool {
        let normalized = normalizeTurnStatus(status)
        if normalized.isEmpty { return false }
        return ["completed", "interrupted", "failed"].contains(normalized)
    }

    private static func normalizeTurnStatus(_ status: String) -> String {
        status
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: " ", with: "")
    }

    private static func toEpochMs(_ value: Double?) -> Double? {
        guard let value, value.isFinite, value > 0 else { return nil }
        if value > 1_000_000_000_000 { return value }
        if value > 1_000_000_000 { return value * 1000 }
        return nil
    }

    private static func normalizeWorkedMs(startedAtMs: Double?, completedAtMs: Double?) -> Double? {
        guard let startedAtMs, let completedAtMs else { return nil }
        let duration = completedAtMs - startedAtMs
        guard duration.isFinite, duration >= 1000 else { return nil }
        guard duration <= 12 * 60 * 60 * 1000 else { return nil }
        return duration
    }

    private static func turnWorkedMs(_ turn: PocketDexTurn) -> Double? {
        let startedAtMs = toEpochMs(turn.startedAt ?? turn.createdAt)
        let completedAtMs = toEpochMs(turn.completedAt ?? turn.updatedAt)
        return normalizeWorkedMs(startedAtMs: startedAtMs, completedAtMs: completedAtMs)
    }
}
