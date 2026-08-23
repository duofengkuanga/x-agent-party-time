# EOM-002 统一 xapt 附件与验证结构化输出

状态：已实施，待发布验收。

## 范围

- 将初始 Brief 中的附件引用补全为带本机路径的统一证据项，不追加重复映射。
- 为嵌套 `anyOf` 输出 Schema 增加 App Server 请求级验证。
- 保持本机绝对路径不离开 xapt 到 Server 的边界。

## 验收标准

- Codex 初始输入只包含一个附件表示。
- 结构化输出验证覆盖成功和失败分支。
- 续跑不重注入 Skill 或完整 Brief。

## Blocking edges

- EOM-001 定义新 Brief 附件形状。
