# CBL-005 — 上下文化验证反馈、重新打开与通用反馈删除

**What to build:** 删除所有阶段通用的“补充反馈”，让用户输入只属于明确生命周期动作。待验证时可以直接通过，或填写反馈后返修；已完成时可以填写反馈重新打开。回退诉求作为反馈交给 Codex 处理，不新增平台回退命令。

**Blocked by:** CBL-001 — 结构化修复结果与缺陷进展时间线；CBL-004 — 共享统一更新批次卡与结构化更新结果。

**Status:** ready-for-agent

## 用户结果

- 修复中、待更新和更新中不再显示“补充反馈”。
- 待验证卡片可以直接点击或拖到已完成，表示无备注验证通过。
- 需要填写通过说明时，用户进入详情提交可选 comment。
- 验证失败必须在详情填写反馈和可选附件；提交后一次完成验证失败记录和下一轮 Repair 创建。
- 已完成 Bug 发现相同问题再次出现时，填写反馈重新打开原 Bug，并延续原时间线和 Repair Thread。
- 用户需要回退部署时，只在重新打开反馈中描述目标；Codex 自行决定 revert、修复或提问。

## 删除旧反馈模型

删除：

- 全局 `ADD_FEEDBACK` Action 与 Server Action
- Bug 详情通用“补充反馈”表单
- `cooking_bug_feedback`及其通用领域语义
- Repair Prompt 中从通用 feedback table 收集历史的逻辑
- Developer Note / Tester Feedback 的游离时间线节点
- “继续修复”文本框和基于任意反馈创建 Continuation 的入口

不迁移或映射现有反馈数据；开发数据库按最新 Schema 重建。验证失败与重新打开的反馈分别存储在对应领域记录中，并直接构建下一轮 Repair Prompt。

## 生命周期时间线

验证失败使用一个复合节点，不拆成数据库操作日志：

```text
第 N 轮验证未通过
- 反馈
- 附件
- 已进入第 N+1 轮修复
```

重新打开节点包含：

- 重新打开时间与测试负责人
- 反馈和附件
- 已进入下一轮修复

验证通过、验证失败和重新打开均保留轮次关系；旧节点不可覆盖。

## 权限与冻结

- 只有提测单测试负责人可以验证或重新打开。
- 原始报告只在 `WAITING_FOR_REPAIR` 可编辑；首次进入 `REPAIRING` 后永久冻结。
- 生命周期中途发现原始目标错误，不允许通用反馈或编辑；在待验证返修或完成后重新打开处理。
- 已关闭提测单不可验证、返修或重新打开。

## 验收标准

- 所有非 Interaction 的自由输入只出现在验证失败、可选验证说明和重新打开表单。
- 无备注验证通过能从卡片按钮和合法拖拽完成，并创建 PASSED Verification Record。
- 验证失败必须有非空反馈，创建 FAILED Verification Record 和下一轮 Repair Attempt，且 resume 原 Repair Thread。
- 已完成重新打开必须有非空反馈并进入下一轮 Repair。
- 回退文字不会触发平台 Git Action，只作为 Codex Prompt 内容。
- Generic feedback 表、Contract、Action、Projection、UI、测试和旧数据 fallback 全部删除。

## 验证

- Verification Service 测试覆盖无备注通过、带说明通过、失败返修、附件和轮次。
- Reopen 测试覆盖原 Thread、反馈内容、已关闭提测单和权限。
- Schema 测试确认旧 feedback table/field/action 不存在。
- 浏览器验证待验证卡片、详情表单、返修时间线和已完成重新打开。
