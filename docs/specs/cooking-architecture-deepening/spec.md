# Cooking 架构深化实施规格

状态：已确认，待按 CAD-001 至 CAD-005 实施和验收

来源：2026-08-11 架构审查与 grilling 对谈。

## 目标

在不改变既有产品行为的前提下，把 Cooking 热点中的执行编排、Test Submission 写入、Bug 报告知识、Server Action transport、Project settings route state 与 BugBoard 验证集中到 deep module，提升 locality、leverage、testability 与 AI-navigability。

## 已确认决策

- 项目处于开发期，Execution contract 与数据库 Schema 直接升级到最新模型，不保留 fallback、双写、兼容 adapter 或旧数据迁移。
- Execution 审批策略是通用、不可变执行约束，由创建 Execution 的领域 module 决定、持久化并通过 contract 传给 xapt；xapt 不解释 Cooking owner。
- Cooking Execution implementation 内部保留事务内 apply 与提交后通知时序，但 Repair、Update Batch 与 Cleanup 不再向调用者暴露六组生命周期 hook。
- 通用 CookingWriteStore 继续服务 Project、Engineering 与 Binding；Test Submission 使用专用 deep write module 统一 mutation replay、audit、revision 与 exactly-once invalidation。
- action transport 只处理文件字节、大小/媒体类型、临时存储与失败清理；Bug module 拥有附件角色、绑定权限、排序、替换、projection 与 Repair context projection。
- Interactive mutation 与 Redirect mutation 使用两个不同 interface，共享内部 FormData、上传清理和错误映射 implementation。
- 非法 Project settings route state 使用 replace redirect 规范化到最近的可访问父级。
- BugBoard 回归使用 `chrome-use test` 与隔离浏览器 fixture，不新增 React DOM 测试依赖。
- 除非法 route state 规范化外，保留现有文案、视觉、操作路径、状态转换、错误反馈与权限行为。

## Ticket 顺序

| 顺序 | Ticket | 可独立验证结果 | Blocking edges |
| --- | --- | --- | --- |
| 1 | CAD-001 | Cooking Execution 编排集中，xapt 不再识别 Cooking | 无 |
| 2 | CAD-002 | Test Submission mutation 时序由一个 deep module 保证 | CAD-001 |
| 3 | CAD-003 | Bug 报告与附件知识集中，Repair 不再直查附件表 | CAD-002 |
| 4 | CAD-004 | 两类 action transport 与 Project route state 集中 | CAD-003 |
| 5 | CAD-005 | BugBoard 关键行为由 chrome-use browser suite 验证 | CAD-004 |

## 非目标

- 不重设计 BugBoard、Project settings 或 Cooking 视觉语言。
- 不拆散 xapt Execution 的 claim、lease、outbox、recovery、Interaction 等 deep implementation。
- 不把 Cooking 状态机移入通用 Runner / Execution module。
- 不把本机仓库路径发送或保存到 Server。
- 不为只有一个实际 implementation 的依赖制造 hypothetical seam。
- 不在 `bun test` 中启动浏览器或 Web Server；浏览器回归使用独立质量门。

## 共同完成定义

- 修改任何 function、class 或 method 前运行 GitNexus upstream impact；HIGH/CRITICAL 必须先说明风险。
- 每个 Ticket 先更新 contract / seam，再更新 implementation、callers 与 tests。
- 每个 Ticket 删除被取代的浅 module、重复 wiring 和源码字符串断言，不叠加兼容实现。
- 每个 Ticket 运行相关测试、类型检查、格式检查与 GitNexus detect_changes。
- CAD-005 使用独立临时 `AGENT_PARTY_TIME_HOME`，fixture 不读取或污染开发数据库。
- 最终运行全量测试、全量 typecheck、格式检查、Web build、chrome-use browser suite，并完成 Standards / Spec 双轴评审。

