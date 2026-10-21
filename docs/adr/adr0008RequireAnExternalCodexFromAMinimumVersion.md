---
status: accepted
---

# xapt 依赖最低版本以上的官方 Codex standalone

xapt 不内嵌、不自动安装、不更新也不卸载 Codex，只发现用户已有的官方 standalone，并在 daemon 启动前验证最低版本、登录状态与 App Server initialize。运行时接受所有大于等于最低要求的 Codex，不设置最高版本或精确 allowlist；Wire 解析忽略未知字段和通知，缺少必需方法时让相关 Execution 明确失败，Release CI 同时验证最低支持版本和发版时最新版本。
