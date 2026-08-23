# 精简 Codex Execution 输入与终态输出

状态：已实施，待发布验收。

## 目标

降低每次 Repair 和 Update Codex Execution 的输入与输出 token，同时保留严格的机器校验、可恢复的既有 Session 和必要的人工决策能力。

## 已确认的边界

- Brief 只包含本机工作区无法推导、且与当前任务直接相关的事实；不发送平台 ID、工作区 key、仓库 URL、空字段或整份无关需求。
- 初始附件统一为 `{ role, name, path }`；`fileId` 保留在平台与 xapt 内部，不进入 Codex Brief。
- Repair / Update 的稳定行为和字段语义由对应 Skill 定义；Output JSON Schema 的精确字段、类型和校验由 Server 唯一拥有，并在每个 Turn 通过 `outputSchema` 下发。
- Progress Update 是增量时间线事件；用户选择、授权或澄清使用 `USER_INPUT` Interaction，不产生 `FAILED` Outcome。
- 每个终态 Turn 只返回一次紧凑 Outcome；成功由 Server 生成展示文案，不要求模型生成重复 `summary`。
- 正常上限：修改、验证、失败时的已完成事项与待办各最多 5 项；警告最多 3 项；每项最多 300 字；失败原因最多 500 字。

## 新终态结构

Codex Structured Output 在严格模式下要求对象属性必填。为避免成功与失败的互斥字段被迫以 `null` 或空数组返回，新契约使用一个必填根字段 `result`，其值为嵌套 `anyOf` 分支；每个分支只拥有自身所需字段。

Repair 成功分支包含 `outcome`、`completionKind`、`changes`、`validations`、`warnings`、`commits` 与 `manualOperations`。Repair 失败分支只包含 `outcome`、`failedStep`、`reason`、`completedActions` 与 `pendingActions`。

Update 成功分支包含 `outcome`、`completedActions`、`validations` 与 `warnings`；失败分支只包含 `outcome`、`failedStep`、`reason`、`completedActions`、`validations`、`warnings` 与 `pendingActions`。`CI_CD` 成功只能是 `PUSHED`，`LOCAL_SCRIPT` 成功只能是 `COMPLETED`。

Validation 使用 `{ name, status, detail }`；`detail` 不适用时为短空字符串，而非 `null`。这保持严格 Schema 的必填性质，又避免额外的 JSON 占位字段。

## 开发期切换

当前处于开发期，直接移除旧 Brief、旧输出 Schema 与旧结果投影，不保存 `outputContractVersion`，也不实现旧 Session 的续跑兼容。任何未完成的开发任务在切换后重新创建；旧开发数据允许清空重建。xapt 只补全统一附件项的 `path`，新 Skill 直接依赖新 Brief 与 Schema。

## 非目标

- 不改变 Repair 的本地提交边界，或 Update 的 Push / 部署边界。
- 不由 Server 保存本机绝对路径。
- 不把进度消息当作终态 Outcome 保存。
- 不提前中止、重写或升级既有 Session。

## 验证

- 新 `outputSchema` 以真实 Codex App Server 的严格模式验证嵌套 `anyOf` 可接受。
- Repair / Update Contract、Service Projection、时间线与 xapt 请求测试只覆盖新契约。
- 新 Task 的 Brief 不出现内部 ID、空值、仓库 URL、重复附件字段或内联稳定规则。
- 成功与失败结果不含对方分支的占位字段，且超过数量或长度上限时被拒绝。
- `item/tool/requestUserInput` 能在业务决策等待时创建 `USER_INPUT` Interaction，并在回答后原 Session 继续执行。
