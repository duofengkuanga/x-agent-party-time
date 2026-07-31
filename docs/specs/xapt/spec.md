# xapt 0.x 原生 CLI、daemon 与 GitHub Release 规格

状态：已确认，实施 Tickets 已拆分

日期：2026-07-31

## 1. 概要

xapt 是 Agent Party Time 在开发者 Mac 上的本机 CLI 与后台运行程序。它整合当前 `packages/runner` 的授权、Binding、Execution、Lease、Interaction、Outcome、Outbox、Workspace 与 Codex App Server 适配能力，并以包含 Bun Runtime 的 macOS arm64 单文件程序发布。

用户不需要安装 Node 或 Bun，但必须独立安装并登录官方 Codex standalone。xapt 留在当前 monorepo，以独立应用、独立版本和独立 GitHub Release 交付，不拆成独立仓库。

第一版公共 CLI 只包含：

```text
xapt
├── daemon
│   ├── start
│   ├── connect <server-url>
│   ├── stop [--force]
│   └── status
├── update
├── uninstall [--force]
├── --version
└── --help
```

## 2. 要解决的问题

当前 Runner 通过 Bun 直接执行 TypeScript：

```bash
bun packages/runner/src/index.ts start
```

它存在以下产品和交付问题：

- 用户必须拥有仓库源码、Bun、workspace 依赖和正确启动命令。
- CLI、Runner 进程、开发进程管理和安装发布没有统一入口。
- Runner 是前台进程，关闭终端后离线。
- 没有正式的 start、stop、status、update 和 uninstall 语义。
- 没有 GitHub Release、平台资产、强制 checksum、版本回退和自更新链路。
- 当前 Credential 与本机路径状态集中在 `~/.agent-party-time/runner/`，程序、秘密、Cache 和恢复数据没有按生命周期分层。
- Web 集成测试直接导入 Runner 内部实现，尚未以协议 Interface 作为唯一跨应用 Seam。

## 3. 目标

- 用户通过 GitHub curl 安装一个不依赖 Node/Bun 的 xapt 命令。
- xapt 通过当前用户的 macOS LaunchAgent 在后台长期运行。
- 连接、进程管理、状态、更新和卸载具有小而明确的公共 Interface。
- daemon 是 Server Credential 与连接状态的唯一所有者。
- Server 永远不接收、保存或返回本机仓库绝对路径。
- Runner 继续保持领域无关，不承载 Cooking 状态机或 Git 工作流。
- 更新在空闲状态下原子切换版本，失败自动回退。
- 0.x 预览版使用免费 GitHub Release 和强制 SHA-256 本机校验。
- xapt 使用用户独立安装的官方 Codex standalone，并接受大于等于最低版本的 Codex。

## 4. 非目标

第一版不包含：

- Intel Mac、Linux 或 Windows。
- 独立 xapt 仓库。
- Go 或 Rust 重写。
- Node、Bun 或 Codex 自动安装。
- Apple Developer ID、Apple 公证或 Gatekeeper 绕过。
- 多 Server、Profile 或 Server 切换。
- 并发数配置；固定并发为 3。
- `daemon restart`、`daemon logs`、`daemon run` 或 `daemon disconnect`。
- `doctor`、`config`、`profile` 或交互式配置中心。
- beta、RC、nightly、指定版本更新或降级。
- `status --json` 等稳定机器输出 Schema。
- 旧 `~/.agent-party-time/runner/` 数据迁移。
- 旧 Runner CLI 的 `pair`、`heartbeat`、`bind` 或 `bindings` 公共入口。
- xapt 管理、更新、卸载或代理 Codex 登录。

## 5. 统一语言与职责

### 5.1 xapt

安装在用户 Mac 上的 CLI 与后台运行程序。xapt 是工具，不是 Agent 实体。

### 5.2 daemon

xapt 在当前 macOS 用户范围内长期运行的后台进程。`daemon` 是 CLI 的技术命名空间。

### 5.3 Agent

用户和 Server 看到的已连接本机执行节点。daemon 运行并表达 Agent 的在线、心跳、Binding 和执行能力。

