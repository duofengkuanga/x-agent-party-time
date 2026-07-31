---
status: accepted
---

# Runner 保持领域无关

Runner 只承载通用 Execution、Lease、附件、Interaction、Outcome 与 Outbox，不理解 Project、Bug、Repair、Update Batch、Verification 或 Cleanup 的业务语义。Git、测试、构建、提交、Push、部署和清理步骤由 Codex 根据 Server 提供的版本化 Prompt、仓库规则和结构化输出执行；这样可以避免在 Server、Runner 与 Codex 之间复制 Cooking 工作流和 Git 状态机，并让同一 Runner 支持未来的其他业务场景。
