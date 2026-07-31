# CBL-003 — 非阻塞工程串行调度与全局队列删除

**What to build:** 将执行约束从“WAITING Interaction 继续独占 Binding”改为“同工程同时只有一个真正操作仓库的 Execution”。等待权限或信息的任务挂起并释放工程通道，同工程后续任务可以继续；用户处理完成的任务在当前执行结束后优先恢复。同时删除提测单级全局修复队列和人工排序。

**Blocked by:** CBL-002 — 原生 Interaction 例外处理与互斥视觉状态。

**Status:** ready-for-agent

## 用户结果

- 同工程任务 A 等待授权或回答时，不阻塞任务 B 开始修复或更新。
- 用户处理任务 A 的 Interaction 后，如果任务 B 正在运行，A 显示“等待继续”，不打断 B。
- B 结束后 A 优先恢复，并把已记录的 Interaction resolution 交回原 Codex Turn。
- 普通等待工程通道的卡片显示“等待工程执行通道”和前方任务数，使用中性静态状态。
- 看板顶部不再有“全局修复队列”，用户不再上下移动任务。

## 调度语义

同工程执行通道的占用状态只包含真正操作仓库的阶段；至少满足：

```text
CLAIMED / active RUNNING       -> 占用工程通道
NEEDS_APPROVAL / NEEDS_INPUT   -> 挂起，不占用
WAITING_TO_RESUME              -> 排队，不占用
terminal FAILED/SUCCEEDED      -> 不占用
```

工程内顺序：

1. 已完成 Interaction、等待恢复的任务。
2. 普通待执行任务按提交修复或创建 Batch 的时间 FIFO。

Interaction resolution 必须先持久化，再等待工程通道；未重新获得通道前不得让挂起 Codex Turn继续操作仓库。

## 工作区隔离与分支硬约束

释放工程通道的前提是不同任务不能共享可变工作目录：

- 每个 Repair 具有真实隔离的任务 Worktree。
- 每个 Update Batch 具有真实隔离的 Integration Worktree。
- 挂起任务保留自己的 Worktree 和 Codex Thread，不被后续任务修改。
- 本机绝对路径仍只保存在 Agent；服务端只持有逻辑 workspace key。
- Agent 本机保存 workspace key、物理 Worktree 路径和临时分支等清理所需映射，但不得上传绝对路径。
- 实现可以扩展通用 Runner workspace capability，但不得把 Cooking Git 业务状态机下沉到 Runner。
- 不能仅从 SQL 中移除 `WAITING_FOR_INTERACTION` reservation 而继续把所有 Codex 指向同一个绑定仓库 cwd。

### Repair Worktree

- 一个 Bug 使用一个长期 Repair Worktree，同 Bug 多轮 Repair Attempt 和重新打开继续复用。
- Repair Worktree 必须 checkout 唯一临时分支，例如 `apt/repair/<bug-id>`。
- 临时分支基于该轮要求的目标分支基线创建，但不得直接 checkout `main`、`testForAPT` 或其他工程目标分支。
- Repair 只创建普通本地 Commit并返回 SHA，禁止 Push。
- 唯一临时分支为候选 Commit 提供真实 Git ref，避免 Worktree 删除或 Git GC 后只剩数据库中的悬空 SHA。

### Update Batch Worktree

- 一个 Batch 使用一个短生命周期 Integration Worktree。
- Integration Worktree 必须以 Detached HEAD 基于最新 `origin/<target-branch>`创建。
- Update Codex 按冻结顺序集成候选 Commit，验证后普通 Push 到目标分支。
- Integration Worktree 不创建或占用目标本地分支，也不遗留无意义的本地 Batch 分支。

### Cleanup

- Bug 完成、待验证、归档或重新打开均不清理 Repair Worktree。
- 提测单关闭后异步删除该提测单的 Repair/Integration Worktree。
- Repair Cleanup 在确认安全后删除 Worktree，再删除对应 `apt/repair/<bug-id>`临时分支，并执行安全的 `git worktree prune`。
- Detached Integration Cleanup 只需安全删除 Worktree并 prune。
- Cleanup 不得删除用户原有 Worktree、目标分支、不明目录或带有无法确认归属的未提交修改。

## 删除旧全局队列

删除：

- `cooking_repair_queue`
- `cooking_repair_queue_entry`
- queue position/version/reorder mutation
- `REORDER` Action
- 全局修复队列抽屉、按钮和上移/下移交互
- Prompt priority 与提测单全局排序的耦合

Bug 进入 `REPAIRING` 时直接创建工程 FIFO 中的 Execution；前方任务数从实际工程执行序列派生，不维护第二份排序事实。

## 验收标准

- 同 Binding 的第一个 Execution 等待 Interaction 后，第二个 Execution 可以被领取并运行。
- 两个 Execution 的 cwd/workspace 相互隔离，未提交修改、分支和文件不会串扰。
- Repair Worktree 使用唯一 `apt/repair/<bug-id>`分支；Update Batch Worktree 使用 Detached HEAD。
- 用户在绑定仓库或自己的其他 Worktree 中切换目标分支时，不会出现“already checked out at 临时 Worktree”。
- 第一个 Interaction 被处理时，若第二个仍运行，第一个进入 `WAITING_TO_RESUME`；第二个完成后第一个优先恢复。
- 不同 Binding 继续按 Agent concurrency 并行。
- 失败终态立即释放工程通道。
- Agent 或 Server 重启后，挂起、等待恢复和 FIFO 顺序可以从持久化状态恢复。
- 页面和 Contract 中不存在全局队列、手动 position 或 reorder 概念。
- 不增加业务层网络、Token、上下文或工具自动恢复策略；Codex/Execution 返回什么，平台就记录什么。

## 验证

- Execution Service 集成测试覆盖同 Binding 挂起、第二任务运行、恢复优先和不同 Binding 并行。
- Runner 测试覆盖挂起释放 Slot、resolution 延迟交付、重启和隔离 workspace。
- Repair/Update 调度测试覆盖 FIFO、前方数量和失败释放。
- 浏览器验证队列入口消失、等待工程通道、等待继续和恢复后的呼吸状态。
