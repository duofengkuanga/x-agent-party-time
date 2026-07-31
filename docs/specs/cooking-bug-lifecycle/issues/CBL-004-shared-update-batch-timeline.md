# CBL-004 — 共享统一更新批次卡与结构化更新结果

**What to build:** 让 Update Batch 成为更新中列和详情中的唯一共享对象。参与 Bug 在待更新时仍独立展示，Batch 形成后合并为一张批次卡；完整权限、提问、运行结果和失败重试只存在于共享批次详情。更新成功后 Bug 再拆回待验证。

**Blocked by:** CBL-001 — 结构化修复结果与缺陷进展时间线；CBL-002 — 原生 Interaction 例外处理与互斥视觉状态。

**Status:** ready-for-agent

## 用户结果

- “更新中”列按真实 Batch 显示一张共享卡，不为同一 Execution 重复显示多张 Bug 卡。
- 批次卡展示工程、目标分支、部署方式、包含 Bug 数量和唯一当前视觉状态。
- 列头可表达“1 个批次 · 3 条缺陷”，不把对象数误当 Bug 数。
- 点击批次卡进入共享更新详情；权限和问题只能在该详情处理一次。
- Bug 进展时间线只展示“已进入统一更新批次”的摘要、批次状态和详情入口。
- Batch 完成后，参与 Bug 分别进入待验证并重新以独立 Bug 卡显示。
- Batch 失败后留在更新中列，以砖红色批次卡展示，提供无输入的“重新执行统一更新”。

## 结构化 Update 结果

成功结果必须至少包含：

- `outcome: 'COMPLETED' | 'PUSHED'`
- `summary`
- `completedActions[]`
- `validations[]`，每项包含名称、`PASSED | FAILED | SKIPPED` 和可选 detail
- `warnings[]`

失败结果必须至少包含：

- `outcome: 'FAILED'`
- `summary`
- `failedStep`
- `reason`
- `completedActions[]`
- `pendingActions[]`

平台已有的 Batch entries、目标分支、环境和部署配置不要求 Codex 重复返回。是否在 warning 存在时仍返回成功由 Codex 决定，平台不二次判断。

每个 Update Batch 必须在独立 Detached HEAD Integration Worktree 中执行，基于最新 `origin/<target-branch>`集成；不得直接 checkout 或占用目标本地分支。

## Batch 时间线

共享详情至少展示：

- Batch 已形成及冻结 Bug 数。
- 第 N 轮统一更新进行中。
- 权限或信息 Interaction。
- 第 N 轮统一更新已完成、已 Push 等待外部结果或未完成。
- LOCAL_SCRIPT 部署结果或 CI/CD 外部报告。
- 无输入重新执行产生的下一轮 Attempt。

技术详情默认折叠；不实时展示 App Server 命令流。

## 验收标准

- 一个含多 Bug 的运行 Batch 在更新中列只产生一个可操作卡片和一个 Interaction 入口。
- 从任意参与 Bug 打开进展，都只能通过 Batch 摘要进入同一个共享详情。
- 同一个 Interaction 无法从多 Bug 详情重复提交。
- Update 成功/失败使用结构化字段，默认不重复长 summary。
- Integration Worktree 为 Detached HEAD，目标本地分支在其他 Worktree 中仍可正常 checkout。
- Update 失败仍保持 Bug `UPDATING`、Batch `FAILED`，不新增失败列。
- “重新执行统一更新”无文本框并继续原 Update Thread。
- 旧的每 Bug 重复 UpdateBatchDetails、重复 Interaction 和“补充信息并继续统一更新”被删除。

## 验证

- Update Prompt/Schema 测试覆盖 COMPLETED、PUSHED、FAILED 和格式无效。
- Batch Projection 测试覆盖多 Bug 聚合、角色脱敏、Interaction 唯一入口和列计数。
- Local Script 与 CI/CD Service 测试覆盖成功、失败、外部报告和重新执行。
- 浏览器验证多 Bug 合并、批次详情、返回 Bug、失败色、授权色和完成后拆分。
