# Agent Party Time

Agent Party Time 是一个 local-first 常驻服务：它在本机协调频道、任务、Codex Thread 和工程级 Runner，并提供一个多用户协作提测工作台。本文档是项目当前说明入口。

## 协作提测工作台

Web 的 `/cooking` 页面已经切换到新的协作提测领域模型，不再暴露旧“修复收集 / 六列看板 / 部署批次”的可写入口。

当前模型是：

```text
私密项目
  -> 前端/后端工程
  -> 工程成员、测试环境、部署配置
  -> 开发人员本机 Runner binding
  -> 多工程提测单
  -> Bug 六列看板
  -> repair / update / cleanup task
```

六列看板为：

```text
待修复 -> 修复中 -> 待更新 -> 更新中 -> 待验证 -> 已完成
                         └-> 已取消（垃圾桶终态，不占主看板列）
```

主要能力：

- 私密项目、OWNER / DEVELOPER 成员与邀请；
- 工程目录、工程成员、测试环境以及 `LOCAL_SCRIPT` / `CI_CD` 部署配置；
- “工程 × 开发人员 × Runner”binding，中心端不保存本机绝对仓库路径；
- 一张提测单包含一个或多个工程，并由唯一 TESTER 负责；
- “工程 × 环境”占用，关闭提测单后释放；
- Bug 创建、附件、暂不确定工程分诊和六状态状态机；
- binding 级 repair queue、排序、撤回、立即修复、租约和离线恢复；
- 修复失败后在原 Codex Thread 中继续，不创建替代 Thread 或迁移摘要；
- 同一 Bug 可按正常人工开发方式连续产生候选提交；更新时冻结该 Bug 本轮完整待更新提交链，不自动 squash；
- 候选提交按最新候选时间静默 2 分钟后冻结为 update Batch，或由负责开发人员立即更新；
- 待更新 Bug 可由负责开发人员补充意见并沿用原 Thread/worktree 继续修复；待修复或待更新 Bug 可按权限取消并移入不可恢复的垃圾桶；
- 更新中只允许批次级取消，取消成功后整批 Bug 返回待更新；
- `LOCAL_SCRIPT` 自动更新，以及 `CI_CD` 外部失败反馈和人工确认；
- TESTER 验证失败、DONE 重开、关闭提测单和幂等 cleanup；
- Codex 原生权限/用户输入交互、finish outbox 持久化与 Runner 重启重放。

Runner 只负责领取任务、通过一个长生命周期 `codex app-server` 管理 Codex Thread/Turn、保存本机 artifacts 和回传结构化结果。**Runner 不直接执行 Git、worktree、测试、构建、提交、Push、部署或 cleanup 命令**；这些仓库内动作由 Codex 根据版本化 Prompt 和仓库规则完成。

根路径 `/` 仍是频道控制台，频道、task、team、session 和 reply outbox 等原有能力保持独立。

## 演示账号

登录页提供三组硬编码开发演示账号：

| 姓名   | 用户名       | 密码     | 全局类型    |
| ------ | ------------ | -------- | ----------- |
| 徐捷泉 | `xujiequan`  | `123456` | `DEVELOPER` |
| 周明波 | `zhoumingbo` | `123456` | `DEVELOPER` |
| 田国会 | `tianguohui` | `123456` | `TESTER`    |

这些凭据只用于本机开发演示，**禁止用于生产环境**。当前不提供注册、改密、找回密码或正式用户管理。

## 一键启动

安装依赖后，在仓库根目录运行：

```bash
# 同时启动 Control Plane、Runner 和 Web
bun run dev

# 查看三个开发服务是否正在运行
bun run status

# 停止当前仓库中单独或统一启动的全部开发服务
bun run stop
```

`bun run dev` 会前台管理三个独立进程，并在收到 `SIGINT` / `SIGTERM` 或任一进程退出时停止其余进程。`bun run stop` 还会清理通过 `dev:control-plane`、`dev:runner`、`dev:web` 单独启动后遗留的进程，并通过进程工作目录避免影响其他仓库：

- Control Plane：默认 `http://127.0.0.1:43121`
- Runner 本地 API：默认 `http://127.0.0.1:43120`
- Web：默认 `http://localhost:3000`

浏览器打开：

```text
http://localhost:3000/cooking
```

需要单独调试时：

```bash
bun run dev:control-plane
bun run dev:runner
bun run dev:web
```

三个进程默认只绑定本机回环地址。系统不会自动执行 `fetch`、`pull`、`rebase`、force push 或生产部署。

