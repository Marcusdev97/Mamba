import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var settings: AppSettings
    @StateObject private var model = TeamViewModel()
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            Group {
                switch model.state {
                case .idle:
                    WelcomeView {
                        showingSettings = true
                    }
                case .loading:
                    ProgressView("正在读取两台电脑…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .loaded(let payload):
                    DashboardView(payload: payload, lastUpdated: model.lastUpdated)
                        .refreshable { await model.refresh(settings: settings) }
                case .failed(let message):
                    ErrorView(message: message) {
                        Task { await model.refresh(settings: settings) }
                    } openSettings: {
                        showingSettings = true
                    }
                }
            }
            .navigationTitle("Mamba View")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("连接设置")
                }
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView()
                    .environmentObject(settings)
            }
            .task {
                if settings.isConfigured {
                    await model.refresh(settings: settings)
                }
            }
            .onChange(of: showingSettings) { _, visible in
                if !visible, settings.isConfigured {
                    Task { await model.refresh(settings: settings) }
                }
            }
        }
    }
}

private struct DashboardView: View {
    let payload: TeamViewResponse
    let lastUpdated: Date?

    private var connected: [MambaDevice] {
        payload.devices.filter { $0.connected && $0.data != nil }
    }

    private var onlineSenders: Int {
        connected.flatMap { $0.data?.scope.senders ?? [] }.filter(\.isOpen).count
    }

    private var activeCampaigns: Int {
        connected.filter { $0.data?.campaign?.running == true }.count
    }

    private var attention: Int {
        connected.reduce(0) { total, device in
            total + (device.data?.health.filter(\.needsAttention).count ?? 0)
        } + payload.devices.filter { !$0.connected }.count
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 14) {
                ReadOnlyBanner(lastUpdated: lastUpdated)
                LazyVGrid(columns: [
                    GridItem(.flexible()),
                    GridItem(.flexible()),
                ], spacing: 10) {
                    OverviewTile(title: "电脑在线", value: "\(connected.count)/\(payload.devices.count)", note: "This Mac + Remote")
                    OverviewTile(title: "WhatsApp 在线", value: "\(onlineSenders)", note: "已连接号码")
                    OverviewTile(title: "正在发送", value: "\(activeCampaigns)", note: "两台合计")
                    OverviewTile(title: "需要注意", value: "\(attention)", note: "Offline + Warning", warning: attention > 0)
                }
                ForEach(payload.devices) { device in
                    DeviceCard(device: device)
                }
                Text("这里只负责查看，不会发送、停止 Campaign 或分配客户。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.vertical, 8)
            }
            .padding()
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }
}

private struct ReadOnlyBanner: View {
    let lastUpdated: Date?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "eye")
                .foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 2) {
                Text("只读总览")
                    .font(.subheadline.weight(.semibold))
                Text(lastUpdated.map { "更新 \($0.formatted(date: .omitted, time: .standard))" } ?? "不会触发任何发送")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(12)
        .background(.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct OverviewTile: View {
    let title: String
    let value: String
    let note: String
    var warning = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title2.weight(.bold))
                .foregroundStyle(warning ? .orange : .primary)
            Text(note)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct DeviceCard: View {
    let device: MambaDevice

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(device.roleLabel)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.blue)
                    Text(device.displayName)
                        .font(.headline)
                    if let hostname = device.data?.scope.device.hostname.nonEmpty {
                        Text(hostname)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                StatusPill(online: device.connected)
            }
            .padding(14)

            Divider()

            if let data = device.data, device.connected {
                VStack(spacing: 12) {
                    SenderStrip(senders: data.scope.senders)
                    MetricGrid(metrics: data.metrics)
                    CampaignCard(campaign: data.campaign)
                    HealthList(health: data.health)
                }
                .padding(14)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: device.kind == "local" ? "exclamationmark.triangle" : "laptopcomputer.slash")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text(device.kind == "local" ? "本机状态暂时读不到" : "另一台电脑尚未连接")
                        .font(.subheadline.weight(.semibold))
                    Text(device.error.nonEmpty ?? "请先连接 Remote Mamba。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(28)
            }
        }
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(device.connected ? Color.green.opacity(0.28) : Color.red.opacity(0.2), lineWidth: 1)
        }
    }
}

private struct StatusPill: View {
    let online: Bool

    var body: some View {
        Label(online ? "在线" : "未连接", systemImage: "circle.fill")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(online ? .green : .red)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background((online ? Color.green : Color.red).opacity(0.08), in: Capsule())
    }
}

