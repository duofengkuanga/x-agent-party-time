# CAD-005 — 让 BugBoard interface 成为 browser test surface

**What to build:** 用隔离的 `chrome-use test` suite 覆盖 BugBoard 与 Project settings 的关键可观察行为，删除被真实行为测试取代的源码字符串断言。

**Blocked by:** CAD-004.

**Status:** blocked

## 验收标准

- `test:browser` 使用独立临时 `AGENT_PARTY_TIME_HOME`，创建固定用户与完整 Cooking fixture，启动与停止 Web Server。
- suite 覆盖 Bug 登记、附件、请求修复、拖拽转换、验证失败、重新打开、取消/恢复、归档/撤销、Interaction、错误反馈和 Project route 规范化中的关键路径。
- suite 失败产生截图并返回非零退出码。
- `bun test` 不依赖浏览器。
- 删除主要的 TSX/CSS 源码形状断言，只保留必要的架构与视觉 token 守卫。

## 验证

- `bun run test:browser`。
- `bun test`、typecheck、format、Web build。
- 浏览器默认、焦点、禁用、展开、错误和滚动可达性检查。

