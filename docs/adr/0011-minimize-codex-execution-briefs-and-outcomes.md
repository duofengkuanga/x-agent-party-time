---
status: accepted
---

# 最小化 Codex Execution Brief 与 Outcome

Codex 首次执行只接收完成当前任务不可从本机工作区推导的事实：当前 Bug 的短验收上下文、必要的目标分支、反馈、未交付提交和带角色的本机附件路径；不传 ID、空值、重复附件元数据、仓库 URL 或整份无关需求。Repair 与 Update 的稳定流程和安全规则由版本化 Skill Bundle 提供，不随每次 Brief 重复发送。

Execution 过程以增量 Progress Update 呈现；需要用户决定或授权时创建 Interaction，而非产生 FAILED Outcome。每次 Execution 只提交一次终态的紧凑 Outcome：成功保留完成类别、最多五项修改、最多五项验证、提交和最多三项警告；失败保留失败阶段、原因以及各最多五项已完成与待办。Server 是 Output JSON Schema 的唯一所有者，并将其用于 Codex 结构化输出与结果校验；Skill 只定义何时返回终态、字段语义和诚实性约束，不复制 Schema 字段、类型或占位值。服务端生成状态文案，不要求模型重复填写成功摘要、互斥分支的 null/空数组占位，或无限长度的文本清单。该取舍牺牲了在每条消息内携带完整快照的便利性，换取更低的模型 token、清晰的状态机语义和更少的前后叙述冲突。

## Considered options

- 每次进度均返回完整 Outcome：易于单条消息独立展示，但持续重复事实、浪费 token，并混淆过程、等待和失败。
- 保留完整 Brief 和内联规则：实现直接，但重复传输平台元数据与稳定策略，且会使入口规则逐步漂移。