### 5.4 Runner

Agent 的内部代码、数据库和协议术语。实现迁入 `apps/xapt` 后仍保留内部 Runner 类型和 `/api/runner/*` 协议，不因用户文案重命名底层领域。

### 5.5 架构职责

```text
Browser / Web
      ↕
Agent Party Time Server
      ↕ Runner + Execution HTTP Contract
xapt daemon
      ↕ stdio JSON-RPC
Codex App Server
```

xapt 只承载通用 Execution，不理解 Project、Engineering、Test Submission、Bug、Repair、Update Batch、Verification 或 Cleanup 的业务语义。

Git、测试、构建、提交、Push、部署和 Cleanup 由 Codex 根据 Server 下发的版本化 Prompt、仓库规则和结构化输出执行。

## 6. 应用与包结构

目标结构：

```text
apps/
├── web/
└── xapt/
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── cli/
        ├── daemon/
        ├── install/
        ├── platform/macos/
        ├── state/
        ├── update/
        └── runner/

packages/
├── execution-contract/
└── runner-contract/
```

规则：

- `packages/runner` 的实现迁入 `apps/xapt`，最终删除旧包，不保留兼容入口。
- `execution-contract` 与 `runner-contract` 继续作为 Web 与 xapt 的共享 Interface。
- Web 生产代码不导入 xapt 实现。
- Web 集成测试不再直接导入 `RunnerWorker`、`RunnerStateStore` 等内部实现。
- 跨应用测试通过 HTTP Contract、协议级 Fake Agent 或 Conformance Harness 完成。
- `apps/xapt/AGENTS.md` 在实施时记录本机秘密、路径、daemon 与发布约束。

## 7. 公共 CLI Interface

### 7.1 通用规则

- 用户文案使用中文，技术必要的命令名保持英文。
- `--help` 输出稳定的命令结构、参数和下一步，不展示内部 Runner CLI。
- `--version` 输出 xapt 版本，并可附带最低 Codex 版本。
- 未知命令或参数退出码为 2。
- Credential、本机绝对路径、完整 Prompt 和附件内容不得进入默认输出。
- 第一版不公开 JSON 输出 Schema。

### 7.2 `xapt daemon start`

职责：

- 验证当前平台为 macOS arm64。
- 发现并验证外部 Codex standalone。
- 生成或更新当前用户 LaunchAgent plist。
- 注册并启动 daemon。
- daemon 未连接 Server 时允许以未连接状态运行，但不自动打开浏览器。
- 已运行时幂等返回当前状态，不重复启动实例。
- daemon 无响应时失败并提示 `xapt daemon stop --force`。

首次启动成功、尚未连接时输出：

```text
xapt daemon 已启动，但尚未连接 Server。
下一步：xapt daemon connect <server-url>
```

### 7.3 `xapt daemon connect <server-url>`

前置条件：daemon 正在运行且可响应。

职责：

- 规范化并验证 HTTPS/HTTP Server URL。
- 通过仅当前用户可访问的本机控制 Interface 请求 daemon 发起授权。
- daemon 生成 verifier、短指纹与授权请求。
- daemon 打开系统浏览器；失败时返回可复制的 URL。
- CLI 等待 daemon 返回授权成功、拒绝、过期或失败结果。
- 授权成功后 daemon 保存连接配置与 Keychain Credential，并开始心跳和领取任务。

规则：

- daemon 未运行时明确失败，不隐式启动。
- 第一版一份 xapt 安装只连接一个 Server。
- 已健康连接同一 Server 时幂等返回成功。
- 同一 Server 的 Credential 失效或撤销时允许重新授权。
- 已连接不同 Server 时拒绝，不提供切换、Profile 或隐式清理。
- 连接流程属于 daemon 忙碌状态，会阻止 stop、update 和 uninstall。

### 7.4 `xapt daemon status`

显示完整 daemon 健康状态，不只检查 PID：

