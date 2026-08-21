---
status: accepted
---

# 将平台外恢复的 Codex Session 同步为新尝试

失败后的 Repair 与 Update 不再由平台“重新执行”按钮启动；平台只向工程负责人展示 Session ID，开发者在本机恢复会话。会话进行期间平台保留此前失败状态；工程负责人点击“同步状态”后，xapt 只读读取该 Session 的最新结果。结果符合原 Repair 或 Update Schema 时，Server 追加一轮 External Session Attempt 并按结果推进状态；无有效结果时保持原状态，绝不改写原失败记录。验证不通过和已完成 Bug 重新打开仍由平台携带新反馈，自动续接原 Repair Session，因为它们是业务事件而非开发者接管失败恢复。

## Considered options

- 保留平台发起的重试：与开发者直接在 Codex 中修复失败的工作方式冲突。
- 将原失败记录改写为成功：丢失真实失败与恢复过程，审计和时间线失真。
- 在平台内重新启动 Codex：与开发者直接在 Codex 中修复失败的工作方式冲突。

## Consequences

- 移除“重新执行修复”和“重新执行统一更新”入口。
- “同步状态”仅在最新 Repair 或 Update 已失败且存在 Session ID 时向对应工程负责人显示。
- xapt 必须按工程负责人的同步请求读取指定 Session 最后一个已完成 Turn 的最终回复、校验 Schema 并幂等上报；不得扫描或挑选更早的 JSON。
- 无有效结果的同步不改变平台状态，平台不从自然语言过程消息或 Git 改动推断成功。
- 有效的失败结果也必须追加一轮 External Session Attempt，并保持失败，以保留每次平台外恢复的历史。
