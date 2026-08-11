# CAD-003 — 深化 Bug module

**What to build:** 让 Bug module 统一拥有报告规范化、实际/预期结果附件角色、绑定权限、排序、替换、projection 与 Repair context projection；action transport 仅处理文件字节生命周期。

**Blocked by:** CAD-002.

**Status:** blocked

## 验收标准

- Repair 不直接查询 Bug 报告或附件存储表。
- Bug module 输出完整、角色化、已验证的 Repair context。
- 上传失败、领域写入失败与替换后的未绑定文件均被安全清理。
- Bug create/update/workspace 与 Repair prompt 的用户可见行为不变。
- Bug 测试通过领域 interface 断言附件与 Repair context，不依赖存储表形状。

## 验证

- Bug create/update/attachment tests。
- Repair initial/continuation prompt tests。
- 文件清理与权限 tests。

