# XAPT-012 — 实现安全卸载与 Agent 自撤销

**What to build:** 实现 `xapt uninstall [--force]` 和 Server 侧 Agent 自撤销接口，使用户能在安全条件满足时删除 xapt 的程序、秘密和本机状态，并在强制或离线场景中准确报告未收敛副作用，同时绝不影响 Codex。

**Blocked by:** XAPT-005、XAPT-008、XAPT-010。

**Status:** blocked

## 用户结果

- 空闲、已收敛的 xapt 可以一条命令完整卸载。
- 忙碌、Outbox 未空、Execution 未收敛或存在需保留 Workspace 时，普通卸载拒绝并说明原因。
- `--force` 只在真实 TTY 明确确认后执行，并报告可能遗留的 Lease、Workspace 和远程 Credential。
- Codex 可执行文件、登录状态和 `~/.codex` 完全不受影响。

## 实施范围

- 在 Server 新增使用当前 Runner Credential 的 Agent 自撤销接口，只撤销调用者自身 Credential。
- 普通卸载检查 connect、Binding、Execution、Interaction、Outbox、Workspace 和 daemon 响应状态。
- 正常流程停止领取、收敛状态、撤销 Server Credential、停止并注销 LaunchAgent。
- 删除 xapt Keychain Credential、connection、Binding、Outbox、Execution、Workspace、Cache、Logs、版本目录、安装元数据和稳定入口。
- `--force` 实现真实 TTY 确认、尽力撤销、超时终止和逐项清理结果报告。
- Server 离线时允许用户在明确警告后选择强制本机卸载，但不得声称远程 Credential 已撤销。
- 保留通用 `~/.local/bin` zsh PATH 托管区块，不修改 Codex 或其他工具配置。

## 非范围

- 不实现管理员删除其他 Agent、批量撤销或 Server Profile 管理。
- 不自动删除通用 PATH 配置。
- 不清理 `~/.codex`、Codex binary、Codex 登录或非 xapt Worktree。
- 不在普通卸载中静默丢弃未发送 Outcome 或未收敛 Execution。

## 验收标准

- 正常卸载后，xapt 自有 LaunchAgent、Socket、Keychain、状态、Cache、Logs、版本和入口均不存在。
- 普通卸载在每个不安全条件下都拒绝，且没有部分删除。
- 自撤销接口只能撤销当前 Agent，撤销后原 Credential 立即不能再心跳或领取任务。
- Server 在线撤销失败时普通卸载停止；强制卸载准确报告远程状态未知或未撤销。
- 非 TTY 环境不能执行 `--force`。
- 卸载前后 Codex binary、版本、登录状态和 `~/.codex` 内容一致。

## 验证

- Server 自撤销授权、越权、重复撤销和 Credential 失效测试。
- 卸载状态矩阵覆盖忙碌、Interaction、Outbox、Execution、Workspace、daemon 无响应和 Server 离线。
- 临时 Home + Fake Keychain 验证逐项清理与失败原子性。
- 真实 macOS 验收确认 LaunchAgent/Keychain 清理且 Codex 不变。
- GitNexus `detect_changes` 只命中自撤销、卸载、daemon 停止和本机资源管理流程。
