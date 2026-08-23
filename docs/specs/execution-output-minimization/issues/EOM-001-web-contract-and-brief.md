# EOM-001 直接切换 Web Brief 与 Outcome 契约

状态：已实施，待发布验收。

## 范围

- 将 Repair / Update Brief 收缩为最小任务事实。
- 移除 Repair 内联稳定指令、平台 ID、空值、仓库 URL 与无关提测单字段。
- 以嵌套 `result.anyOf` 替换全字段占位输出 Schema，并更新 Zod 契约、结果投影、时间线与定向测试。
- 不保留旧 Schema、旧投影或 Session 兼容。

## 验收标准

- 新 Brief 与新 Outcome 符合 [spec.md](../spec.md)。
- Repair / Update 结果严格校验数量、长度与成功/失败字段边界。
- 页面继续展示修改、验证、警告、失败原因与提交信息。

## Blocking edges

- EOM-002 证明 Codex App Server 接受嵌套 `anyOf`。
