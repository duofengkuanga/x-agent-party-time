# CAD-001 — 深化 Cooking Execution 编排

**What to build:** 将 Cooking 对 Execution 开始、Interaction、终态与提交后 invalidation 的编排集中到一个 deep module；同时让审批策略作为通用 Execution 约束穿过 Server/xapt contract，消除 xapt 对 Cooking owner 的解释。

**Blocked by:** None.

**Status:** ready-for-agent

## 验收标准

- 创建 Execution 时显式确定并持久化通用审批策略。
- xapt Execution 测试和 implementation 不出现 Bug、Repair Attempt、Update Batch 或 Cleanup 判断。
- Runner routes 与跨领域测试只通过通用 Execution seam 驱动 Cooking projection。
- Repair、Update Batch 与 Cleanup 不再公开六组生命周期 hook 给 composition root 或 fixtures。
- 事务内 projection 与提交后通知顺序保持现有语义。
- 保持 ADR-0001 与 ADR-0002。

## 验证

- Execution contract、Server Execution、xapt Execution、Repair、Update、Lifecycle 测试。
- Runner HTTP conformance。
- GitNexus detect_changes 仅命中 Execution 与 Cooking 执行链。

