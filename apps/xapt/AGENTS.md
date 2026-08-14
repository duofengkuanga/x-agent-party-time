# xapt 本机应用规则

- 本目录实现 xapt 公共 CLI、当前用户 daemon、本机状态、安装、更新和卸载。
- 公共命令只允许 `daemon start/connect/stop/status`、`skills update`、`bugs delete`、`update`、`uninstall`、`--help` 和 `--version`；内部入口不得出现在 Help。
- Credential 只经 Keychain Interface 处理，不进入参数、环境变量、JSON、日志、错误或测试快照。
- 本机绝对路径不得发送给 Server，也不得出现在默认 CLI/status 输出；测试必须使用隔离 Home 和 Fake platform adapter。
- daemon 只使用当前用户 LaunchAgent 与私有 Unix socket，不监听 TCP，不依赖进程名称作为单实例真相。
- Release 只生成 macOS arm64 standalone；0.x 必须强制校验 SHA-256，明确未经 Apple 公证，禁止提供 Gatekeeper 绕过。
- 开发期直接迁移到最新 Schema 与路径模型，不读取、迁移、fallback 或双写旧 `~/.agent-party-time/runner/`。
- xapt 不安装、更新、登录或卸载 Codex，也不修改 `~/.codex`。
- xapt 只在 `~/.agents/skills/x-agent-party-time` 管理 Agent Party Time Skill 命名空间；遇到已有非托管路径时不得覆盖或删除。
