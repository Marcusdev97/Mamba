# Mamba View for iPhone

只读查看两台 Mamba 的设备、WhatsApp、Campaign 与服务健康状态。

## 安装

1. Mac 先启动 `Mamba Phone View`。
2. 用 cable 连接 iPhone，在 iPhone 点「信任」并开启 Developer Mode。
3. 用 Xcode 打开 `MambaView.xcodeproj`。
4. Signing & Capabilities 选择自己的 Apple Team。
5. 顶部选择已连接的 iPhone，按 Run。
6. App 第一次打开时允许「本地网络」。
7. 填写 Mac 的稳定本地地址 `http://OK.local:8791`，以及 `campaign-data/phone-view.json` 里的 accessToken。建议使用 `.local` 名称，不要写可能随网络变化的 IP。

Phone View 只提供过滤后的只读 JSON，不开放 Mamba 发送 API，也不会传送客户对话与工作队列。
