# XAPT-007 — 迁移单条真实 Codex Execution Happy Path

**What to build:** 将 Workspace、附件、Codex App Server executor、Runner Worker 和 Outcome 提交迁入 xapt，使一条由 Web 创建的 Execution 能在绑定仓库中由外部 Codex 完整执行并返回结构化结果。

**Blocked by:** XAPT-002、XAPT-003、XAPT-006。

**Status:** blocked

## 用户结果

- Web 创建一条 Execution 后，已连接 xapt 能领取任务、准备 Workspace、运行 Codex 并提交成功或失败 Outcome。
- 已有 Codex Session 的后续 Execution 能继续原 Thread；新任务创建新 Thread。
- 附件、Prompt 和本机路径不会进入默认 CLI/status 输出或非必要日志。
- Codex 协议不兼容只让相关 Execution 明确失败，不让 daemon 整体退出。

## 实施范围

- 迁移 Attachment Materializer、Execution Workspace Manager、Execution Outbox 基础、Codex App Server executor 和 Runner Worker。
- 使用 Application Support 保存恢复所需状态，Caches 保存可重新下载内容，Logs 保存受限诊断。
- 实现 App Server initialize、thread/start、turn/start、结构化结果和 Session 继续的 happy path。
- Wire 解析忽略未知字段和未知通知；缺失必需方法或字段时生成明确兼容失败。
- Execution 开始、Lease 刷新、完成、失败和 Outcome 提交继续遵守共享 Contract。
- 本 Ticket 只保证一个受控执行槽；三槽并发和复杂恢复在 XAPT-008 完成。
- 保持 Codex 登录、更新和 `~/.codex` 的所有权不变。

## 非范围

- 不实现三个执行槽、同 Binding 串行、Interaction、interrupt 或完整崩溃恢复。
- 不把 Git、测试、构建、提交、Push 或 Cooking 状态机硬编码进 Runner。
- 不内嵌、自动安装或更新 Codex。
- 不删除旧 Runner 实现。

## 验收标准

- 一条真实 Execution 完成 `领取 → Workspace → 附件 → Codex → Outcome` 全链路。
- 成功结果通过 Execution Contract 的结构化 Schema；Codex 失败保留真实阶段和原因。
- daemon 重启后能识别尚未收敛的单条 Execution，不重复无条件领取新任务。
- 外部 Codex 缺失、未登录、过旧、initialize 失败或必需方法缺失时有确定诊断。
- Server 不接收 Workspace 或 repositoryPath；日志不记录 Credential、完整 Prompt 或附件内容。
- Web 测试通过 Harness 驱动，生产 Web 不导入 xapt 实现。

## 验证

- Fake Codex 覆盖成功、结构化结果错误、进程退出、未知通知和协议缺失。
- 真实 Codex smoke test覆盖 initialize、thread/start、turn/start、结构化 Outcome 和 Session 继续。
- 临时 Git 仓库验证 Workspace 创建、附件物化和结果收敛。
- 运行 xapt Runner、Execution Contract、Runner Contract 和 Web 集成测试。
- GitNexus `detect_changes` 只命中 Execution、Codex、Workspace、附件和 Outcome 流程。