## 协作提测流程

1. DEVELOPER 登录并创建私密项目，邀请其他已注册开发账号。
2. 项目成员创建前端或后端工程，配置工程成员、测试环境和 `LOCAL_SCRIPT` / `CI_CD` 部署方式。
3. 工程成员在自己的机器上将工程绑定到 Runner；绝对仓库路径只保存在该 Runner 本机。
4. DEVELOPER 创建包含一个或多个工程的提测单，为每项选择负责人、binding、分支、环境和部署配置，并指定唯一 TESTER。
5. TESTER 创建 Bug，可选择一个工程或暂不确定；开发人员完成分诊后，Bug 才能进入修复队列。
6. repair task 由对应 binding 的 Codex Thread 处理。同一 binding 的运行 Turn 串行，不同 binding 可在并发上限内并行；等待权限或用户输入时释放普通执行槽。
7. 修复成功后 Bug 进入待更新。负责开发人员可补充意见继续修复并追加正常 Git 提交；系统以最新候选时间为起点静默 2 分钟后冻结每个 Bug 的完整待更新提交链，也可以由负责开发人员立即更新。
8. `LOCAL_SCRIPT` 由更新 Codex Thread 按工程或用户工作流统一完成整批集成、验证、单次普通 Push 和部署；`CI_CD` 在 Push 后等待开发人员反馈外部部署结果。
9. TESTER 验证通过后 Bug 进入已完成；验证失败或重开时携带反馈恢复原 repair 上下文。待修复 Bug 可由指定测试人员或负责开发人员取消，待更新 Bug 仅负责开发人员可取消；已取消 Bug 进入垃圾桶且不阻止提测单关闭。
10. 全部 Bug 已完成或已取消且无活动任务后，TESTER 关闭提测单，环境释放，并为各 binding 创建 cleanup task。

TESTER 的服务端查询结果和页面不展示仓库、Runner、本机路径、分支命令、Commit、Codex Thread 或 CI/CD 技术错误。

## 环境变量

| 变量                                  | 用途                                         | 默认值                   |
| ------------------------------------- | -------------------------------------------- | ------------------------ |
| `AGENT_PARTY_TIME_HOME`               | Control Plane 与 Runner 的本地数据根目录     | `~/.agent-party-time`    |
| `AGENT_PARTY_TIME_CONTROL_PLANE_URL`  | Web、Runner 和 CLI 访问 Control Plane 的地址 | `http://127.0.0.1:43121` |
| `AGENT_PARTY_TIME_CONTROL_PLANE_HOST` | Control Plane 监听地址，仅允许回环地址       | `127.0.0.1`              |
| `AGENT_PARTY_TIME_CONTROL_PLANE_PORT` | Control Plane 监听端口                       | `43121`                  |
| `AGENT_PARTY_TIME_RUNNER_NAME`        | Runner 在 Control Plane 中显示的名称         | 当前主机名派生值         |
| `AGENT_PARTY_TIME_CODEX_EXECUTABLE`   | Runner 使用的 Codex 可执行文件               | `codex`                  |
| `AGENT_PARTY_TIME_SERVER`             | 通用 `xapt` CLI 访问 Runner 本地 API 的地址  | capability 文件中的地址  |
| `AGENT_PARTY_TIME_CAPABILITY_FILE`    | 通用 CLI 使用的本地 capability 文件          | `service/capability`     |

Runner 本地 API 的 host / port 通过 `service/config.json` 的 `settings.localApiHost`、`settings.localApiPort`，或 `xapt start --host <host> --port <port>` 配置。Codex 可执行文件也可用 `--codex-executable <path>` 覆盖。

## 开发阶段数据策略

当前仍处于开发阶段，协作提测直接使用新 schema：

- 不迁移旧缺陷修复数据库或历史数据；
- 不保留旧状态机的只读兼容层；
- 不兼容进行中的旧 Codex 进程；
- 需要切换 schema 时显式重置本机开发数据。

重置步骤：

1. 停止 Web、Control Plane 和 Runner。
2. 删除 `~/.agent-party-time/control-plane/state.sqlite`。
3. 如果存在，同时删除 `state.sqlite-wal` 和 `state.sqlite-shm`。
4. 删除 `~/.agent-party-time/control-plane/attachments/` 中的开发附件。
5. 如需清除工程 binding、collaborative Thread 映射和 finish outbox，删除或重置 `~/.agent-party-time/service/runner.json`。
6. 重启服务，进程会按当前代码建立新状态。

