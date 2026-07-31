# XAPT-003 — 建立跨应用 Runner Contract Conformance Harness

**What to build:** 用 `execution-contract` 和 `runner-contract` 建立协议级 Fake Agent / Conformance Harness，替代 Web 集成测试对 `RunnerWorker`、`RunnerStateStore`、`CodexAppServerExecutor` 等内部实现的直接导入，使 Web 与 xapt 只通过正式 HTTP Contract 耦合。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## 用户结果

- Web 的授权、Heartbeat、Binding、Execution、Interaction 和 Outcome 行为可通过协议级 Agent 完整验证。
- Web 测试不再因为 xapt 内部目录、状态类或 Codex executor 移动而失败。
- Contract 变更在 Server 与 Agent 不一致时立即由 Conformance 测试报告。

## 实施范围

- 建立只依赖共享 Contract 和 HTTP Interface 的 Fake Agent / Harness。
- 支持注册或授权、Bearer Credential、Heartbeat、Binding 请求与响应、Execution 领取、Interaction 和 Outcome 提交。
- 提供确定性的请求等待、超时、断言和测试清理，不用固定 sleep 掩盖竞态。
- 将现有 Web Execution、Repair、Update 三组跨应用集成测试迁移到 Harness。
- 保留真正属于 xapt 内部实现的单测在 xapt/旧 Runner 范围；Web 不导入这些实现。
- 添加架构测试，禁止 `apps/web` 生产代码和测试跨边界导入 `apps/xapt` 或 `packages/runner/src`。

## 非范围

- 不实现 xapt daemon、LaunchAgent、Keychain 或真实 Codex。
- 不改变 Runner HTTP Contract 的产品语义，除非发现当前 Contract 无法表达既有行为；此时先更新 Spec 或 ADR。
- 不用 Fake Agent 伪造用户可见成功而跳过 Server 状态断言。
- 不删除 `packages/runner`；最终删除属于 XAPT-013。

## 验收标准

- Web Execution、Repair 和 Update 集成测试通过 Harness 完成，不直接构造 Runner 内部类。
- Harness 能证明 Credential 缺失或错误时被拒绝，正确 Credential 可完成全链路。
- Binding 响应不包含也不要求本机仓库绝对路径。
- Execution Outcome、Interaction 和失败响应按共享 Schema 严格验证。
- 架构测试能对新增的跨应用内部导入稳定失败。
- 生产代码行为不因测试 Seam 改造而变化。

## 验证

- 运行 Harness 自身测试和迁移后的三组 Web 集成测试。
- 运行 `runner-contract`、`execution-contract` 测试与类型检查。
- 运行 Web 类型检查和相关架构测试。
- GitNexus `detect_changes` 只命中测试 Seam、共享 Contract 和必要的测试装配。
