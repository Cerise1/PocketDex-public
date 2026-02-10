import Foundation
import Darwin

enum ServerScheme: String, CaseIterable, Codable, Identifiable {
    case http
    case https

    var id: ServerScheme { self }
    var displayName: String { rawValue.uppercased() }
}

struct ServerConfiguration: Codable, Hashable {
    var scheme: ServerScheme
    var host: String
    var port: Int

    var normalizedHost: String {
        host.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var displayAddress: String {
        "\(scheme.rawValue)://\(normalizedHost):\(port)"
    }

    var baseURL: URL? {
        guard !normalizedHost.isEmpty else { return nil }
        return URL(string: "\(scheme.rawValue)://\(normalizedHost):\(port)")
    }

    func validated() throws -> ServerConfiguration {
        let trimmedHost = normalizedHost
        guard !trimmedHost.isEmpty else {
            throw ValidationError.emptyHost
        }
        guard !trimmedHost.contains("://") else {
            throw ValidationError.invalidHost
        }
        guard (1...65535).contains(port) else {
            throw ValidationError.invalidPort
        }
        return ServerConfiguration(scheme: scheme, host: trimmedHost, port: port)
    }

    static func inferredScheme(for host: String) -> ServerScheme {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return .http }
        if trimmed == "localhost" {
            return .http
        }
        if isIPv4Address(trimmed) || isIPv6Address(trimmed) {
            return .http
        }
        return .https
    }

    private static func normalizeIPAddressCandidate(_ host: String) -> String {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("[") && trimmed.hasSuffix("]") && trimmed.count >= 2 {
            return String(trimmed.dropFirst().dropLast())
        }
        return trimmed
    }

    private static func isIPv4Address(_ host: String) -> Bool {
        let candidate = normalizeIPAddressCandidate(host)
        var ipv4 = in_addr()
        return candidate.withCString { inet_pton(AF_INET, $0, &ipv4) == 1 }
    }

    private static func isIPv6Address(_ host: String) -> Bool {
        let candidate = normalizeIPAddressCandidate(host)
        var ipv6 = in6_addr()
        return candidate.withCString { inet_pton(AF_INET6, $0, &ipv6) == 1 }
    }

    enum ValidationError: LocalizedError {
        case emptyHost
        case invalidHost
        case invalidPort

        var errorDescription: String? {
            switch self {
            case .emptyHost:
                return "Renseigne une adresse IP ou un hostname."
            case .invalidHost:
                return "Le host doit etre une IP/nom sans http://."
            case .invalidPort:
                return "Le port doit etre compris entre 1 et 65535."
            }
        }
    }
}
