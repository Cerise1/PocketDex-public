import Foundation

enum PocketDexStreamEvent {
    case connected
    case disconnected
    case notification(method: String, params: [String: Any], seq: Int?, threadID: String?)
    case threadSnapshot(threadID: String, seqBase: Int, thread: [String: Any]?)
    case threadSync(threadID: String, latestSeq: Int)
    case request(id: Int, method: String, params: [String: Any])
    case error(String)
}

@MainActor
final class PocketDexStreamClient: NSObject {
    var onEvent: ((PocketDexStreamEvent) -> Void)?

    private var session: URLSession?
    private var socketTask: URLSessionWebSocketTask?
    private var isConnected = false
    private var pendingSubscription: (threadID: String, resume: Bool, resumeFrom: Int?)?

    func connect(config: ServerConfiguration) {
        disconnect()
        guard let baseURL = config.baseURL else { return }
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return }
        components.scheme = config.scheme == .https ? "wss" : "ws"
        components.path = "/api/stream"
        guard let wsURL = components.url else { return }

        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60

        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        self.session = session

        let task = session.webSocketTask(with: wsURL)
        socketTask = task
        task.resume()
        receiveNext()
    }

    func disconnect() {
        isConnected = false
        if let socketTask {
            socketTask.cancel(with: .normalClosure, reason: nil)
        }
        socketTask = nil
        session?.invalidateAndCancel()
        session = nil
    }

    func subscribe(threadID: String, resume: Bool = true, resumeFrom: Int? = nil) {
        pendingSubscription = (threadID, resume, resumeFrom)
        guard isConnected else { return }
        var payload: [String: Any] = [
            "type": "subscribe",
            "threadId": threadID,
            "resume": resume,
        ]
        if let resumeFrom, resumeFrom > 0 {
            payload["resumeFrom"] = resumeFrom
        }
        send(json: payload)
    }

    func unsubscribe(threadID: String) {
        send(json: [
            "type": "unsubscribe",
            "threadId": threadID,
        ])
    }

    func approveRequest(id: Int) {
        send(json: [
            "type": "response",
            "id": id,
            "result": [
                "decision": "accept",
            ],
        ])
    }

    func rejectRequest(id: Int, message: String) {
        send(json: [
            "type": "response_error",
            "id": id,
            "message": message,
        ])
    }

    private func receiveNext() {
        socketTask?.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self else { return }
                switch result {
                case let .success(message):
                    switch message {
                    case let .string(text):
                        self.handleIncoming(text: text)
                    case let .data(data):
                        let text = String(data: data, encoding: .utf8) ?? ""
                        self.handleIncoming(text: text)
                    @unknown default:
                        break
                    }
                    self.receiveNext()
                case let .failure(error):
                    self.onEvent?(.error(error.localizedDescription))
                    self.onEvent?(.disconnected)
                    self.isConnected = false
                }
            }
        }
    }

    private func handleIncoming(text: String) {
        guard let data = text.data(using: .utf8) else { return }
        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        guard let type = payload["type"] as? String else { return }

        switch type {
        case "notification":
            let method = payload["method"] as? String ?? ""
            let params = payload["params"] as? [String: Any] ?? [:]
            let seq = payload["seq"] as? Int
            let threadID = payload["threadId"] as? String
            onEvent?(.notification(method: method, params: params, seq: seq, threadID: threadID))
        case "thread_snapshot":
            let threadID = payload["threadId"] as? String ?? ""
            let seqBase = payload["seqBase"] as? Int ?? 0
            let thread = payload["thread"] as? [String: Any]
            onEvent?(.threadSnapshot(threadID: threadID, seqBase: seqBase, thread: thread))
        case "thread_sync":
            let threadID = payload["threadId"] as? String ?? ""
            let latestSeq = payload["latestSeq"] as? Int ?? 0
            onEvent?(.threadSync(threadID: threadID, latestSeq: latestSeq))
        case "request":
            let method = payload["method"] as? String ?? ""
            let id = payload["id"] as? Int ?? 0
            let params = payload["params"] as? [String: Any] ?? [:]
            onEvent?(.request(id: id, method: method, params: params))
        case "error":
            let message = payload["message"] as? String ?? "Erreur websocket"
            onEvent?(.error(message))
        default:
            break
        }
    }

    private func send(json: [String: Any]) {
        guard let socketTask else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return }
        guard let text = String(data: data, encoding: .utf8) else { return }
        socketTask.send(.string(text)) { [weak self] error in
            guard let error else { return }
            Task { @MainActor [weak self] in
                self?.onEvent?(.error(error.localizedDescription))
            }
        }
    }
}

extension PocketDexStreamClient: URLSessionWebSocketDelegate {
    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol `protocol`: String?
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.isConnected = true
            self.onEvent?(.connected)
            if let pendingSubscription = self.pendingSubscription {
                self.subscribe(
                    threadID: pendingSubscription.threadID,
                    resume: pendingSubscription.resume,
                    resumeFrom: pendingSubscription.resumeFrom
                )
            }
        }
    }

    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.isConnected = false
            self.onEvent?(.disconnected)
        }
    }
}