使用自定义 `AGENT_PARTY_TIME_HOME` 时，将上述路径替换为对应目录。此操作会永久删除本机开发数据，执行前应确认服务已经停止且目录中没有需要保留的材料。

## 本地数据

默认数据目录为 `~/.agent-party-time/`：

```text
control-plane/config.json       Control Plane 本地配置
control-plane/state.sqlite      私密项目、工程、提测单、Bug、任务、租约与审计状态
control-plane/attachments/      Bug、验证反馈和 CI/CD 外部失败附件
service/config.json             agent、subscription 与 Runner API 设置
service/state.sqlite            cursor、session、job、run、task、team 与 reply outbox
service/service.lock            当前 Runner 实例所有权
service/capability              loopback API 本地凭据
service/runner.json             Runner 身份、工程 binding、collaborative Thread 映射与 finish outbox
service/logs/                   通用 JSONL 诊断日志
service/repair-attempts/        repair、update、cleanup 的本地 Codex artifacts 与结构化结果
```

中心端只保存 binding 标识和非敏感协作状态。本机绝对仓库路径、原始 Codex artifacts 与完整执行证据不通过 TESTER API 返回。

## 通用服务管理

常用命令：

```text
xapt start|stop|status
xapt agent list|show|add|update|enable|disable
xapt engineering bind|list
xapt channel list|show|add|update|enable|disable|remove
xapt run list|show|cancel|retry
xapt session list|show|invalidate
xapt task list|show|create|from|assign|claim|status|complete|review
xapt logs [--follow]
```

全局参数可以放在命令前后：

```text
--server <url> --home <path> --timeout <ms> --json
```

## 目录结构

```text
packages/shared/               公共 schema、事件、配置与 contracts
packages/control-plane-client/ Control Plane 的 HTTP 与内存 adapter
packages/local-service/        本地常驻服务、Runner 状态与 collaborative Worker
packages/cli/                  xapt 命令行客户端
apps/web/                      Next.js 登录页、频道控制台与协作提测工作台
services/control-plane/        权威 SQLite 状态机与 HTTP 进程
services/realtime-worker/      Cloudflare adapter seam
scripts/dev-all.ts             三进程本地开发 supervisor
```

## 环境要求

- Bun 1.3.14 或兼容版本；
- 本机已安装并登录 Codex CLI，且可运行 `codex app-server`；
- 真实验收时使用受控本地 Git 仓库和测试远端；
- `LOCAL_SCRIPT` / CI/CD 验收流程不得产生生产副作用；
- 服务 API 只绑定 loopback 地址。

## 安装与质量检查

```bash
bun install
bun run format:check
bun run typecheck
bun test
bun run check:deps
bun run build:web
```

根 `format:check` 不覆盖全部 Markdown、TSX 和 CSS；修改这些文件时还需要执行针对性 Prettier 检查。

当前已经完成 collaborative Control Plane / Worker 自动化测试、全仓类型检查、Web production build、Developer / Tester 单浏览器页面冒烟，以及真实 Codex App Server、多受控仓库、两个隔离 Runner、`LOCAL_SCRIPT` 与 CI/CD 的完整多人端到端验收。最新报告见 `.scratch/collaborative-test-submission/acceptance/last-real-e2e-report.json`，详细清单见 `.scratch/collaborative-test-submission/issues/CTS-012-migration-and-real-multi-user-acceptance.md`。

## 设计边界

- `shared` 只定义公共规则，不执行文件、网络或数据库副作用；
- Control Plane 是项目、工程、提测单、Bug、任务、租约和审计历史的权威事实源；
- Runner 是本机仓库路径、Codex Thread 映射、finish outbox 和原始 artifacts 的事实源；
- CLI 和 Web 通过本地 HTTP API 管理服务，不直接修改 SQLite；
- actor 由服务端 Session 注入，客户端协作命令不能伪造 actor；
- repair、update、cleanup 通过 claim / renew / finish 协议执行并保持幂等；
- Update Batch 只在静默期满足或立即更新时冻结；冻结后候选集合不可变，新候选留待下一批；
- Codex 权限和用户输入沿用 App Server 原生请求语义；只有负责开发人员可响应，等待不会取消任务或抢占其他运行 Turn；
- Git、测试、构建、Push、部署和 cleanup 由 Codex 在仓库规则约束下执行，Runner 不内置这些命令；
- channel provider 与通用 agent runner 通过 contract 注入，频道场景不与协作提测状态机混写。
