import Foundation

final class PocketDexAPIClient {
    struct ThreadStartSecurityOptions {
        let approvalPolicy: String?
        let sandbox: String?
    }

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(session: URLSession = .shared) {
        self.session = session
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    func checkHealth(config: ServerConfiguration) async throws -> PocketDexHealthResponse {
        try await requestJSON(
            config: config,
            method: "GET",
            path: "/api/health",
            responseType: PocketDexHealthResponse.self
        )
    }

    func listThreads(config: ServerConfiguration) async throws -> [PocketDexThreadSummary] {
        let payload = try await requestJSON(
            config: config,
            method: "GET",
            path: "/api/threads",
            queryItems: [
            URLQueryItem(name: "sortKey", value: "updated_at"),
                URLQueryItem(name: "limit", value: "100"),
            ],
            responseType: PocketDexThreadsResponse.self
        )
        return payload.data.sorted { lhs, rhs in
            (lhs.updatedAt ?? 0) > (rhs.updatedAt ?? 0)
        }
    }

    func listWorkspaceRoots(config: ServerConfiguration) async throws -> [String] {
        let payload = try await requestJSON(
            config: config,
            method: "GET",
            path: "/api/workspaces",
            responseType: PocketDexWorkspacesResponse.self
        )
        let normalized = payload.roots
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return Array(Set(normalized)).sorted()
    }

    func fetchProjectOrder(config: ServerConfiguration) async throws -> [String] {
        struct UiStateData: Decodable {
            let projectOrder: [String]?
        }

        struct UiStateResponse: Decodable {
            let data: UiStateData?
        }

        let payload = try await requestJSON(
            config: config,
            method: "GET",
            path: "/api/ui-state",
            responseType: UiStateResponse.self
        )
        let order = payload.data?.projectOrder ?? []
        var seen = Set<String>()
        var result: [String] = []
        for entry in order {
            let trimmed = entry.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || seen.contains(trimmed) {
                continue
            }
            seen.insert(trimmed)
            result.append(trimmed)
        }
        return result
    }

    func updateProjectOrder(order: [String], config: ServerConfiguration) async throws -> [String] {
        struct UiStateData: Encodable {
            let projectOrder: [String]
        }

        struct Body: Encodable {
            let data: UiStateData
        }

        struct UiStateResponseData: Decodable {
            let projectOrder: [String]?
        }

        struct UiStateResponse: Decodable {
            let data: UiStateResponseData?
        }

        let payload = try await requestJSON(
            config: config,
            method: "PATCH",
            path: "/api/ui-state",
            body: Body(data: UiStateData(projectOrder: order)),
            responseType: UiStateResponse.self
        )
        let resolved = payload.data?.projectOrder ?? order
        var seen = Set<String>()
        var result: [String] = []
        for entry in resolved {
            let trimmed = entry.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || seen.contains(trimmed) {
                continue
            }
            seen.insert(trimmed)
            result.append(trimmed)
        }
        return result
    }

    func fetchCodexPreferences(config: ServerConfiguration) async throws -> PocketDexCodexPreferences {
        struct UiStateData: Decodable {
            let codexPreferences: PocketDexCodexPreferences?
        }

        struct UiStateResponse: Decodable {
            let data: UiStateData?
        }

        let payload = try await requestJSON(
            config: config,
            method: "GET",
            path: "/api/ui-state",
            responseType: UiStateResponse.self
        )
        return payload.data?.codexPreferences ?? .default
    }

    func updateCodexPreferences(
        _ preferences: PocketDexCodexPreferences,
        config: ServerConfiguration
    ) async throws -> PocketDexCodexPreferences {
        struct UiStateData: Encodable {
            let codexPreferences: PocketDexCodexPreferences
        }

        struct Body: Encodable {
            let data: UiStateData
        }

        struct UiStateResponseData: Decodable {
            let codexPreferences: PocketDexCodexPreferences?
        }

        struct UiStateResponse: Decodable {
            let data: UiStateResponseData?
        }

        let payload = try await requestJSON(
            config: config,
            method: "PATCH",
            path: "/api/ui-state",
            body: Body(data: UiStateData(codexPreferences: preferences)),
            responseType: UiStateResponse.self
        )
        return payload.data?.codexPreferences ?? preferences
    }

    func readThread(threadID: String, config: ServerConfiguration) async throws -> PocketDexThreadDetail {
        let encodedID = threadID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? threadID
        let payload = try await requestJSON(
            config: config,
            method: "GET",
            path: "/api/threads/\(encodedID)",
            responseType: PocketDexThreadResponse.self
        )
        guard let thread = payload.thread else {
            throw PocketDexAPIError.invalidPayload("Thread not found.")
        }
        return thread
    }

    func readConfig(cwd: String?, config: ServerConfiguration) async throws -> PocketDexRuntimeConfig? {
        let trimmedCwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let queryItems = trimmedCwd.isEmpty ? [] : [URLQueryItem(name: "cwd", value: trimmedCwd)]
        let payload = try await requestJSON(
            config: config,
            method: "GET",
            path: "/api/config",
            queryItems: queryItems,
            responseType: PocketDexConfigResponse.self
        )
        return payload.config
    }

    func createThread(
        cwd: String,
        model: String? = nil,
        securityOptions: ThreadStartSecurityOptions? = nil,
        config: ServerConfiguration
    ) async throws -> PocketDexThreadSummary {
        struct Body: Encodable {
            let cwd: String
            let model: String?
            let approvalPolicy: String?
            let sandbox: String?

            private enum CodingKeys: String, CodingKey {
                case cwd
                case model
                case approvalPolicy
                case sandbox
            }
        }

        let payload = try await requestJSON(
            config: config,
            method: "POST",
            path: "/api/threads",
            body: Body(
                cwd: cwd,
                model: model,
                approvalPolicy: securityOptions?.approvalPolicy,
                sandbox: securityOptions?.sandbox
            ),
            responseType: PocketDexCreateThreadResponse.self
        )
        guard let thread = payload.thread else {
            throw PocketDexAPIError.invalidPayload("Failed to create a new thread.")
        }
        return thread
    }

    func createProject(name: String, config: ServerConfiguration) async throws -> PocketDexProject {
        struct Body: Encodable {
            let name: String
        }

        let payload = try await requestJSON(
            config: config,
            method: "POST",
            path: "/api/projects",
            body: Body(name: name),
            responseType: PocketDexCreateProjectResponse.self
        )
        guard let project = payload.project else {
            throw PocketDexAPIError.invalidPayload("Failed to create project.")
        }
        return project
    }

    func sendMessage(
        threadID: String,
        text: String,
        preparedAttachments: [PocketDexPreparedAttachment],
        clientActionID: String? = nil,
        config: ServerConfiguration
    ) async throws -> PocketDexAckResponse {
        struct Body: Encodable {
            let text: String
            let model: String?
            let effort: String?
            let attachments: [String]
            let preparedAttachments: [PocketDexPreparedAttachment]
            let clientActionID: String?

            private enum CodingKeys: String, CodingKey {
                case text
                case model
                case effort
                case attachments
                case preparedAttachments
                case clientActionID = "clientActionId"
            }
        }

        let encodedID = threadID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? threadID
        return try await requestJSON(
            config: config,
            method: "POST",
            path: "/api/threads/\(encodedID)/messages",
            body: Body(
                text: text,
                model: nil,
                effort: nil,
                attachments: [],
                preparedAttachments: preparedAttachments,
                clientActionID: clientActionID
            ),
            responseType: PocketDexAckResponse.self
        )
    }

    func uploadAttachment(
        threadID: String,
        attachment: PendingImageAttachment,
        config: ServerConfiguration
    ) async throws -> PocketDexPreparedAttachment {
        let encodedID = threadID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? threadID
        let queryItems = [
            URLQueryItem(name: "threadId", value: encodedID),
            URLQueryItem(name: "name", value: attachment.filename),
            URLQueryItem(name: "kind", value: attachment.isImage ? "image" : "file"),
        ]
        let payload = try await requestJSONData(
            config: config,
            method: "POST",
            path: "/api/attachments/upload",
            queryItems: queryItems,
            bodyData: attachment.data,
            headers: ["Content-Type": attachment.mimeType],
            responseType: PocketDexUploadResponse.self
        )
        guard let prepared = payload.attachment else {
            throw PocketDexAPIError.invalidPayload("Upload incomplet.")
        }
        return prepared
    }

    func interruptThread(
        threadID: String,
        turnID: String?,
        clientActionID: String? = nil,
        config: ServerConfiguration
    ) async throws -> PocketDexAckResponse {
        struct Body: Encodable {
            let turnId: String?
            let clientActionId: String?
        }

        let encodedID = threadID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? threadID
        return try await requestJSON(
            config: config,
            method: "POST",
            path: "/api/threads/\(encodedID)/interrupt",
            body: Body(turnId: turnID, clientActionId: clientActionID),
            responseType: PocketDexAckResponse.self
        )
    }

    func archiveThread(
        threadID: String,
        config: ServerConfiguration
    ) async throws -> PocketDexAckResponse {
        let encodedID = threadID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? threadID
        return try await requestJSON(
            config: config,
            method: "POST",
            path: "/api/threads/\(encodedID)/archive",
            responseType: PocketDexAckResponse.self
        )
    }

    func logStopFlowDebug(
        threadID: String,
        turnID: String?,
        event: String,
        detail: [String: Any],
        config: ServerConfiguration
    ) async {
        guard let baseURL = config.baseURL else { return }
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return }
        components.path = "/api/debug/stop-flow"
        guard let url = components.url else { return }

        let trimmedEvent = event.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedEvent.isEmpty else { return }

        var payload: [String: Any] = [
            "source": "mobile",
            "event": trimmedEvent,
            "threadId": threadID,
            "detail": detail,
        ]
        if let turnID {
            let normalized = turnID.trimmingCharacters(in: .whitespacesAndNewlines)
            if !normalized.isEmpty {
                payload["turnId"] = normalized
            }
        }
        guard JSONSerialization.isValidJSONObject(payload) else { return }
        guard let bodyData = try? JSONSerialization.data(withJSONObject: payload) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.httpBody = bodyData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        do {
            let (_, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else { return }
            guard (200..<300).contains(httpResponse.statusCode) else { return }
        } catch {
            // Best-effort debug logging only.
        }
    }

    func localImageURL(path: String, config: ServerConfiguration) -> URL? {
        guard let baseURL = config.baseURL else { return nil }
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/api/local-images"
        components.queryItems = [URLQueryItem(name: "path", value: path)]
        return components.url
    }

    private func buildURL(
        config: ServerConfiguration,
        path: String,
        queryItems: [URLQueryItem] = []
    ) throws -> URL {
        guard let baseURL = config.baseURL else {
            throw PocketDexAPIError.invalidBaseURL
        }
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw PocketDexAPIError.invalidBaseURL
        }
        components.path = path
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else {
            throw PocketDexAPIError.invalidBaseURL
        }
        return url
    }