```text
Daemon        正在运行
版本          0.1.0
Codex         0.145.0
连接          已连接
Server        https://apt.example.com
Agent         徐捷泉的 MacBook
最近心跳      8 秒前
执行槽位      1 / 3 使用中
等待交互      0
待发送结果    0
Binding       3 个
```

不展示：

- Credential。
- 本机仓库绝对路径。
- 完整内部 ID。
- Project、Bug、Prompt 或附件内容。

退出码：

```text
0  daemon 正在运行且健康
1  daemon 停止、未连接、连接异常、依赖异常或无响应
2  命令或参数错误
```

健康维度分开表达：

```text
Service：STOPPED | RUNNING | UNRESPONSIVE
Connection：UNCONFIGURED | CONNECTING | CONNECTED | DEGRADED | REVOKED
Activity：IDLE | BUSY
```

活动详情包含执行槽位、等待 Interaction、Binding 工作和 Outbox 数量，不把所有状态压成单个枚举。

### 7.5 `xapt daemon stop [--force]`

普通 stop：

- daemon 已停止时幂等成功。
- daemon 空闲且可响应时停止领取新任务、刷新状态、退出并注销 LaunchAgent。
- 保留 Credential、连接配置、Binding、Outbox、Execution 与 Workspace 恢复状态。
- daemon 忙碌或无响应时拒绝。

`--force`：

- 只作为显式紧急出口。
- 必须通过真实 TTY 展示后果并要求确认。
- 先尽力停止领取、持久化 Outbox 与恢复状态，再在超时后强制终止。
- 不删除本机状态。
- 第一版不提供无交互强制停止。

### 7.6 `xapt update`

- 只检查 GitHub 最新稳定 Release。
- 忽略 Draft、Prerelease、beta、RC 与 nightly。
- 不接受版本参数，不支持降级或 `--force`。
- 当前版本已经最新时不修改文件、不重启 daemon。
- 本地版本高于最新稳定版时不自动降级。
- 新 xapt 的最低 Codex 版本高于本机 Codex 时拒绝切换并保留当前版本。
- daemon 忙碌时拒绝，不等待、不取消任务。
- daemon 停止时更新后保持停止。
- daemon 运行且空闲时安全停止、切换版本、启动新 daemon 并执行健康检查。
- 新版本失败时回退上一个成功版本，并恢复更新前的运行或停止状态。

忙碌包括：

```text
连接授权
Binding 操作
活动 Execution
等待 Interaction
Cleanup
另一个 update
```

Outbox 非空本身不阻止更新，但更新不得丢失或破坏 Outbox。

### 7.7 `xapt uninstall [--force]`

默认完整卸载：

- 展示将删除的程序、版本、LaunchAgent、Credential、连接、Binding、恢复状态、Cache 与日志。
- daemon 忙碌时拒绝。
- Outbox 非空、存在未收敛 Execution 或遗留 Workspace 时拒绝，避免正常卸载吞掉尚未交付的结果。
- 请求 Server 撤销 Agent Credential；Server 保留已撤销 Agent 的历史记录。
- 安全停止并注销 LaunchAgent。
- 删除 Keychain Credential、Application Support、Caches、Logs、版本目录与稳定命令入口。
- 删除后不影响用户独立安装的 Codex 或 `~/.codex`。

`--force`：

- 必须通过真实 TTY 确认。
- 明确警告活动任务、Outbox 和 Workspace 可能丢失或需要等待 Server Lease 恢复。
- Server 不可达时允许确认后完成本机删除，并提示稍后在 Web 撤销 Agent。
- 第一版不提供 `--keep-data`。

## 8. daemon 与本机控制 Interface

### 8.1 LaunchAgent

- 使用当前用户的 `~/Library/LaunchAgents/com.agentpartytime.xapt.daemon.plist`。
- 不需要 sudo 或系统级 daemon。
- ProgramArguments 使用展开后的绝对稳定入口，不写 `~`。
- LaunchAgent 执行隐藏的内部入口，例如 `xapt internal-daemon`，不得递归执行公共 `daemon start`。
- 正常启动后关闭终端或重新登录仍持续运行。
- 异常退出可由 launchd 受控拉起，必须避免快速崩溃循环。

