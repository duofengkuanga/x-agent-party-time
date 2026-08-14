# ESK-002 使用 Skill 完成 Bug Repair

状态：已实施，待用户验收

## 用户结果

一个 Bug Repair Attempt 通过显式 Repair Skill、结构化 Execution Brief 和现有输出 Schema 完成修复。失败后的重试继续原 Codex Task。

## 范围

- 在通用 Execution Contract 中增加可选 `codexTurn`、Skill 请求和解析结果、Execution Brief 及 Hash、输出 Schema 和 Task Skill Binding。
- 保持 `CLEANUP.codexTurn` 为 `null`。
- 由 Server 构建 Repair 初始 Brief 和后续继续输入。
- 由 xapt 解析当前 Bundle，返回身份，并使用结构化 `SkillUserInput` 启动首次 Turn。
- 由 Server 保存 Task Skill Binding。
- 重试时恢复原 Task、校验原 Bundle，并只发送继续指令或新增事实。
- 保持 xapt 负责 Branch Worktree 和附件物化。
- 删除 Repair Prompt 构建器、字段、测试和开发数据依赖。

## 验收标准

- 首次 Turn 包含一个 Repair Skill 输入和一个 JSON Brief 文本输入。
- Server 不保存 Skill 全文或本机路径。
- Repair 成功时只创建普通本地 Commit，不 Push 或部署。
- 后续 Turn 不重新注入 Skill 或完整 Brief。
- Task 无法恢复或原 Bundle 缺失时明确失败，不自动重建或改用新 Bundle。
- Repair Contract、xapt 请求结构和端到端测试通过。

## Blocking edges

- ESK-001 提供可解析的 Repair Bundle 和 generation 清单。
