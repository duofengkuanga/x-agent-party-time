# XAPT-004 — 实现未连接状态的 daemon 生命周期

**What to build:** 交付可真实安装到当前用户 LaunchAgent 的 xapt daemon，使 `daemon start/status/stop` 在尚未连接 Server 时就具备正确的单实例、Codex 预检、本机控制、健康状态和失败恢复语义。

**Blocked by:** XAPT-001、XAPT-002。

**Status:** blocked

## 用户结果

- `xapt daemon start` 注册并启动当前用户 daemon；关闭终端后进程继续存在。
- 尚未连接 Server 时 daemon 可以健康运行，并提示下一步执行 `daemon connect`。
- `xapt daemon status` 区分停止、运行、未连接、依赖异常和无响应，而不只检查 PID。
- `xapt daemon stop` 在空闲时安全退出并注销 LaunchAgent；重复调用幂等。

## 实施范围

- 生成 `~/Library/LaunchAgents/com.agentpartytime.xapt.daemon.plist`，ProgramArguments 使用展开后的稳定绝对入口。
- 实现隐藏 `internal-daemon`、私有 Unix control socket、握手、请求超时和单实例保护。
- control socket 父目录为 0700，Socket 仅当前用户可访问；不监听 TCP。
- 安全识别并清理本程序遗留 Socket，不删除未知文件。
- 发现 PATH 或 `~/.local/bin/codex` 中的官方 Codex，检查最低版本、登录状态和 App Server initialize。
- 实现 `Service / Connection / Activity` 状态 Projection，以及未连接状态的中文 CLI Renderer。
- 实现日志输出、轮转上限、快速崩溃循环保护和明确的无响应错误。
- 普通 stop 只处理空闲 daemon；`--force` 的执行语义在 XAPT-008 补齐。

## 非范围

- 不打开浏览器、不连接 Server、不持久化 Credential。
- 不领取 Binding 或 Execution。
- 不实现 update、uninstall 或正式安装脚本。
- 不依赖进程名称、`ps` 输出或旧开发脚本正则作为单实例真相。

## 验收标准

- daemon 首次启动、重复启动、停止后再启动和重复停止均符合幂等语义。
- Codex 缺失、未登录、低于最低版本或 initialize 失败时拒绝启动，并给出官方安装、`codex login` 或更新建议。
- 大于等于最低版本的 Codex 不因缺少精确 allowlist 被拒绝。
- daemon 停止、运行、Socket 遗留、Socket 被未知文件占用和 daemon 无响应均有确定结果。
- status 不展示 Credential、本机路径、完整内部 ID、Prompt 或附件内容。
- LaunchAgent 和 daemon 测试不会修改开发者真实 LaunchAgent。

## 验证

- Fake launchd、Fake Codex 和临时 Home 下覆盖 start/status/stop 状态矩阵。
- macOS 集成测试验证 plist、权限、稳定入口、Socket 和真实 launchctl 基本生命周期；必须使用隔离 Label 和清理钩子。
- 运行 xapt CLI、daemon、状态和类型检查。
- GitNexus `detect_changes` 只命中 xapt daemon 与平台基础。