### 8.2 本机控制

CLI 与 daemon 使用当前用户私有的本机控制 Interface：

```text
~/Library/Application Support/com.agentpartytime.xapt/run/control.sock
```

要求：

- 父目录权限 0700，Socket 只允许当前用户。
- 不监听 TCP，不向局域网或互联网开放。
- daemon 是连接配置、Credential、心跳和执行状态的唯一写入者。
- CLI 只提交 start 之外的控制请求并渲染结果。
- daemon 启动时清理安全可识别的遗留 Socket；不删除未知文件。

### 8.3 单实例

- 同一用户只能有一个 daemon 操作同一状态根。
- 后台实例存在时不允许再启动前台 Runner。
- daemon 使用 LaunchAgent 状态和本机控制握手确认唯一实例，不依赖不可靠的名称匹配。

## 9. 外部 Codex 依赖

### 9.1 发现

查找顺序：

```text
1. PATH 中的 codex
2. ~/.local/bin/codex
```

不依赖 ChatGPT App 内部资源路径。

### 9.2 所有权

- xapt 不内嵌 Codex。
- xapt 安装器不自动执行 Codex 安装脚本。
- xapt 不管理 Codex 登录、更新、卸载或 `~/.codex`。
- Codex 缺失时提供官方 standalone 安装指令。
- Codex 未登录时提供 `codex login` 指令。

### 9.3 兼容性

每个 xapt Release 声明：

```text
minimumCodexVersion
```

运行时：

- Codex 版本低于最低要求时拒绝 daemon 启动。
- 大于等于最低版本时不因“未列入 allowlist”拒绝。
- daemon 启动时必须完成 App Server `initialize` 预检。
- Wire Schema 允许未知字段，未知通知安全忽略。
- 缺少必需方法或必需字段时让相关 Execution 返回明确的 Codex 兼容失败，不让 daemon 整体崩溃。

Release CI 验证：

```text
最低支持 Codex 版本
发版时最新 Codex 版本
```

覆盖 initialize、thread/start、turn/start、Interaction、interrupt、结构化输出与 Session 继续。

## 10. 并发与任务领取

- 第一版固定并发数为 3。
- 不写入用户配置，不提供 CLI 参数或环境变量修改。
- daemon 根据实时占用向 Server 报告 `availableSlots`。
- 同一 Binding 保持单活动 Execution。
- 不同 Binding 共享最多 3 个执行槽。
- 等待 Interaction 是否释放槽位遵守当前 Execution Contract 与 Cooking 生命周期规格。
- status 显示 `已用 / 3`，不暴露内部 SlotPool 实现。

## 11. 本机路径与数据布局

### 11.1 稳定入口与版本目录

```text
~/.local/bin/xapt
  → ~/.local/share/xapt/current/xapt

~/.local/share/xapt/
├── current -> versions/<current-version>
├── versions/
│   ├── <previous-version>/xapt
│   └── <current-version>/xapt
└── install.json
```

只保留当前成功版本和上一个成功版本。

`install.json` 至少包含：

```json
{
  "schemaVersion": 1,
  "currentVersion": "0.2.0",
  "previousVersion": "0.1.0",
  "installedAt": "...",
  "updatedAt": "..."
}
```

### 11.2 Application Support

```text
~/Library/Application Support/com.agentpartytime.xapt/
├── connection.json
├── bindings.json
├── run/
│   └── control.sock
└── state/
    ├── outbox/
    ├── executions/
    └── workspaces/
```

`connection.json`：

```json
{
  "schemaVersion": 1,
  "serverUrl": "https://apt.example.com",
  "runnerId": "..."
}
```

不包含 Credential。

`bindings.json` 保存：

```text
bindingId → repositoryPath + updatedAt
```

Server 永远不读取该文件或绝对路径。

### 11.3 Keychain

