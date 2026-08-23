# EOM-003 收紧 Repair 与 Update Skill 的结果语义

状态：已实施，待发布验收。

## 范围

- 删除完整 Schema 字段和占位值的重复说明。
- 规定单次终态结果、紧凑证据上限与用户决策使用 `USER_INPUT` Interaction。
- 维持 Repair / Update 既有 Git、验证、Push 与部署边界，并更新 eval。

## 验收标准

- Skill 不复制 Server 的 JSON Schema。
- Skill 只描述结果语义、真实性和长度上限。
- 需要选择、授权或澄清时不以 `FAILED` 代替 Interaction。

## Blocking edges

- EOM-001 与 EOM-002 提供新 Brief、Schema 与 Interaction 行为。
