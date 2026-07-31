# XAPT-006 — 迁移 Heartbeat、Binding 与本机仓库映射

**What to build:** 将当前 Runner 的 HTTP Client、Heartbeat 和 Binding Worker 迁入 xapt daemon，使已连接 Agent 能被 Web 发现并处理 Binding 请求，同时保证 `bindingId → repositoryPath` 映射只存在于本机。

**Blocked by:** XAPT-003、XAPT-005。

**Status:** blocked

## 用户结果

- 已连接 daemon 会稳定上报 Agent 在线状态和可用能力。
- 用户在 Web 发起 Binding 后，xapt 在本机选择并验证仓库，随后由 Web 显示 Binding 已完成。
- status 显示 Binding 数量和 Binding 活动，但不显示绝对路径。
- Server 无法通过任何响应或持久化数据获得开发者本机仓库路径。

## 实施范围

- 迁移 Runner HTTP Client、认证 Header、超时、重试和 Heartbeat。
- 迁移 Binding Worker、目录选择、仓库 Origin 规范化和校验。
- 将 Binding 映射写入新 `bindings.json`，使用 XAPT-002 的原子状态与权限。
- daemon 根据实时活动上报状态，但此 Ticket 的 Execution 可用槽位保持受控占位，直到 XAPT-008 完成调度。
- 处理 Binding 成功、拒绝、过期、重复请求、目录取消、仓库无效和 Server 暂时不可用。
- 使用 XAPT-003 Harness 验证 HTTP Contract，不让 Web 测试导入 xapt 内部类。
- 保持 Runner 领域无关，不向 Binding 流程引入 Project、Bug 或 Cooking 状态机。

## 非范围

- 不执行 Codex Execution、Interaction 或 Outcome。
- 不把 repositoryPath、Home、Workspace 或 Git 凭据发送到 Server。
- 不迁移旧 `bindings.json`，不双写旧 Home。
- 不新增 Server 到开发机的入站连接。

## 验收标准

- Agent 在线、心跳降级、Credential 撤销和恢复均反映在 status 中。
- 一个合法 Binding 可在真实本机仓库上完成，并在 daemon 重启后恢复。
- 目录取消或仓库校验失败不会创建 Server 成功状态或本机半条目。
- Server 数据库、HTTP 日志和 Contract Payload 中不存在本机绝对路径。
- 同一 Binding 重复请求幂等；冲突映射不会被静默覆盖。
- Web 跨应用测试只依赖 Contract Harness。

## 验证

- Runner Client、Heartbeat、Binding Worker、目录选择和仓库 Origin 定向测试。
- 临时 Git 仓库集成测试覆盖成功、取消、Origin 不匹配和重启恢复。
- Server + Harness 测试断言所有请求体和持久化记录不含 repositoryPath。
- 运行 xapt、Runner Contract 和 Web 相关类型检查。
- GitNexus `detect_changes` 只命中连接、Binding、仓库校验与相关测试流程。
