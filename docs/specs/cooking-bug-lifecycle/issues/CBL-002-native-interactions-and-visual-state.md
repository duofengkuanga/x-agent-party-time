# CBL-002 — 原生 Interaction 例外处理与互斥视觉状态

**What to build:** 将 Codex 权限请求和主动提问作为当前 Repair/Update Attempt 内的结构化时间线节点处理，并由 Server 为每个 Bug 或 Batch 派生唯一、互斥的当前视觉状态。正常自动运行保持呼吸色，只有真正需要用户处理或已失败时使用明确语义色。

**Blocked by:** CBL-001 — 结构化修复结果与缺陷进展时间线。

**Status:** ready-for-agent

## 用户结果

- Codex 请求权限时，时间线节点展示用途、命令/权限摘要和三个决定：拒绝、仅允许这一次、本次会话允许。
- “仅允许这一次”是默认主操作；“本次会话允许”明确说明作用域。
- Codex 请求信息时，页面按原始 questions/options 结构渲染，不退化为通用反馈框。
- 有选项的问题使用单选项、选项说明和自定义答案；无选项时才使用文本框；多个问题统一提交。
- Interaction 解决后变成只读记录，并显示实际决定或回答。
- 除 Interaction 表单外，修复和更新阶段不存在自由文本输入框。

## 权限与信息边界

- Repair Interaction 只有该 Bug 所属工程负责人可以处理。
- Update Interaction 只有该 Batch 所属工程负责人可以处理。
- 其他项目成员可以看到安全的“等待负责人处理”状态，但看不到不应暴露的命令、权限、Commit、Session 或技术参数。
- 服务端必须验证权限、Interaction state、实体 version 和 Execution lease；前端隐藏不能代替服务端授权。

## 唯一视觉状态

Server Projection 使用一个判别联合，而不是多个 Boolean 或前端优先级：

```text
IDLE
RUNNING
NEEDS_APPROVAL
NEEDS_INPUT
FAILED
WAITING_TO_RESUME
QUEUED_FOR_ENGINEERING
```

视觉映射：

- `RUNNING`：现有呼吸色动画。
- `NEEDS_APPROVAL`：珊瑚色状态线、符号和文字。
- `NEEDS_INPUT`：低饱和暖黄色/赭黄色状态线、符号和文字。
- `FAILED`：砖红色状态线、符号和文字。
- `WAITING_TO_RESUME`、`QUEUED_FOR_ENGINEERING`：中性暖灰/淡墨色，静态无动画。
- `IDLE`：普通墨色。

不得仅依赖颜色；状态文字、符号、ARIA label 和 `data-visual-state` 必须一致。若同一对象同时派生多个当前状态，应视为领域一致性错误并由测试暴露，前端不得选择“更高优先级”掩盖。

## 验收标准

- Command Approval 支持 `decline`、单次 `accept` 和 `acceptForSession`。
- Permission Approval 正确区分 Turn Scope 与 Session Scope，只提交 Codex 实际请求的权限子集。
- User Input 完整保留 question header、question、options 和 option description；内部英文 value 不直接展示。
- 待处理 Interaction 存在时，对应 Attempt 不显示普通运行状态。
- Interaction 在 Execution 终态时同步失效，不出现 Execution 已失败但 Interaction 仍 PENDING。
- 卡片与详情标题从同一个 Server visual state 渲染，状态文案和颜色不漂移。
- 旧“拒绝 / 本次会话允许”双按钮实现、忽略 options 的文本框实现和 `waitingForInteraction` 多 Boolean 逻辑被删除。

## 验证

- App Server resolution 契约测试覆盖三种授权决定和权限作用域。
- Repair/Update Interaction Service 测试覆盖权限、过期、重复处理、终态失效和角色脱敏。
- Projection 测试断言 visual state 严格互斥。
- 浏览器验证权限、提问、只读结果、键盘焦点、按钮禁用和纸张/夜间主题色。
