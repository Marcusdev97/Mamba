import Foundation

@MainActor
final class TeamViewModel: ObservableObject {
    enum ViewState {
        case idle
        case loading
        case loaded(TeamViewResponse)
        case failed(String)
    }

    @Published private(set) var state: ViewState = .idle
    @Published private(set) var lastUpdated: Date?

    func refresh(settings: AppSettings) async {
        guard settings.isConfigured else {
            state = .failed("请先填写 Mac 地址和 Phone View 存取码。")
            return
        }
        if case .loaded = state {
            // Keep the current cards visible while refreshing.
        } else {
            state = .loading
        }

        do {
            let base = settings.serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard let url = URL(string: "\(base)/api/team-view") else {
                throw ViewError.message("Mac 地址格式不正确。")
            }
            var request = URLRequest(url: url)
            request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            request.timeoutInterval = 8
            request.setValue(
                "Bearer \(settings.accessToken.trimmingCharacters(in: .whitespacesAndNewlines))",
                forHTTPHeaderField: "Authorization"
            )
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw ViewError.message("Mac 没有返回有效状态。")
            }
            if http.statusCode == 401 {
                throw ViewError.message("Phone View 存取码不正确。")
            }
            guard (200..<300).contains(http.statusCode) else {
                let serverError = (try? JSONDecoder().decode(ServerError.self, from: data).error)
                throw ViewError.message(serverError ?? "Mac 返回 HTTP \(http.statusCode)。")
            }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let payload = try decoder.decode(TeamViewResponse.self, from: data)
            guard payload.ok, payload.readOnly else {
                throw ViewError.message("这个入口不是 Mamba 只读 View。")
            }
            state = .loaded(payload)
            lastUpdated = Date()
        } catch let error as ViewError {
            state = .failed(error.localizedDescription)
        } catch let error as URLError {
            let message: String
            switch error.code {
            case .timedOut:
                message = "连接超时。请确认 iPhone 和 Mac 在同一个 Wi‑Fi。"
            case .cannotConnectToHost, .networkConnectionLost, .notConnectedToInternet:
                message = "连接不到 Mac。请确认 Phone View 已启动，并检查 Mac 地址。"
            default:
                message = error.localizedDescription
            }
            state = .failed(message)
        } catch {
            state = .failed("读取失败：\(error.localizedDescription)")
        }
    }
}

private struct ServerError: Decodable {
    let error: String?
}

private enum ViewError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let value): value
        }
    }
}