- Server Credential 保存到 macOS Keychain。
- Keychain Service 使用稳定 identifier，例如 `com.agentpartytime.xapt`。
- Account 由规范化 Server Origin 与 Runner ID 唯一确定。
- daemon 是唯一读写者。
- Credential 不进入 JSON、日志、CLI 参数、环境变量或错误信息。

### 11.4 Caches 与 Logs

```text
~/Library/Caches/com.agentpartytime.xapt/
├── updates/
├── attachments/
└── executions/

~/Library/Logs/com.agentpartytime.xapt/
├── daemon.log
└── daemon-error.log
```

- Cache 可被完整删除而不破坏正确性。
- Outbox、Binding 和恢复状态不得放入 Cache。
- 日志轮转并限制保留量。
- 日志不包含 Credential、完整 Prompt、附件内容或本机仓库绝对路径。

### 11.5 权限

```text
~/.local/bin/xapt                                  软链接
真实 xapt 二进制                                  0755
Application Support 根与状态目录                  0700
connection.json / bindings.json / outbox files    0600
Caches / Logs                                     0700
LaunchAgent plist                                 0644
control.sock                                      0600
```

创建后主动校验并收紧权限，不依赖默认 umask。

### 11.6 旧状态

开发期不迁移：

```text
~/.agent-party-time/runner/
```

实现切换前可由开发者手工删除或保留，xapt 不读取、不双写、不提供兼容 Adapter。

## 12. 安装脚本

### 12.1 入口

```bash
curl -fsSL https://raw.githubusercontent.com/duofengkuanga/x-agent-party-time/main/install.sh | sh
```

安装脚本只安装 xapt，不注册 LaunchAgent、不启动 daemon、不打开浏览器、不连接 Server，也不安装 Codex。

### 12.2 平台检查

必须满足：

```text
uname -s = Darwin
uname -m = arm64
```

其他平台明确失败并说明 0.x 只支持 Apple Silicon Mac。

### 12.3 Release 解析

- 使用 GitHub `releases/latest` 重定向解析最新稳定 Tag。
- 资产名固定为：

```text
xapt-darwin-arm64.tar.gz
xapt-darwin-arm64.tar.gz.sha256
```

- Draft 与 Prerelease 不作为 latest stable。

### 12.4 强制 SHA-256

安装器必须使用：

```text
/usr/bin/shasum
```

校验顺序：

```text
下载压缩包到私有临时目录
→ 下载同 Tag 的 .sha256
→ 校验预期值为 64 位十六进制
→ /usr/bin/shasum -a 256 计算实际值
→ 常量时间要求不适用，但必须完整相等
→ 通过后才允许解压
```

以下任何情况都失败并清理临时文件：

```text
.sha256 缺失
/usr/bin/shasum 缺失
SHA 文件为空或格式错误
实际值不匹配
压缩包内容或文件名错误
```

### 12.5 安装切换

- 解压后验证文件类型、执行权限、版本输出和 ad-hoc 签名结构。
- 写入新的版本目录，不直接覆盖当前版本。
- 首次安装原子建立 `current` 与 `~/.local/bin/xapt` 稳定入口。
- 安装失败不得留下指向不完整版本的入口。

### 12.6 zsh PATH

第一版只自动维护 zsh 的实际 `.zshrc`。

安全条件：

- 登录 Shell 是 zsh。
- 能解析实际 `ZDOTDIR`。
- 新交互式 zsh 的最终 PATH 不包含 `~/.local/bin`。
- 目标文件不存在，或是当前用户拥有的普通可写文件。
- 目标不是软链接或受管理只读文件。
- 不存在损坏的 xapt 托管标记。

写入区块：

```bash
# >>> xapt PATH >>>
case ":${PATH:-}:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin${PATH:+:$PATH}" ;;
esac
# <<< xapt PATH <<<
```

要求：

- 安装前使用真实 `zsh -ic` 检查最终 PATH，不做简单 grep 判断。
- 写入使用同目录临时文件和原子 rename，保留原权限。
- 写入后再次用新的交互式 zsh 验证；失败时恢复。
- 不满足安全条件时安装仍成功，只打印手工 PATH 指令。
- 不引入持久化 `XAPT_PATH`、`XAPT_HOME` 或 `XAPT_PREFIX`。
- uninstall 不自动删除通用 `~/.local/bin` PATH 配置。

