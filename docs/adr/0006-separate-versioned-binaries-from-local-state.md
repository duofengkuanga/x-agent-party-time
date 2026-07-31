---
status: accepted
---

# xapt 分离版本化程序与本机状态

`~/.local/bin/xapt` 是稳定命令入口，真实二进制按版本保存在 `~/.local/share/xapt/versions/`，只保留当前成功版本和上一个成功版本以支持更新回退。长期连接、Binding、Outbox 和恢复状态进入用户级 Application Support，可重建内容进入 Caches，日志进入 Logs，LaunchAgent 配置进入 `~/Library/LaunchAgents/`，Server Credential 进入 macOS Keychain；程序、状态、Cache、日志和秘密不混在统一的 `~/.xapt/` 目录中。
