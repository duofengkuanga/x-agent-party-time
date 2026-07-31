# CBL-007 — 最新 Schema 全链路验收与旧路径收口

**What to build:** 在不兼容旧开发数据的前提下，使用最新 Schema 和真实本地 Agent 验证缺陷从登记、修复、挂起、恢复、共享更新、验证、返修、完成、归档以及取消恢复的完整闭环，并删除所有被新 Ticket 取代的旧代码、文案和架构入口。

**Blocked by:** CBL-001 至 CBL-006。

**Status:** blocked

## 数据与切换策略

- 不编写旧 Schema migration。
- 不兼容 `cooking_bug_feedback`、全局 repair queue、旧 Cleanup reason、旧 output schema 或不可恢复 CANCELLED 数据。
- 清空开发 Server 数据并使用最新 Seed 重建；Agent 凭据和 Binding 是否保留按实际 Schema 变化决定，不通过兼容字段伪装。
- 历史 `.scratch` Ticket 不改写，但实现和验收只按本目录最新 Ticket 判断。

## 真实验收数据

Seed 或真实操作至少覆盖：

- 待修复且可编辑的 Bug。
- 正常运行中的 Repair，显示呼吸状态。
- Repair 权限请求，显示珊瑚状态和三种决定。
- Repair 主动提问，显示暖黄状态和结构化选项。
- Repair 失败，显示砖红状态、结构化原因和重新执行。
- Interaction 已处理但同工程忙，显示“等待继续”。
- 同工程 FIFO 和不同工程并行。
- Repair 唯一临时分支与 Update Detached HEAD Worktree。
- 多 Bug 共享 Update Batch 卡。
- Update 成功、失败、权限、提问和重新执行。
- 待验证直接通过与失败返修。
- 已完成重新打开并通过反馈表达回退诉求。
- 待修复取消、Toast 撤销、抽屉恢复。
- 已完成归档、Toast 撤销、抽屉移出归档。
- 测试负责人和工程负责人看到不同 Action 与技术详情。

## 视觉与交互验收

- `/cooking`、`/cooking/projects`、`/cooking/agents`共享 Cooking Shell 保持一致。
- 六列固定布局不依赖横向滚动展示固定列；详情和抽屉内容可纵向滚动。
- Bug 卡与 Batch 卡状态使用唯一语义：呼吸、权限珊瑚、问题暖黄、失败砖红、等待继续暖灰、普通墨色。
- 状态不只依赖颜色，文字、符号、ARIA 和 `data-visual-state`一致。
- 详情默认进展、定位最新节点、切换缺陷资料、返回共享 Batch 均可用。
- 按钮默认、悬停、焦点、禁用和持久状态遵守项目全局按钮规则。
- 浅色和夜间主题在桌面视口完成截图对照。

## 旧路径删除检查

仓库不得残留用户可达的：

- 全局修复队列及手动排序。
- 通用补充反馈与继续文本框。
- 实时 Codex 对话/Steer/Queue/Pause 入口。
- Bug 取消 Cleanup 和重试清理。
- 修复后取消 Bug。
- 不可恢复已取消语义。
- `ARCHIVED` Bug Stage。
- 每 Bug 重复 Update Batch Interaction。
- 双按钮权限请求。
- 只依赖长 summary 的旧结果 Projection。
- 视觉状态 Boolean 优先级。
- 非测试负责人生命周期拖拽或按钮。

## 验收标准

- 从最新空数据库完成至少一条正常修复与更新闭环，不读取或转换旧反馈、队列、Cleanup 或结果数据。
- 同工程挂起任务不阻塞后续任务，Interaction 处理后按约定优先恢复且工作区无串扰。
- Repair 候选 Commit 被 `apt/repair/<bug-id>`真实 ref 持有；Update Batch 使用 Detached HEAD，临时 Worktree 不占用目标分支。
- 在临时 Worktree 存续期间，用户能在自己的仓库 Worktree 中正常切换目标分支，不出现 `already checked out at`错误。
- 多 Bug Update Batch 在更新中列只有一张批次卡，完成后正确拆回待验证 Bug。
- 成功、失败、权限、提问、等待继续、取消、恢复、归档、移出归档、验证返修和重新打开均能从页面完成或观察。
- 测试负责人和工程负责人的按钮、拖拽、Interaction 与技术详情权限符合最新矩阵。
- 仓库不存在被新 Ticket 推翻的用户入口、兼容分支、旧字段或旧表。
- 真实浏览器中浅色和夜间主题无布局、滚动、焦点、禁用态或控制台错误。

## 验证

- 相关 Contract、Service、Runner、Projection、UI 和架构测试通过。
- `bun run test`
- `bun run typecheck`
- `bun run format:check`
- `bun run build:app`
- `bun run check:deps`
- 真实浏览器无控制台错误。
- GitNexus `detect_changes --scope compare --base-ref main`只命中预期缺陷生命周期、Execution 调度、Update、Lifecycle 和 Presentation 流程。
- 真实 Git 验收覆盖 Repair 临时分支创建、跨 Attempt 复用、Update Detached Worktree、用户切换目标分支和提测单关闭 Cleanup。
- Standards 与 Spec 双轴评审无高置信缺失、偏离或 scope creep。

## 完成标准

- 测试人员不需要管理自动执行过程，只处理 Codex明确请求的权限/信息、验证和整理动作。
- 工程负责人只处理所属工程技术 Interaction、失败重新执行和外部结果。
- 同工程停滞任务不阻塞其他任务，恢复仍保持串行和工作区隔离。
- 看板、详情、Batch、已取消和归档的对象语义与真实领域一致。
- 所有新文案使用中文，用户页面不暴露内部 Runner、枚举、表名、Session 或本机路径。
