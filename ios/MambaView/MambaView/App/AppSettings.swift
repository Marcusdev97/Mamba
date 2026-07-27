import Foundation
import Security

@MainActor
final class AppSettings: ObservableObject {
    private enum Keys {
        static let serverURL = "mamba.phone.serverURL"
        static let accessToken = "com.mamba.view.access-token"
    }

    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: Keys.serverURL) }
    }

    @Published var accessToken: String {
        didSet { KeychainStore.save(accessToken, account: Keys.accessToken) }
    }

    init() {
        let environment = ProcessInfo.processInfo.environment
        let provisionedServerURL = environment["MAMBA_VIEW_SERVER_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let provisionedAccessToken = environment["MAMBA_VIEW_ACCESS_TOKEN"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        serverURL = provisionedServerURL.nonEmpty
            ?? UserDefaults.standard.string(forKey: Keys.serverURL)
            ?? "http://OK.local:8791"
        accessToken = provisionedAccessToken.nonEmpty
            ?? KeychainStore.read(account: Keys.accessToken)
            ?? ""

        if provisionedServerURL.nonEmpty != nil {
            UserDefaults.standard.set(serverURL, forKey: Keys.serverURL)
        }
        if provisionedAccessToken.nonEmpty != nil {
            KeychainStore.save(accessToken, account: Keys.accessToken)
        }
    }

    var isConfigured: Bool {
        URL(string: serverURL.trimmingCharacters(in: .whitespacesAndNewlines)) != nil
            && !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

private enum KeychainStore {
    private static let service = "com.marcus.mamba.view"

    static func save(_ value: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        guard !value.isEmpty, let data = value.data(using: .utf8) else { return }
        var insert = query
        insert[kSecValueData as String] = data
        SecItemAdd(insert as CFDictionary, nil)
    }

    static func read(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }
}
