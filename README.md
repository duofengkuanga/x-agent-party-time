# Agent Party Time

Agent Party Time 将产品测试人员、工程负责人和开发者本机 Agent 的 Codex 执行连接成一条可恢复的缺陷修复与提测闭环。仓库当前只保留新的 Cooking 系统：一个 Next 全栈 App、一个本机 Agent，以及它们共享的通用协议包。

## 产品能力

```text
私密项目
→ 工程、成员、环境与部署配置
→ 浏览器授权本机 Agent 与工程绑定
→ 多工程提测单
→ Bug 分诊与全局修复队列
→ Codex Repair / Interaction / Commit Chain
→ LOCAL_SCRIPT 或 CI/CD Update Batch
→ 测试验证、重开、关闭与异步 Cleanup
```

六列主看板：

```text
待修复 → 修复中 → 待更新 → 更新中 → 待验证 → 已完成
                         └──────────────→ 已取消（垃圾桶终态）
```

关键规则：

- 项目是私密协作边界，只有项目成员可以访问。
- 一张提测单可以包含多个工程，每个工程提测项冻结负责人、Binding、目标分支、环境和部署方式。
- Server 不保存开发者本机仓库绝对路径；路径只保存在对应 Agent 本机。
- Agent 只负责通用 Execution、Lease、附件、Interaction、Outcome 与 Outbox，不包含 Cooking 领域逻辑。
- Git、测试、构建、Commit、Push、部署和 Cleanup 都由 Codex 根据版本化 Prompt 在仓库规则约束下执行。
- `LOCAL_SCRIPT` 在普通 Push 后执行本地部署脚本；`CI_CD` 在 Push 后等待工程负责人明确报告外部结果。
- 验证失败和活动期重开会沿用原 Repair Session 自动继续；关闭提测单立即释放环境，不等待 Cleanup。
- 已关闭提测单只读；已取消 Bug 不可恢复或永久删除。

## 开发账号

Seed 默认创建三名本地开发用户：

| 姓名   | 用户名       | 默认密码 |
| ------ | ------------ | -------- |
| 徐捷泉 | `xujiequan`  | `123456` |
| 周明波 | `zhoumingbo` | `123456` |
| 田国会 | `tianguohui` | `123456` |

可通过 `AGENT_PARTY_TIME_SEED_PASSWORD` 覆盖默认密码。开发凭据不得用于生产环境。

## 安装与启动

面向 Apple Silicon macOS 的 0.x 预览版使用 ad-hoc 签名，未经 Apple 公证，
不会绕过 Gatekeeper，也不会安装或修改官方 Codex。安装前请先安装 Codex
standalone、完成 `codex login`，并确保版本不低于 `0.145.0`。

```bash
curl -fsSL https://raw.githubusercontent.com/duofengkuanga/x-agent-party-time/main/scripts/install-xapt.sh | sh
xapt daemon start
xapt daemon connect http://localhost:3000
xapt daemon status
```

更新和卸载：

```bash
xapt update
xapt uninstall
```

忙碌状态不会被普通停止、更新或卸载打断；`--force` 仅在真实 TTY 中确认后执行。

### 仓库开发

```bash
bun install --frozen-lockfile
bun run dev
```

`bun run dev` 会在空数据库中自动创建上述本地开发用户。

`bun run dev` 前台管理两个进程：

- App：Next.js 全栈应用，默认 `http://localhost:3000`
- Agent：本机执行进程；Web 尚未可用时安全等待

首次运行 `bun run xapt:dev -- daemon connect http://localhost:3000` 时，Agent 会打开浏览器连接页。登录后确认
Agent 名称与短指纹即可完成授权；正常重启不会再次打开授权页。

浏览器打开 `http://localhost:3000`，登录后会进入 `/cooking`。工程成员在
“项目与工程”的工程详情中选择自己的在线 Agent，Agent 随后打开 macOS
文件夹选择器；选择 Git 仓库后，网页会自动显示最终绑定结果。本机绝对路径
不会发送给 Web 服务。

进程管理：

```bash
bun run status
bun run stop
```

单独调试：

```bash
bun run dev:app
bun run dev:xapt
```

## 本地 Agent 授权与工程绑定

正常本地开发只需要运行 `bun run dev`，随后在 Web 中完成授权和工程绑定，
不需要复制配对码、Binding 标识或输入本机路径。每个工程成员默认只能保留
一个当前绑定；未被提测或任务引用的绑定可以删除后重新创建。

开发 Agent 使用 `.scratch/xapt-development/` 隔离状态；正式 xapt 按 macOS
惯例分别使用 `~/Library/Application Support/com.agentpartytime.xapt`、Caches
和 Logs，Credential 原文只在 macOS Keychain 中。

## 本地数据

```text
~/.agent-party-time/
├── server/
│   ├── server.sqlite
│   └── files/
```

xapt 本机状态：

```text
~/Library/Application Support/com.agentpartytime.xapt/
├── connection.json
└── state/{bindings.json,executions/,outbox/,workspaces/}
```

项目处于开发期，不提供旧 Schema 迁移。数据库版本不匹配时：

```bash
bun run stop
rm -rf ~/.agent-party-time/server
bun run seed:app
```

不要手工删除 xapt 状态；使用 `xapt uninstall`，避免丢失未发送 Outcome。

## 质量门

```bash
bun run check:deps
bun run test
bun run typecheck
bun run format:check
bun run build:app
```

常用分项：

```bash
bun test apps/web
bun test apps/xapt/src
bun run typecheck:app
bun run typecheck:xapt
```

## 代码结构

```text
apps/web/                    Next App、SSR、Server Actions、Route Handlers
packages/execution-contract/ 通用 Execution / Lease / Interaction / Outcome 协议
packages/runner-contract/    Agent 授权、心跳与工程绑定引用协议
apps/xapt/                   standalone Agent、daemon 与 Codex App Server 适配
scripts/                     App + Agent 开发进程管理
```

依赖方向：

```text
app routes → features/cooking → server
app routes → server
server ✕→ features/cooking
xapt → execution-contract + runner-contract
xapt ✕→ cooking
```

## 安全边界

- Session Cookie 为 `HttpOnly`；数据库只保存 Session Token Hash 和 Agent Credential Hash。
- 跨边界输入输出由 Zod Schema 校验并推导 TypeScript 类型。
- 业务写入使用事务、实体 Version、Mutation ID、Audit 与 Workspace Revision。
- Tester 看不到 Commit、Prompt、Session、技术失败详情或本机路径。
- 任何角色都无法通过 Server 或网页读取 Agent 本机绝对仓库路径。
- 不自动 force push、不自动推测外部 Pipeline 成功、不连接 CI Provider API。