## 13. GitHub Release 与 0.x 信任模型

### 13.1 构建

```bash
bun build \
  --compile \
  --target=bun-darwin-arm64 \
  apps/xapt/src/index.ts \
  --outfile dist/xapt
```

Release Workflow：

```text
测试与类型检查
→ Bun standalone compile
→ ad-hoc codesign
→ codesign --verify --strict
→ tar.gz
→ SHA-256
→ GitHub Release
```

### 13.2 免费预览边界

0.x：

- 不使用 Apple Developer Program。
- 不使用 Developer ID。
- 不提交 Apple 公证。
- 不宣称已获 Apple 信任。
- 不执行 `xattr -d com.apple.quarantine`、关闭 Gatekeeper 或其他绕过。
- README 和安装输出明确标注为未经 Apple 公证的开发预览版。

正式外部稳定版是否升级 Developer ID 与公证，在 0.x 验证完成后另行决定。

### 13.3 Release 资产

每个稳定 Tag 至少包含：

```text
xapt-darwin-arm64.tar.gz
xapt-darwin-arm64.tar.gz.sha256
```

Release 缺少任一资产时安装和更新都失败。

## 14. 更新与本机 Schema 安全

版本回退只有在本机状态仍可读取时才有效。

规则：

- 新版本在切换前只读验证现有状态，不做不可逆修改。
- 需要本机 Schema 变化时，先创建受权限保护的状态快照或使用 copy-on-write 迁移。
- 新 daemon 健康检查成功后才提交迁移并清理不再需要的快照。
- 回退时恢复上一个版本可读取的状态。
- Outbox 的读取格式至少保证当前版本与上一个成功版本兼容。
- 不允许“二进制已回退但本机状态已不可逆升级”的中间状态。

健康检查只要求：

```text
新二进制可执行
本机状态可读取
LaunchAgent 可启动
控制 Interface 可响应
Codex initialize 预检通过
```

不要求 Server 当前在线，避免网络故障导致错误回退。

## 15. Server 与 Contract 变化

需要新增或调整：

- Agent 自撤销 Credential 的受权接口，用于 uninstall。
- daemon status 所需的本机状态来自本机控制 Interface，不新增向 Server 泄露本机路径的接口。
- Runner HTTP Contract 继续使用明确 Schema 和 Bearer Credential。
- Server 仍只保存 Credential Hash。
- Connection、Heartbeat、Binding、Execution 与 Outcome 行为保持出站请求模型，不开放 Server 到开发机的入站连接。

## 16. 错误与恢复原则

- CLI 错误说明当前状态、未完成的副作用和一个最合理的下一步。
- 安装、更新和卸载使用失败关闭，不在关键校验缺失时继续。
- Promise、子进程、文件写入和网络请求都有明确超时与错误处理。
- 配置和状态写入使用临时文件、fsync/rename 或等价原子手段。
- daemon 崩溃后优先重放 Outbox、恢复可恢复状态，再领取新工作。
- 强制停止和强制卸载不伪装成安全完成，必须报告可能遗留的 Server Lease、Workspace 和远程撤销状态。

## 17. 测试策略

### 17.1 CLI

覆盖：

- 命令解析、Help、Version 和退出码。
- start、connect、stop、status、update、uninstall 的状态矩阵。
- 忙碌、无响应、重复调用与 TTY 确认。
- 用户输出不泄露 Credential 或本机路径。

### 17.2 daemon

覆盖：

- LaunchAgent plist 生成与幂等注册。
- 单实例和控制 Socket 权限。
- 未连接、连接中、已连接、降级和撤销状态。
- 固定 3 个执行槽与同 Binding 串行。
- Outbox 重放、重启恢复和强制终止恢复。

### 17.3 Codex Conformance

对最低版本和发版时最新版本执行：

