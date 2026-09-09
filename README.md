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

`bun run dev` 会在仓库 `.scratch/development/` 中准备数据库并自动创建上述本地开发用户。开发数据库的 Schema 过期时会自动重建，不读取或删除仓库外的数据。

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

仓库开发数据：

```text
.scratch/development/
├── server/
│   ├── server.sqlite
│   └── files/
```

`bun run dev`、`bun run dev:app` 和 `bun run seed:app` 只处理这个可丢弃目录。Schema 版本不匹配时，开发启动流程会自动重建 `server/`；如果 `AGENT_PARTY_TIME_HOME` 指向仓库 `.scratch/` 之外，开发准备脚本会拒绝删除。

正式 Server 数据默认位于 `~/.agent-party-time/`，也可以通过 `AGENT_PARTY_TIME_HOME` 指定。正式启动不会自动重建数据库；上线前需要提供对应的迁移策略。

xapt 本机状态：

```text
~/Library/Application Support/com.agentpartytime.xapt/
├── identity.json
├── connection.json
└── state/{bindings.json,executions/,outbox/,workspaces/}
```

`identity.json` 在重新授权、更新和删除连接状态时保持不变，Server 因此会复用同一 Agent 并轮换 Credential。不要手工删除 xapt 状态；使用 `xapt uninstall`，避免丢失未发送 Outcome。

## 质量门

```bash
bun run check:deps
bun run test
bun run typecheck
bun run format:check
bun run build:app
bun run test:browser
```

`test:browser` 需要本机已安装 `chrome-use`。它使用独立临时数据目录和浏览器
会话运行 Cooking 关键交互，不读取或修改开发数据库。

常用分项：

```bash
bun test apps/web
bun test apps/xapt/src
bun run typecheck:app
bun run typecheck:xapt
```

## 故障排查

操作失败时，先按提示区分处理方式：繁忙错误可以稍后重试；数据一致性或存储错误需要维护者检查；未知异常应先刷新确认当前状态，避免重复提交。

内部异常的提示会附带诊断编号。维护者可在 Web 服务标准错误日志中搜索该编号，查找 `platform.unexpected_error` 事件，核对故障分类、操作名称（如有）和 SQLite 数字错误码。日志不记录原始异常消息、SQL、路径或凭据。

`xapt bugs delete` 会同时清理所选缺陷的修复、更新及会话同步执行。未指定 `--force` 时，进行中的关联任务会阻止删除；存在删除范围外的后续任务引用时，即使指定 `--force` 也会拒绝并回滚，由维护者检查任务归属。

## 代码结构

```text
apps/web/
├── app/                    Next 路由、布局和路由级装配
├── cooking/                提测与缺陷交付业务
│   ├── runtime/            跨业务 Module 的依赖装配与执行事件分发
│   ├── projects/           私密项目、成员、邀请和项目设置
│   ├── engineering/        工程、环境与负责人
│   ├── bindings/           工程与本机 Agent 的绑定
│   ├── submissions/        提测、工作区同步与提测信息
│   ├── bugs/               缺陷报告、分诊、看板与删除
│   ├── repair/             修复尝试、结果与会话同步
│   ├── update/             更新批次、部署与会话同步
│   ├── lifecycle/          验证、重开、取消与善后
│   ├── workspace/          按角色聚合工作区视图
│   ├── shared/             业务共享契约、写入与界面基础能力
│   └── ui/                 Cooking 共享页面框架
└── platform/               领域无关的认证、数据、文件、错误、Agent 与 Execution

apps/xapt/src/
├── cli/                    命令解析、调用和输出
├── daemon/                 当前用户后台进程、控制通道和状态
├── agent/                  Server 连接、授权、心跳与 HTTP 通信
├── codex/                  App Server 协议、输入、交互与结果读取
├── execution/              Execution 执行、工作区、附件与结果验证
├── state/                  本机持久状态和 Outbox
├── platform/               OS Interface 与 macOS Adapter
├── install/                安装版本切换、更新与卸载
└── skills/                 本机 Skill Bundle 管理

packages/execution-contract/  Web 与 xapt 共享的 Execution 协议
packages/runner-contract/     Web 与 xapt 共享的 Agent 协议
packages/runner-conformance/  协议验收 Adapter
```

每个 Cooking Module 使用 `contract.ts` 声明跨调用方的数据 Interface，`server/` 保存事务、业务行为与 Server Actions，`ui/` 保存界面和交互。测试与被测 Module 就近放置。`ui/` 中的 Server 渲染与 `'use client'` 声明仍按 Next 的执行规则区分；客户端只调用 Server Actions，不导入事务实现。

`runtime/` 是跨业务装配的集中入口，负责把修复候选、更新、善后与执行投影连接起来。通用 `platform/` 不引用 Cooking；路由在两者之间选择并装配所需能力。缺陷删除 HTTP 处理属于 `cooking/bugs/server/http.ts`，共享响应转换属于 `platform/http/responses.ts`。

大文件内部按完整职责拆分：缺陷看板协调状态，附件、报告编辑、修复时间线、更新详情与交互记录分别实现；提测工作区把同步状态、侧栏偏好、详情和清理交互分开；项目路由只接入项目设置页。修复、更新和善后的结果解释与展示投影位于各自的 `server/results.ts`，数据行类型位于 `server/records.ts`，事务顺序继续由原有业务类控制。

`BugService.deleteBugs()` 是调用方的删除 Interface，内部 `BugDeletion` 集中处理关联执行收集、活动检查、事务删除、依赖校验与提测版本推进。测试继续通过 `BugService` 验证完整行为，不依赖删除过程的私有步骤。

依赖方向：

```text
app routes → cooking/runtime → cooking/*/server → platform
app routes → cooking/*/ui → contract / Server Actions
app routes → platform
platform ✕→ cooking
xapt → execution-contract + runner-contract
xapt ✕→ web / cooking
```

修改目录或抽取 Module 时，同时更新导入、脚本和配置中的扫描范围、按源码路径定位的架构测试及文档指针。协议、路由、Schema、命令和持久化路径不能随目录整理改变。

## 安全边界

- Session Cookie 为 `HttpOnly`；数据库只保存 Session Token Hash 和 Agent Credential Hash。
- 跨边界输入输出由 Zod Schema 校验并推导 TypeScript 类型。
- 业务写入使用事务、实体 Version、Mutation ID、Audit 与 Workspace Revision。
- Tester 看不到 Commit、Prompt、Session、技术失败详情或本机路径。
- 任何角色都无法通过 Server 或网页读取 Agent 本机绝对仓库路径。
- 不自动 force push、不自动推测外部 Pipeline 成功、不连接 CI Provider API。
