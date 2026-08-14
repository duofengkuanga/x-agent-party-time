---
status: accepted
---

# xapt 分离版本化程序与本机状态

`~/.local/bin/xapt` 是稳定命令入口，真实二进制按版本保存在 `~/.local/share/xapt/versions/`，只保留当前成功版本和上一个成功版本以支持更新回退。长期连接、Binding、Outbox 和恢复状态进入用户级 Application Support，可重建内容进入 Caches，日志进入 Logs，LaunchAgent 配置进入 `~/Library/LaunchAgents/`，Server Credential 进入 macOS Keychain；程序、状态、Cache、日志和秘密不混在统一的 `~/.xapt/` 目录中。

各类持久化状态独立演进 Schema，只有数据结构实际变化时才提升对应版本；禁止用一个全局版本同时淘汰连接、Binding、Execution、Outbox 与安装状态。安装脚本不复制状态 Schema，而由目标 xapt 二进制生成安装状态。每个 Release 在发布资产前验证全新安装和 daemon 启动；桥接版本之后还必须从上一稳定版执行真实更新、健康检查和版本切换。