- `codex --version`。
- App Server initialize。
- thread/start 与 turn/start。
- 结构化结果。
- 权限与用户输入 Interaction。
- interrupt。
- Session 继续。
- 子进程退出与错误恢复。

### 17.4 安装与更新

覆盖：

- 平台与架构拒绝。
- 最新稳定 Tag 解析。
- SHA 成功、缺失、格式错误和不匹配。
- 压缩包错误、版本目录切换和软链接原子性。
- `.zshrc` 已包含 PATH、ZDOTDIR、软链接、只读、损坏标记和验证回滚。
- daemon 停止、空闲、忙碌和无响应时更新。
- 新版本健康失败后的二进制与状态回退。

### 17.5 卸载

覆盖：

- 正常完整卸载。
- 忙碌拒绝。
- Outbox、未收敛 Execution 与遗留 Workspace 拒绝。
- force 确认。
- Server 在线撤销与离线警告。
- Keychain、Binding、Outbox、Cache、日志、版本和入口清理。
- Codex 与 `~/.codex` 保持不变。

### 17.6 真实验收

在一台未安装 Node/Bun 的干净 Apple Silicon Mac 上验证：

```text
安装官方 Codex standalone 并登录
→ curl 安装 xapt
→ PATH 设置
→ daemon start
→ daemon connect
→ Web 授权
→ Web 驱动 Binding
→ 真实 Codex Execution
→ Interaction
→ Outcome / Outbox
→ stop / start 恢复
→ update 成功与失败回退
→ uninstall 完整清理
```

## 18. 迁移实施原则

建议使用 expand → migrate → contract：

### Expand

- 建立 `apps/xapt`、CLI、platform Adapter、state Adapter 和构建脚本。
- 复用现有 Runner 实现并保持旧开发入口可用于短期反馈。
- 建立协议级 Conformance Harness，替代 Web 测试对 Runner 内部实现的直接导入。

### Migrate

- 将授权、Binding Worker、Runner Worker、Codex App Server、Outbox、附件和 Workspace 迁入 `apps/xapt`。
- 将本机路径、Credential、LaunchAgent、CLI 和 update/uninstall 接入新 Adapter。
- 将 `bun run dev` 调整为使用 xapt 开发 daemon 入口。
- 完成 GitHub Release 和真实安装反馈回路。

### Contract

- 删除 `packages/runner`、旧 CLI 命令和旧进程匹配规则。
- 删除旧 `runner:pair`、`runner:bind`、`runner` 等 package scripts。
- README 只描述 xapt 与 Web 正常流程。
- 删除 Web 测试中的 Runner 内部实现导入。
- 不保留旧 Home、旧 CLI 或旧包兼容入口。

## 19. 共同完成定义

xapt 0.x 完成必须同时满足：

- 公共 CLI 仅包含本 Spec 确认的命令。
- 用户机器不需要 Node 或 Bun。
- daemon 在 LaunchAgent 中稳定运行、停止和恢复。
- daemon 独占 Credential 和连接状态。
- 本机绝对路径只存在于 xapt 本机状态。
- 外部 Codex 缺失、未登录、过旧或 App Server 不兼容时有明确诊断。
- 安装与更新强制 SHA-256 校验。
- 忙碌时 stop、update、uninstall 符合安全策略。
- 更新失败自动恢复上一成功版本和可读取状态。
- 卸载完整清理 xapt，但不影响 Codex。
- 0.x 不绕过 Gatekeeper，也不冒充已公证正式版。
- 相关单元、协议、Conformance、安装、更新、卸载和真实干净机 E2E 通过。
- 全仓测试、类型检查、格式检查和 Production Build 通过。
- GitNexus impact 与 detect_changes 显示影响范围符合实施 Tickets。
- Standards 与 Spec 双轴评审无高置信缺失、偏离或 scope creep。

## 20. 实施 Tickets

正式实施队列见 [`issues/README.md`](issues/README.md)。13 个 Ticket 按 expand → migrate → contract 排列；blocking edges 以该索引和各 Ticket 的 `Blocked by` 为准。