private struct SenderStrip: View {
    let senders: [SenderSummary]

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("WHATSAPP")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.secondary)
            if senders.isEmpty {
                Text("没有本机号码")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 7) {
                        ForEach(senders) { sender in
                            Label(
                                "\(sender.name)\(sender.number.isEmpty ? "" : " · \(sender.number)")",
                                systemImage: "circle.fill"
                            )
                            .font(.caption2)
                            .foregroundStyle(sender.isOpen ? .green : .secondary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                            .background(Color(uiColor: .tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 7))
                        }
                    }
                }
            }
        }
    }
}

private struct MetricGrid: View {
    let metrics: DeviceMetrics

    var body: some View {
        LazyVGrid(columns: [
            GridItem(.flexible()),
            GridItem(.flexible()),
            GridItem(.flexible()),
            GridItem(.flexible()),
        ], spacing: 7) {
            MetricCell(title: "发送", value: metrics.todaySent)
            MetricCell(title: "回复", value: metrics.todayReplies)
            MetricCell(title: "Follow-up", value: metrics.followUps)
            MetricCell(title: "预约", value: metrics.appointments)
        }
    }
}

private struct MetricCell: View {
    let title: String
    let value: Int

    var body: some View {
        VStack(spacing: 3) {
            Text(title)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text("\(value)")
                .font(.subheadline.weight(.bold))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 9)
        .background(Color(uiColor: .tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct CampaignCard: View {
    let campaign: CampaignSummary?

    var body: some View {
        if let campaign {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("CURRENT CAMPAIGN")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.secondary)
                        Text(campaign.project)
                            .font(.subheadline.weight(.semibold))
                        Text("\(campaign.instances.joined(separator: " / ")) · \(campaign.mode)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(campaign.status)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(campaign.running ? .green : .secondary)
                }
                ProgressView(value: campaign.progress)
                    .tint(.green)
                HStack {
                    Text("\(Int(campaign.progress * 100))% 已处理")
                    Spacer()
                    Text("\(campaign.sent) 已发送 · \(campaign.pending) 等待 · \(campaign.failed) 异常")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            .padding(11)
            .background(Color(uiColor: .tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
        } else {
            Text("这台电脑目前没有 Campaign。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(14)
                .background(Color(uiColor: .tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
        }
    }
}

private struct HealthList: View {
    let health: [HealthSummary]

    private var problems: [HealthSummary] {
        health.filter(\.needsAttention)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("NEEDS ATTENTION")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.secondary)
            if problems.isEmpty {
                Label("目前没有服务异常", systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            } else {
                ForEach(problems.prefix(4)) { item in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: item.state == "offline" ? "xmark.circle.fill" : "exclamationmark.triangle.fill")
                            .foregroundStyle(item.state == "offline" ? .red : .orange)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.label)
                                .font(.caption.weight(.semibold))
                            Text(item.detail)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        Spacer()
                    }
                }
            }
        }
    }
}

private struct WelcomeView: View {
    let configure: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("连接 Mamba Mac", systemImage: "iphone.and.arrow.forward")
        } description: {
            Text("填写 Mac 地址和 Phone View 存取码后，就能只读查看两台电脑。")
        } actions: {
            Button("打开连接设置", action: configure)
                .buttonStyle(.borderedProminent)
        }
    }
}

private struct ErrorView: View {
    let message: String
    let retry: () -> Void
    let openSettings: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("读取失败", systemImage: "wifi.exclamationmark")
        } description: {
            Text(message)
        } actions: {
            HStack {
                Button("重试", action: retry)
                    .buttonStyle(.borderedProminent)
                Button("连接设置", action: openSettings)
                    .buttonStyle(.bordered)
            }
        }
    }
}

private struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var settings: AppSettings
    @State private var serverURL = ""
    @State private var accessToken = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Mac Phone View") {
                    TextField("http://192.168.x.x:8791", text: $serverURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    SecureField("Access Token", text: $accessToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section {
                    Label("这个 App 只有只读权限", systemImage: "lock.shield")
                    Text("iPhone 与 Mac 必须连接同一个 Wi‑Fi；Mac 上的 Phone View 也必须正在运行。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("连接设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        settings.serverURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
                        settings.accessToken = accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
                        dismiss()
                    }
                    .disabled(URL(string: serverURL) == nil || accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear {
                serverURL = settings.serverURL
                accessToken = settings.accessToken
            }
        }
    }
}
