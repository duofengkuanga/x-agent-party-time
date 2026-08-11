# CAD-004 — 深化 action transport 与 Project route state

**What to build:** 为 Interactive mutation 与 Redirect mutation 分别建立 deep transport module，并让 Project settings module 统一解析、生成与规范化 route state。

**Blocked by:** CAD-003.

**Status:** blocked

## 验收标准

- Interactive mutation 统一 auth、public error、上传清理和 workspace refresh，保持 `{ok, result/error}` interface。
- Redirect mutation 统一 auth、FormData、public error、refresh、消息和 replace redirect。
- Project、Engineering、Binding action 不再各自拼接同一 query grammar。
- 无效 Project、Engineering、panel、mode 与权限组合规范化到最近可访问父级。
- 有效 route、成功/失败反馈与现有操作路径不变。

## 验证

- action transport success/error/upload cleanup tests。
- Project route-state parse/format/normalize tests。
- Project/Engineering/Binding application tests。