    private func requestJSON<Response: Decodable>(
        config: ServerConfiguration,
        method: String,
        path: String,
        queryItems: [URLQueryItem] = [],
        responseType: Response.Type
    ) async throws -> Response {
        try await requestJSONData(
            config: config,
            method: method,
            path: path,
            queryItems: queryItems,
            bodyData: nil,
            headers: [:],
            responseType: responseType
        )
    }

    private func requestJSON<Response: Decodable, Body: Encodable>(
        config: ServerConfiguration,
        method: String,
        path: String,
        queryItems: [URLQueryItem] = [],
        body: Body,
        responseType: Response.Type
    ) async throws -> Response {
        let bodyData = try encoder.encode(body)
        return try await requestJSONData(
            config: config,
            method: method,
            path: path,
            queryItems: queryItems,
            bodyData: bodyData,
            headers: ["Content-Type": "application/json"],
            responseType: responseType
        )
    }

    private func requestJSONData<Response: Decodable>(
        config: ServerConfiguration,
        method: String,
        path: String,
        queryItems: [URLQueryItem] = [],
        bodyData: Data? = nil,
        headers: [String: String] = [:],
        responseType: Response.Type
    ) async throws -> Response {
        let url = try buildURL(config: config, path: path, queryItems: queryItems)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.httpBody = bodyData
        for (header, value) in headers {
            request.setValue(value, forHTTPHeaderField: header)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw mapTransportError(error, url: url)
        }
        guard let httpResponse = response as? HTTPURLResponse else {
            throw PocketDexAPIError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = parseErrorMessage(from: data)
            throw PocketDexAPIError.httpStatus(httpResponse.statusCode, message)
        }
        do {
            return try decoder.decode(responseType, from: data)
        } catch {
            throw PocketDexAPIError.decoding(error)
        }
    }

