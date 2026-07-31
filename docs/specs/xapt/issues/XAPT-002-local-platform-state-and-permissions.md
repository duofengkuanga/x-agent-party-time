# XAPT-002 — 建立本机平台、状态、权限与秘密存储基础

**What to build:** 为 xapt 建立可测试的 macOS 平台边界和按生命周期分层的本机数据布局，使后续 daemon、连接、更新和卸载都通过统一 Adapter 操作路径、原子状态、权限与 Keychain，而不是继续依赖 `~/.agent-party-time/runner/`。

**Blocked by:** XAPT-001。

**Status:** blocked

## 用户结果

- xapt 能在当前用户目录下安全创建 Application Support、Caches、Logs 和版本目录。
- Credential 不进入 JSON、日志、命令行参数或环境变量；秘密存储只通过 Keychain Interface。
- 损坏状态、错误权限或不支持的 Schema 会失败关闭，并说明受影响的状态和下一步。
- 旧 `~/.agent-party-time/runner/` 不被读取、迁移或双写。

## 实施范围

- 实现 Spec 中稳定入口、版本目录、Application Support、Caches、Logs、LaunchAgent 和 control socket 的路径模型。
- 建立文件系统、时钟、进程、浏览器、LaunchAgent、Keychain 和用户环境等平台 Interface；单测使用 Fake Adapter。
- 实现原子 JSON 写入、目录创建、权限校验与收紧、临时文件清理和明确错误类型。
- 建立 `connection.json`、`bindings.json`、Execution/Outbox 状态和 `install.json` 的 Schema 版本边界。
- 实现状态只读预检，为后续更新回退提供“能否由目标版本读取”的判断。
- 实现 macOS Keychain Adapter 的写入、读取和删除能力，但不在本 Ticket 发起 Server 授权。
- 测试必须支持隔离 Home，不访问开发者真实 Keychain、LaunchAgent 或用户状态。

## 非范围

- 不实现公共 daemon 命令、Server 连接、Runner Worker 或 GitHub Release。
- 不设计旧 Runner 数据迁移、fallback、双写或 deprecated 字段。
- 不在 Cache 中保存 Binding、Credential、Outbox 或恢复所需状态。
- 不把本机绝对路径发送给 Server。

## 验收标准

- 全新 Home 初始化后，目录与文件权限符合 Spec：状态根 0700、状态文件 0600、真实二进制 0755、LaunchAgent plist 0644。
- 状态写入在模拟中断时保留旧的完整版本，不产生半写 JSON。
- Keychain Fake 和 macOS Adapter 使用稳定 Service 与由 Server Origin、Runner ID 构成的 Account。
- Credential 不出现在测试快照、错误消息、日志或持久化 JSON 中。
- 删除全部 Cache 后，长期连接、Binding、Outbox 和恢复状态仍可读取。
- 任意测试 Home 中存在旧 Runner 目录时，xapt 既不读取也不修改它。

## 验证

- 路径、权限、原子写入、Schema、损坏文件、只读目录和 Keychain Adapter 单测。
- 在临时 Home 上执行初始化和重启读取测试。
- macOS 条件测试验证真实文件 mode，但不访问真实用户数据。
- 运行 xapt 类型检查和定向测试。
- GitNexus `detect_changes` 只命中 xapt 平台和状态基础。
