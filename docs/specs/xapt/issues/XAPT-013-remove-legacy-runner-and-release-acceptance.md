# XAPT-013 — 删除旧 Runner 并完成发布验收

**What to build:** 在新 xapt、安装、更新和卸载链路全部可用后执行 contract 收口，删除 `packages/runner` 和所有旧 CLI/开发入口，并在最新 Schema、干净 Apple Silicon 环境和真实 Codex 上完成 xapt 0.x 的全链路发布验收。

**Blocked by:** XAPT-009、XAPT-010、XAPT-011、XAPT-012。

**Status:** blocked

## 用户结果

- 仓库只有一套 Agent 本机实现和一套公开使用方式：安装 xapt、启动 daemon、连接 Server。
- 不再出现旧 Runner 的 `pair`、`bind`、`heartbeat`、前台 start 或源码运行说明。
- 干净 Apple Silicon Mac 可完成安装、连接、真实 Execution、恢复、更新和卸载全闭环。
- 删除旧开发数据后不需要 migration、fallback 或兼容配置。

## 实施范围

- 删除 `packages/runner`、旧 package scripts、旧 bin、旧进程匹配和旧 README 指令。
- 清理 Web、测试、脚本、配置和文档对旧 Runner 内部实现或旧 Home 的引用。
- 确认 `execution-contract` 与 `runner-contract` 是 Web 和 xapt 的唯一共享 Interface。
- 使用最新开发 Schema 和 Seed，不迁移旧 `~/.agent-party-time/runner/` 数据。
- 在最低支持 Codex 版本和发版时最新版本运行 App Server Conformance。
- 在无 Node/Bun 的干净 Apple Silicon 环境执行完整真实验收。
- 更新 README 的安装、预览信任边界、启动、连接、状态、更新、卸载和开发说明。
- 完成全仓质量门、GitNexus 影响复核和 Standards/Spec 双轴评审。

## 非范围

- 不增加旧包 shim、旧 CLI alias、旧 Home 读取或 Schema migration。
- 不扩展 Intel Mac、Linux、Windows、beta channel、Profile 或可配置并发。
- 不升级到 Developer ID 或 Apple 公证。
- 不在收口 Ticket 顺手重构与 xapt 无关的 Cooking、UI 或 Server 模块。

## 真实验收流程

```text
安装官方 Codex standalone 并登录
→ curl 安装 xapt
→ 验证 PATH、Help 和 Version
→ daemon start
→ daemon connect
→ 浏览器授权
→ Web 创建 Binding
→ 真实 Codex Execution
→ 权限和用户输入 Interaction
→ Outcome 与 Outbox 网络恢复
→ stop / start 恢复
→ update 成功
→ update 健康失败并回退
→ uninstall 完整清理
```

## 验收标准

- 仓库不存在用户可达的旧 Runner CLI、旧启动脚本、旧进程识别或旧状态兼容分支。
- `apps/web` 不导入 xapt 内部实现；跨应用测试全部通过 Contract Harness。
- daemon 独占 Credential 和连接状态，本机绝对路径从未进入 Server。
- 固定三槽并发、同 Binding 串行、Interaction、Outbox 和重启恢复通过真实验收。
- 安装和更新缺少或不匹配 SHA 时失败关闭；更新失败恢复旧二进制和可读取状态。
- 卸载删除全部 xapt 自有资源，但 Codex 和 `~/.codex` 保持不变。
- README 明确 0.x 未经 Apple 公证，不包含 Gatekeeper 绕过指令。
- GitNexus 影响范围符合 13 个 Tickets，没有意外扩散到 Runner 领域边界之外。

## 验证

- `bun run test`
- `bun run typecheck`
- `bun run format:check`
- `bun run build:app`
- `bun run check:deps`
- standalone compile、ad-hoc codesign、tar.gz 和 SHA 资产检查。
- 最低 Codex 与发版时最新 Codex Conformance。
- 干净 Apple Silicon Mac 的真实安装到卸载 E2E。
- `rg` 确认旧 Runner 命令、路径和跨应用内部导入已删除。
- GitNexus `detect_changes --scope compare --base-ref main` 只命中预期 xapt、Contract、Server Runner 接口、开发脚本和发布流程。
- Standards 与 Spec 双轴评审无高置信缺失、偏离或 scope creep。

## 完成标准

- xapt 0.x 达到 [`../spec.md`](../spec.md) 的共同完成定义。
- 长期架构决策已提炼到 ADR、CONTEXT、README、测试和代码规则。
- 当前 Spec 与 Tickets 完成使命后从工作树删除，历史由 Git 保留。
