# ESK-003 使用 Skill 完成 Update Batch

状态：已实施，待用户验收

## 用户结果

一个冻结 Update Batch 通过显式 Update Skill 完成有序集成、验证、普通 Push，并按 `CI_CD` 或 `LOCAL_SCRIPT` 模式结束。

## 范围

- 复用 ESK-002 的通用 `codexTurn`、Skill 解析和 Task Skill Binding。
- 由 Server 构建 Update 初始 Brief 和外部部署失败的新增事实输入。
- 由 xapt 使用结构化 `SkillUserInput` 启动首次 Turn，并在后续 Attempt 恢复原 Task。
- 保持 xapt 负责 Detached HEAD Worktree 和附件物化。
- 保持 `CI_CD` 的 `PUSHED` 语义。
- 要求 `LOCAL_SCRIPT` 无人值守运行，删除自动输入 `Y` 的行为。
- 删除 Update Prompt 构建器、类型、版本、测试和开发数据依赖。

## 验收标准

- 候选 Commit 按冻结顺序全部集成。
- 质量门失败时不 Push。
- Update 只执行普通 Push，不执行 Force Push 或历史改写。
- `CI_CD` Push 成功后返回 `PUSHED`，不报告外部部署成功。
- `LOCAL_SCRIPT` 只执行 Brief 中的准确命令；命令请求输入时返回 `FAILED`。
- 外部失败证据只作为新增事实发送，不重复完整 Brief。
- Update Contract、xapt 请求结构和两种部署模式端到端测试通过。

## Blocking edges

- ESK-001 提供可解析的 Update Bundle 和 generation 清单。
- ESK-002 提供通用 `codexTurn` 和 Task Skill Binding Contract。
