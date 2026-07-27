import Foundation

struct TeamViewResponse: Decodable {
    let ok: Bool
    let readOnly: Bool
    let generatedAt: Date?
    let devices: [MambaDevice]
}

struct MambaDevice: Decodable, Identifiable {
    let kind: String
    let connected: Bool
    let remoteName: String?
    let error: String?
    let data: DeviceDashboard?

    var id: String { kind }
    var roleLabel: String { kind == "local" ? "THIS MAC" : "REMOTE MAC" }
    var displayName: String {
        data?.scope.device.name.nonEmpty
            ?? remoteName?.nonEmpty
            ?? (kind == "local" ? "This Mac" : "Remote Mac")
    }
}

struct DeviceDashboard: Decodable {
    let generatedAt: Date?
    let scope: DeviceScope
    let metrics: DeviceMetrics
    let campaign: CampaignSummary?
    let health: [HealthSummary]
    let logs: LogSummary
}

struct DeviceScope: Decodable {
    let device: DeviceIdentity
    let senders: [SenderSummary]
}

struct DeviceIdentity: Decodable {
    let id: String
    let name: String
    let hostname: String
}

struct SenderSummary: Decodable, Identifiable {
    let name: String
    let number: String
    let status: String

    var id: String { "\(name)-\(number)" }
    var isOpen: Bool { status.uppercased() == "OPEN" }
}

struct DeviceMetrics: Decodable {
    let todaySent: Int
    let todayReplies: Int
    let followUps: Int
    let appointments: Int
}

struct CampaignSummary: Decodable {
    let project: String
    let status: String
    let mode: String
    let total: Int
    let sent: Int
    let failed: Int
    let skipped: Int
    let pending: Int
    let processed: Int
    let running: Bool
    let stopped: Bool
    let updatedAt: Date?
    let instances: [String]

    var progress: Double {
        total > 0 ? min(1, Double(processed) / Double(total)) : 0
    }
}

struct HealthSummary: Decodable, Identifiable {
    let id: String
    let label: String
    let state: String
    let detail: String

    var needsAttention: Bool {
        ["warning", "offline"].contains(state.lowercased())
    }
}

struct LogSummary: Decodable {
    let errorsToday: Int
    let warningsToday: Int
}

extension Optional where Wrapped == String {
    var nonEmpty: String? {
        guard let value = self?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }
}

extension String {
    var nonEmpty: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