    private func mapTransportError(_ error: Error, url: URL) -> PocketDexAPIError {
        guard let urlError = error as? URLError else {
            return .transport(error.localizedDescription)
        }

        switch urlError.code {
        case .appTransportSecurityRequiresSecureConnection:
            return .transport(
                "HTTP is blocked by iOS App Transport Security (ATS) for \(url.host ?? "this server"). " +
                "Install the latest app build and try again."
            )
        case .cannotConnectToHost, .networkConnectionLost, .timedOut, .notConnectedToInternet:
            return .transport("Unable to reach \(url.host ?? "server"):\(url.port ?? 0).")
        default:
            return .transport(urlError.localizedDescription)
        }
    }

    private func parseErrorMessage(from data: Data) -> String {
        if let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let error = payload["error"] as? String, !error.isEmpty {
                return error
            }
            if let message = payload["message"] as? String, !message.isEmpty {
                return message
            }
        }
        if let raw = String(data: data, encoding: .utf8), !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return raw
        }
        return "Unknown server error."
    }
}

enum PocketDexAPIError: LocalizedError {
    case invalidBaseURL
    case invalidResponse
    case invalidPayload(String)
    case httpStatus(Int, String)
    case decoding(Error)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            return "Invalid server configuration."
        case .invalidResponse:
            return "Invalid server response."
        case let .invalidPayload(message):
            return message
        case let .httpStatus(code, message):
            return "HTTP error \(code): \(message)"
        case let .decoding(error):
            return "Unable to decode server response: \(error.localizedDescription)"
        case let .transport(message):
            return message
        }
    }
}
