# XAPT-001 — 建立 xapt 应用、公共 CLI 与 standalone 产物

**What to build:** 在 monorepo 内创建独立版本的 `apps/xapt` 应用，交付第一版公共命令树、稳定 Help/Version/退出码和隐藏 daemon 进程入口，并证明它可被 Bun 编译成不依赖用户预装 Node 或 Bun 的 macOS arm64 单文件程序。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## 用户结果

- `xapt --help` 只展示 Spec 确认的公共命令，不暴露旧 Runner 的 `pair`、`bind`、`heartbeat` 或内部调试入口。
- `xapt --version` 输出独立的 xapt 版本，并能携带最低 Codex 版本元数据。
- 未知命令、未知参数和缺少必需参数使用退出码 2，并给出一个明确的下一步。
- 同一 TypeScript 入口可以生成 `bun-darwin-arm64` standalone 可执行文件。

## 实施范围

- 创建 `apps/xapt/package.json`、`tsconfig.json`、源码入口和局部 `AGENTS.md`。
- 建立 CLI Parser、命令描述、中文输出 Renderer 和稳定退出码约定。
- 公共命令树固定为 `daemon start/connect/stop/status`、`update`、`uninstall`、`--help`、`--version`。
- 建立仅供 LaunchAgent 使用的隐藏 `internal-daemon` 入口；它不得出现在公共 Help 中。
- 未实现的公共命令必须明确失败，不得转发到旧 Runner CLI 或伪装成功。
- 建立 xapt 独立版本常量、最低 Codex 版本声明和 standalone build script。
- 调整 workspace 配置、根类型检查或格式检查，使新应用进入常规质量门。

## 非范围

- 不实现 LaunchAgent、control socket、连接、执行、更新或卸载行为。
- 不迁移 `packages/runner` 实现，也不删除旧开发入口。
- 不创建 GitHub Release、安装脚本、签名或 checksum。
- 不引入公开 JSON 输出 Schema。

## 验收标准

- 从源码运行和 standalone 运行时，Help、Version、参数错误和退出码一致。
- Help 中不存在未确认命令、旧 Runner 命令或隐藏内部入口。
- standalone 文件由 `file` 识别为 Apple Silicon macOS 可执行文件，并能在没有 workspace 模块解析的目录执行 `--help` 和 `--version`。
- CLI 默认输出不包含 Credential、本机绝对路径、Prompt、附件内容或内部完整 ID。
- `apps/xapt/AGENTS.md` 明确秘密、路径、daemon、发布和非兼容迁移约束。
- 不改变当前 Web 与旧 Runner 的运行行为。

## 验证

- CLI 单测覆盖所有顶层命令、缺参、未知参数和退出码。
- 运行 xapt 定向测试与类型检查。
- 执行 standalone compile，并在仓库外目录运行产物的 `--help`、`--version` 和错误命令。
- 运行全仓格式检查中与新增应用相关的范围。
- GitNexus `detect_changes` 只命中新应用、workspace 配置和质量门入口。
