# ESK-004 保持 Task Skill Bundle 绑定

状态：已实施，待用户验收

## 用户结果

用户更新 Skill 后，新 Codex Task 使用新 Bundle。更新前已经开始的 Repair 和 Update Task 继续使用原 Bundle。

## 范围

- 在 Server 持久化 `skillName`、`bundleHash` 和 `sourceRevision`。
- 在续跑协议中下发已绑定的 Skill 身份。
- 在 xapt 中按 Bundle Hash 解析旧 Bundle，不跟随当前 generation。
- 在每次恢复前重新计算并校验 Bundle Hash。
- 保留旧 Bundle，不实现自动清理。
- 原 Task 无法恢复时返回失败，不自动重建 Task 或历史输入。

## 验收标准

- 安装新 generation 后，新 Task 返回新 generation 的 Skill 身份。
- 已有 Task 继续解析原 Bundle，并保持原行为。
- 当前 Bundle 与旧 Bundle 内容相同时可以复用同一 Bundle 目录，同时保留各 Task 保存的来源 Commit。
- 用户手动删除或修改旧 Bundle 后，续跑失败且不回退到当前 Bundle。
- Mac、xapt daemon 或 Codex App Server 重启后，正常 Task 仍可恢复。

## Blocking edges

- ESK-002 已持久化 Repair Task Skill Binding。
- ESK-003 已持久化 Update Task Skill Binding。
