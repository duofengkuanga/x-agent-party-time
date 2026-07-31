# XAPT-010 — 交付 GitHub Release 资产与 curl 安装器

**What to build:** 建立 macOS arm64 的可重复 Release 构建和安全安装链路，使用户能通过 curl 安装经过强制 SHA-256 校验的 standalone xapt，并获得稳定版本入口和安全的 zsh PATH 配置。

**Blocked by:** XAPT-001、XAPT-002、XAPT-004。

**Status:** blocked

## 用户结果

- Apple Silicon Mac 用户可以通过公开安装脚本安装 xapt，不需要 Node 或 Bun。
- 安装缺少 checksum、checksum 错误、资产错误或平台不支持时失败关闭，不留下损坏入口。
- 安装器只安装程序，不启动 daemon、不连接 Server、不打开浏览器，也不安装 Codex。
- 0.x 输出明确说明未经 Apple 公证，不绕过 Gatekeeper。

## 实施范围

- 构建 `bun-darwin-arm64` standalone，执行 ad-hoc codesign 和严格验证。
- 生成固定名称的 `xapt-darwin-arm64.tar.gz` 与 `.sha256`。
- 建立 GitHub Release workflow 的测试、类型检查、构建、签名、打包和 checksum 阶段。
- 安装脚本检查 `Darwin/arm64`，解析 GitHub 最新稳定 Release，忽略 Draft 和 Prerelease。
- 使用 macOS `/usr/bin/shasum` 强制校验 64 位十六进制预期值和实际资产。
- 在私有临时目录解压并验证文件名、文件类型、执行权限和版本输出。
- 原子建立版本目录、`current` 和 `~/.local/bin/xapt`，失败时恢复或不创建入口。
- 按 Spec 安全解析 ZDOTDIR、验证真实 `zsh -ic` PATH、原子维护托管区块并在失败时回滚。

## 非范围

- 不使用 Developer ID、Apple 公证或 Gatekeeper 绕过。
- 不自动安装、更新或登录 Codex。
- 不执行 daemon start/connect。
- 不实现自更新或卸载；分别属于 XAPT-011 和 XAPT-012。
- 不支持 Intel Mac、Linux、Windows、自定义安装前缀或持久化 XAPT_HOME。

## 验收标准

- 在没有 Node/Bun 的干净 Apple Silicon 环境中，安装后 `xapt --version` 和 `xapt --help` 可运行。
- `.sha256` 缺失、为空、格式错误或不匹配时，安装器清理临时文件且不切换当前版本。
- 首次安装和重复安装都不会产生半写版本目录或断开的稳定入口。
- `.zshrc` 已含 PATH、使用 ZDOTDIR、文件不存在、只读、软链接、损坏托管标记和验证失败都有覆盖。
- 不满足安全写入条件时程序仍成功安装，只输出手工 PATH 指令。
- 安装和 README 不宣称 Apple 已信任、公证或验证该预览版。

## 验证

- Shell 安装测试覆盖平台、Release 解析、SHA、压缩包、原子切换和 PATH 状态矩阵。
- 使用本地模拟 Release Server，不让普通测试依赖 GitHub 在线状态。
- 在干净 macOS arm64 VM 或机器执行无 Node/Bun 安装验收。
- 验证 `codesign --verify --strict`、资产内容和 checksum。
- GitNexus `detect_changes` 只命中构建、发布、安装和相关文档流程。
