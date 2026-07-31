# XAPT-008 — 补齐并发、Interaction、Outbox 与重启恢复

**What to build:** 在单条 Execution Happy Path 上补齐 daemon 的长期运行语义：固定三个执行槽、同 Binding 串行、Interaction、interrupt、Session 继续、Outbox 重放、忙碌状态和强制停止恢复。

**Blocked by:** XAPT-007。

**Status:** blocked

## 用户结果

- 不同 Binding 最多并行执行三条任务，同一 Binding 始终只有一条活动 Execution。
- Codex 请求权限或信息时，用户可在 Web 处理 Interaction，Execution 随后继续。
- 网络失败时 Outcome 进入 Outbox，daemon 重启后先重放再领取新任务。
- 普通 stop、update 和 uninstall 在忙碌时拒绝；`daemon stop --force` 明确告知后果并要求真实 TTY 确认。

## 实施范围

- 实现固定容量 3 的调度与实时 `availableSlots` Heartbeat。
- 实现 Binding 级互斥、Lease 刷新、等待 Interaction 和恢复优先级。
- 迁移 Codex 权限请求、用户输入请求、interrupt 和 Session 继续。
- 完成 Outbox 持久化、幂等重放、失败退避和启动恢复顺序。
- 建立 Execution 本机恢复记录和崩溃后状态判断，避免重复提交或错误领取。
- 完整计算 `Activity: IDLE | BUSY`，status 显示已用槽位、等待 Interaction、Binding 活动和 Outbox 数量。
- 实现普通 stop 的排空语义和 `stop --force` 的 TTY 确认、尽力持久化、超时终止与残留警告。

## 非范围

- 不提供可配置并发数、优先级 UI、pause、queue 管理或 `daemon restart`。
- 不让等待 Interaction 的任务绕过现有 Execution/Cooking 生命周期约束。
- 不实现 update 和 uninstall 的文件切换或删除动作。
- 不把业务阶段或 Git 工作流下沉到 Runner。

## 验收标准

- 三个不同 Binding 可并发，第四条等待；同一 Binding 的第二条在第一条收敛前不启动。
- Interaction 处理后继续原 Session，不创建意外的新 Thread。
- daemon 在 Outcome 发送失败后重启，先成功重放 Outbox，再报告可用槽位和领取新任务。
- 普通 stop 在执行、Interaction、Binding 或 Outbox 未收敛时拒绝，并说明阻塞项。
- `stop --force` 在非 TTY 环境拒绝；确认后不删除状态，并报告可能遗留的 Lease、Workspace 和远程状态。
- status 的槽位、Interaction、Outbox 和 Binding 数量与真实状态一致。

## 验证

- 确定性调度测试覆盖 1/3、3/3、4 条任务、同 Binding 串行和恢复优先级。
- Interaction、interrupt、Session 继续和权限决定的 Contract 测试。
- 进程崩溃、网络中断、重复 Outcome、Outbox 重放和强制终止恢复测试。
- 真实 Codex Conformance 覆盖权限、提问、interrupt 与 Session 继续。
- GitNexus `detect_changes` 只命中调度、Interaction、Outbox、恢复和 daemon 状态流程。
