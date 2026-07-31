# CBL-001 — 结构化修复结果与缺陷进展时间线

**What to build:** 将 Bug 详情从平铺信息区块改为“进展 / 缺陷资料”双视图，并让 Repair Attempt 以强制结构化的成功或失败结果进入旧到新的生命周期时间线。用户打开详情时直接看到当前状态和最新节点，不再阅读重复 summary、候选提交区块和技术日志堆叠。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## 用户结果

- Bug 详情标题区固定展示编号、标题、当前阶段、工程、负责人和是否需要当前用户处理。
- 详情默认打开“进展”，另一个视图“缺陷资料”承载原始报告和附件。
- 时间线按旧到新排列，打开详情自动定位最新节点；标题区始终显示当前状态。
- 运行中的修复只展示轮次、开始时间、Agent 和“正在自动处理”，不展示实时命令、工具调用或逐字消息。
- 修复成功后，当前节点补全修改内容、检查结果、警告和候选提交数量。
- 修复失败后，当前节点补全失败阶段、失败原因、已完成事项、未执行事项和无输入的“重新执行修复”。
- 完整 Codex `summary`、技术失败码和低频技术信息渐进披露，不与默认结构化内容重复。

## 最新领域与 Contract

- Repair 成功结果必须至少包含：
  - `outcome: 'COMPLETED'`
  - `summary`
  - `changes[]`
  - `validations[]`，每项包含名称、`PASSED | FAILED | SKIPPED` 和可选 detail
  - `warnings[]`
  - 非空 `commits[]`
- Repair 失败结果必须至少包含：
  - `outcome: 'FAILED'`
  - `summary`
  - `failedStep`
  - `reason`
  - `completedActions[]`
  - `pendingActions[]`
- 平台只验证、存储和展示 Codex 返回的结构化字段，不调用第二个 AI 提取或改写。
- Execution 没有 Codex 结构化结果时，失败节点使用实际 Execution failure code/message；缺失具体原因时明确显示“未返回更具体的失败原因”，不得猜测。
- 失败仍属于 `REPAIRING` 阶段，不新增失败 Stage 或失败列。
- “重新执行修复”不接受用户补充文本；新 Attempt 继续原 Repair Thread。
- 原始 Bug 报告在 `WAITING_FOR_REPAIR` 可编辑；进入 `REPAIRING` 后冻结且只读。

## 时间线节点

第一条纵向切片至少支持：

- 缺陷已登记。
- 第 N 轮修复进行中。
- 第 N 轮修复已完成。
- 第 N 轮修复未完成。
- 重新执行后产生的下一轮修复节点。

时间线 Projection 必须使用稳定类型，不从 UI 文案或数据库表名反推节点语义。

## 验收标准

- 一条真实 Repair Execution 从开始到成功后，运行中节点原位变为结构化成功节点。
- 失败结果默认可见失败阶段、原因、已完成和未执行事项，并能无输入重新执行。
- 成功节点默认不重复展示完整 summary；展开后能查看 Codex 原始完整结论。
- 结构化 validations 对 PASS、FAIL、SKIP 使用中文展示，不暴露内部枚举。
- 测试负责人只能看到安全业务摘要；工程负责人可按既有安全边界查看 Commit 和技术详情。
- “缺陷资料”在待修复阶段有编辑入口，进入修复后显示冻结说明且无编辑入口。
- 抽屉内容可滚动到全部节点和操作，隐藏滚动条不影响滚轮、键盘或触控板。
- Repair Prompt、JSON Schema、Contract、Service Projection、时间线 UI 和定向测试在同一 Ticket 中完成。
- 不保留旧 Repair output schema、长 summary fallback 或旧详情区块兼容分支。

## 验证

- Repair Prompt/Schema 契约测试覆盖成功、失败和格式无效。
- Repair Service 测试覆盖运行、成功、失败、重新执行和原 Thread 延续。
- 时间线 Projection 测试覆盖轮次、时间排序、角色脱敏和原始 summary 折叠数据。
- 浏览器验证默认打开进展、定位最新节点、切换缺陷资料、成功与失败节点及桌面滚动。
