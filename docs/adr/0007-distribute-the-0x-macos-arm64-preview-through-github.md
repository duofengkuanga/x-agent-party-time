---
status: accepted
---

# xapt 0.x 只通过 GitHub 分发 macOS arm64 预览版

xapt 0.x 只为 Apple Silicon Mac 构建包含 Bun Runtime 的资产，并通过免费 GitHub Release 与 curl 安装，不要求 Apple Developer Program、Developer ID 或 Apple 公证。每个压缩包必须发布 SHA-256 文件，安装器和 updater 使用 macOS 自带的 `/usr/bin/shasum` 强制本机校验，缺失或不一致时失败关闭；预览版不移除 quarantine、不关闭 Gatekeeper，也不冒充已获 Apple 信任的正式发行版。
