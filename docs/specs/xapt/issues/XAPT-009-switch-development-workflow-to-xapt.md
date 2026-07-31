# XAPT-009 — 将仓库开发流程切换到 xapt

**What to build:** 把 monorepo 的日常开发启动、停止、状态、类型检查和 Web↔Agent 集成反馈回路切换到 `apps/xapt`，使团队不再依赖 `bun packages/runner/src/index.ts start`，同时保留最后一次收口前可定位遗漏的旧包代码。

**Blocked by:** XAPT-003、XAPT-008。

**Status:** blocked

## 用户结果

- `bun run dev` 启动 Web 和 xapt 开发 daemon，并能完成真实 Binding 与 Execution。
- `bun run status` 和 `bun run stop` 正确识别新的开发进程，不依赖旧 Runner 命令正则。
- 开发者不再需要执行 `runner:pair`、`runner:bind` 或 `dev:runner` 完成正常流程。
- Web 测试和生产代码都不导入 xapt 内部实现。

## 实施范围

- 更新开发进程编排、状态和停止脚本，使用 xapt 明确的开发入口或本机控制 Interface。
- 更新根 package scripts、workspace typecheck、test 和 format 范围。
- 将剩余跨应用测试迁到 XAPT-003 Harness，并添加架构边界检查。
- 更新 Seed/开发说明，使浏览器授权、Binding 和 Execution 走正常 xapt 流程。
- 为开发态提供隔离状态根或明确清理命令，避免测试与真实用户 xapt 状态互相污染。
- 保留 `packages/runner` 源码到 XAPT-013，但不再把它作为正常启动入口。

## 非范围

- 不删除旧 Runner 包或脚本定义；删除属于 XAPT-013。
- 不创建 GitHub Release、安装器、update 或 uninstall。
- 不新增绕过 daemon 的前台 Runner 公共入口。
- 不通过进程名称猜测已运行实例。

## 验收标准

- 全新开发环境运行 `bun run dev` 后，Web 与 xapt 都可用并能完成授权、Binding 和 Execution。
- `status`、`stop`、重复启动、异常退出和遗留进程均有确定行为。
- 开发测试使用独立状态根，不读写用户正式 Application Support、Keychain 或 LaunchAgent。
- `rg` 和架构测试确认 `apps/web` 不导入 `apps/xapt` 或 `packages/runner/src`。
- 旧 Runner 入口即使仍在代码树中，也不参与默认开发、测试和类型检查主链路。

## 验证

- 开发进程脚本单测覆盖新进程、重复启动、状态和停止。
- 本地运行 `bun run dev`，完成一次 Web 授权、Binding 和真实 Execution。
- 运行全仓 test、typecheck、format 和 Web production build。
- GitNexus `detect_changes` 只命中开发进程、workspace 配置和跨应用测试装配。
