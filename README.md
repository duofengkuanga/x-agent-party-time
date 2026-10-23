# Agent Party Time

Agent Party Time 将产品测试人员、工程负责人和开发者本机 Agent 的 Codex 执行连接成一条可恢复的缺陷修复与提测闭环。仓库当前只保留新的 Cooking 系统：一个 Next 全栈 App、一个本机 Agent，以及它们共享的通用协议包。

## 产品能力

```text
私密项目
→ 工程、成员、环境与部署配置
→ 浏览器授权本机 Agent 与工程绑定
→ 多工程提测单
→ Bug 分诊与按工程执行的修复
→ Codex Repair / Interaction / Commit Chain
→ LOCAL_SCRIPT 或 CI/CD Update Batch
→ 测试验证、重开、关闭与异步 Cleanup
```

六列主看板：

```text
待修复 → 修复中 → 待更新 → 更新中 → 待验证 → 已完成
                         └──────────────→ 已取消（可恢复）
```

关键规则：

- 项目是私密协作边界，只有项目成员可以访问。
- 项目负责人可在“项目设置”中输入项目名称确认删除项目，永久移除成员、邀请、工程、绑定及全部提测记录。活动提测单、未完成的本机任务或善后、尚未结束的绑定请求会阻止删除。
- 一张提测单可以包含多个工程，活动期间创建人、测试负责人、已有工程负责人或项目所有者可追加工程，原工程和缺陷保留；环境冲突沿用确认切换规则。
- 提测项固定负责人、Binding 和环境，活动提测的部署配置读取工程环境当前设置。缺陷首次进入修复队列时固定部署配置，后续修复、更新和返修沿用；同工程不同部署配置的缺陷分批串行更新。被活动提测引用的环境仍不能在页面修改部署配置。
- Server 不保存开发者本机仓库绝对路径；路径只保存在对应 Agent 本机。
- Agent 只负责通用 Execution、Lease、附件、Interaction、Outcome 与 Outbox，不包含 Cooking 领域逻辑。
- Git、测试、构建、Commit、Push、部署和 Cleanup 都由 Codex 根据版本化 Prompt 在仓库规则约束下执行。
- `LOCAL_SCRIPT` 在普通 Push 后执行本地部署脚本；`CI_CD` 在 Push 后等待工程负责人明确报告外部结果。
- 验证失败和活动期重开会沿用原 Repair Session 自动继续；关闭提测单立即释放环境，不等待 Cleanup。
- 同一环境同时只供一张提测单使用。创建时可确认优先使用，原提测单仅暂停对应提测项的更新与验证，保留缺陷和进度。
- 切换环境由项目所有者或原提测单的测试负责人确认；更新执行、会话同步或外部部署尚未结束时禁止切换。暂停项可重新取得环境，但不会自动恢复或部署；对应工程负责人确认当前提测版本已部署后才开放测试验证。
- 已关闭提测单不接受业务修改；已取消 Bug 可恢复，维护命令可清理 Bug 与关联执行。
- 缺陷登记或首次修复前调整归属时，可以选择前端＋后端；调整时保留原单并补建关联单，资料和附件一起保存，两张单分别进入待修复与更新。两单都待验证或已完成后，测试从一个入口验收，并可在返修时重新选择前端、后端或两端归属。

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

`bun run dev` 会在仓库 `.scratch/development/` 中准备数据库并自动创建上述本地开发用户。新流程使用 Schema 30；旧版本明确报错并保留数据，不自动迁移或清空。Schema 27、28、29 可按下述流程保留数据升级。

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

`bun run dev`、`bun run dev:app` 和 `bun run seed:app` 使用这个目录。开发启动流程保留数据库和附件，不支持的 Schema 版本会阻止启动；如果 `AGENT_PARTY_TIME_HOME` 指向仓库 `.scratch/` 之外，开发准备脚本会拒绝处理。

正式 Server 数据默认位于 `~/.agent-party-time/`，也可以通过 `AGENT_PARTY_TIME_HOME` 指定。启动只接受 Schema 30 和空数据库，现有旧库不会被启动流程改写。

### 保留数据升级 Server

从仓库根目录执行预检，明确指定报错 Server 实际使用的数据库。下面的路径仅指本仓库开发库：

```bash
bun run migrate:server -- --database .scratch/development/server/server.sqlite
```

预检默认只读，检查 Schema 27/28/29 的完整结构、数据库完整性和未完成旧流程。Schema 27/28 若存在未完成执行、交互、更新批次、候选提交或已开始但未结束的修复流程，先在旧 Server 完成，不清空任务来绕过检查。Schema 29 → 30 仅新增归因表和删除标记，不转换业务记录，允许保留活动任务；应用前仍须停止访问该库的进程。

确认目标库及迁移方案后停止该 Server；本仓库开发进程可用 `bun run stop`。再执行：

```bash
bun run migrate:server -- --database .scratch/development/server/server.sqlite --apply
```

工具先取得写锁，通过 SQLite `VACUUM INTO` 将包含 WAL 提交的完整数据库备份到原库旁的 `server.sqlite.backup-*/server.sqlite`，验证备份后才在事务中升级。备份目录权限为 `0700`，文件为 `0600`；输出 `backupPath` 是本次备份路径。迁移前后逐表校验记录数量、原有字段和业务内容，并检查外键和完整性；失败时回滚，版本号最后才更新。重复运行 Schema 30 不再迁移。

保留全部历史修复、更新、会话、账号、项目、绑定和附件索引，附件文件目录不变。旧结果一次性转换成当前契约：修复记录新增交接字段并注明旧版本未记录的信息；更新记录的交接使用列表表示旧记录中实际留存的内容，不虚构命令或验证结果；已完成批次根据原修复来源和完整提交 Hash 重建交接关联。执行结果及已报告结果同步转换，所有既有字段的业务内容保持不变。无法无损转换或关联不完整时整次回滚。应用运行时只接受最新格式，不增加旧格式读取分支。完成后重新启动对应 Server，并核对历史详情与 Agent 连接。

事务失败无需手工恢复。若成功迁移后必须退回旧 Server，先停止全部访问该库的进程，将当前数据库及同名 WAL/SHM 文件一起另存，保留现有附件目录，再从已验证的备份复制恢复到原路径并启动匹配版本的 Server。备份之后产生的新记录需要另行处理；不要只改 `user_version`，也不要把旧 WAL 文件与恢复库混用。

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

## Repair Handoff 真实会话验收

`eval:handoff` 创建隔离的 Node、Python 工程及本地假远端，实际运行 Codex Repair 和 Update，核对完整提交、结构化结果、验收命令和 Push。它不会连接真实部署，保留每阶段的输入、Schema、Skill Bundle Hash、事件、结果及命令轨迹。

```bash
bun run eval:handoff --skills-root /path/to/x-skills --baseline-app <旧版本提交> --baseline-skills <旧版Skill提交>
```

使用 `--case node|python` 或 `--variant baseline|current` 运行单个范围。需要本机 Codex 已登录，以及 Node 和 Python；沿用本机模型配置，每阶段最长八分钟。证据目录在启动时输出，失败保留阶段结果及错误日志，不把部分运行记为通过。原始文件只保存在本机，分享前检查内容。

使用 `--case node --variant current --scenario independent|stale|multi|resume` 验证独立强制检查、失效入口、多候选与真实会话恢复。恢复场景保留原 Codex Task 并续接同一会话，模拟终态传输丢失，核对远端和已完成验收没有被盲目重复；其他场景使用临时会话。

对照看完整 Repair + Update 耗时及实际重复命令，人工等待单列；小样本和模型服务波动不能证明固定提速比例。现有 Skill 文案检查和预写 Git 沙盒验证不等于真实 Agent 行为验收。

## 故障排查

修复或更新遇到异步人工确认时，网页先显示正在释放会话，随后显示“等待人工确认”。工程负责人点击“打开原 Codex 会话”，回答问题并完成任务后，再返回网页点击“同步状态”。无需手动退出 xapt 或删除锁文件。尚未完成或结果无效的同步不会改变等待状态，也不会自动重启任务。

Repair Handoff 随候选提交冻结，包含历史验证入口、环境经验和剩余事项；Update 核实这些线索后，对最终组合完成当前工程要求的验收。历史通过不代表本轮免检。工程负责人在更新详情中查看来源和使用依据，测试负责人只看到业务结果与验证摘要。

Server Schema 30 要求新交接契约。旧 Task 固定原 Skill Bundle，更新 Skill 不会改写旧任务；切换前完成或明确处置旧任务，并核对 Server、xapt 和 Skill Bundle 的组合。交接缺失、来源不匹配和冻结矛盾会明确阻止更新。

操作失败时，先按提示区分处理方式：繁忙错误可以稍后重试；数据一致性或存储错误需要维护者检查；未知异常应先刷新确认当前状态，避免重复提交。

内部异常的提示会附带诊断编号。维护者可在 Web 服务标准错误日志中搜索该编号，查找 `platform.unexpected_error` 事件，核对故障分类、操作名称（如有）和 SQLite 数字错误码。日志不记录原始异常消息、SQL、路径或凭据。

`xapt bugs delete` 会同时清理所选缺陷的修复、更新及会话同步执行。未指定 `--force` 时，进行中的关联任务会阻止删除；存在删除范围外的后续任务引用时，即使指定 `--force` 也会拒绝并回滚，由维护者检查任务归属。

## Repair / Update 自动耗时归因

xapt 内置采集和确定性分析，不需要额外 Skill 或常驻大模型。每次 Execution 从本机收到任务开始，到观察到 Server 接受终态结果为止记录历时；Server 排队另计。工作区、附件、规则包、启动、工具、交互、校验和业务回传留下安全事件，归因通过独立补报队列送达，诊断故障不改变业务 Outcome。

当前提测项负责人且仍为项目成员时，可在修复、更新的对应轮次展开“耗时分析”。关闭时不请求报告；展开后固定所见版本，有新记录时显式更新。更新批次由多个缺陷共享，不按缺陷分摊。可导出同一版本的阅读版或结构化报告；权限变化、删除和过期在每次读取、导出时重新检查。

- 并行活动按区间并集核算，工具与交互的重叠单列；父子时长不直接相加。
- 跨进程恢复保留独立片段，不用墙上时间拼出精确总历时。内部缺事件或冲突局部标注，可靠整体端点仍可使用。
- 未归因时间保持未知，不能视为模型思考；只有来源 duration 的活动单列，不伪造时间线位置或扣减总历时。
- 分类来自实际命令结构或当前工作目录的有界静态脚本定义。动态 shell、缺少目录、生命周期钩子和不安全上下文保留未知或混合。
- 多次同类活动先报告重复调用；具备额外范围线索时才给疑似重复候选。等价、可省略性和节省时间需独立核验。
- 模型、推理档位和用量仅展示协议实际提供的数据。累计用量快照不能跨快照相加；不猜费用。

本机仅保存允许列结构化事件，不复制聊天、原始命令/输出或任意协议包。目录 `0700`、文件 `0600`；队列按 Server 和原分配 Agent 隔离，不持久化认证值。网页只获得安全投影和不透明引用，不能通过引用读取本机文件。Server 展示已保留事实数量与本机报告输入数量，不把分批到达的事实宣称为独立复算完成。

本机记录与未确认补报默认保留30天，单执行50 MiB、安装合计1 GiB、采集队列8 MiB；事件8 KiB、单批128条/256 KiB、摘要64 KiB。Server 明细30天、摘要180天且最多10版，另将摘要与批次状态限制在每执行1 MiB；详情到期后仅有摘要。核算输入和显示明细另有有界裁剪，报告明确标记预算缺口，不把裁剪后数据当完整证据。存储/补报降级可通过 `xapt daemon status` 查看，本次进程出现故障会保留降级提示。

补报使用不可变批次身份与安全内容摘要，只有匹配接受回执才释放待报内容；响应丢失重试同一批次。网络错误退避，认证失败暂停；损坏块单独标记，其他执行继续。身份/内容被明确拒绝时隔离受影响执行的报告链，保留本机丢失原因和降级状态，不通过生成新身份绕过冲突；当前链可能无法继续形成新报告，业务执行及其他执行的归因仍独立运行。

### 重复构建验证

受控 Engineering 的预构建部署流程为：集成全部候选 → 必需检查与一次构建 → 封存产物 → 普通 Push 并确认 → 部署这一份产物。部署入口由工程提供，xapt 不增加构建编排或跳过验证开关。目标工程、冻结命令和旧任务不会因观测功能自动改变。

首例提供隔离假远端和假目标，使用真实 Bun 编译。基线部署再次构建；优化部署核对输入、源提交、独立检查、产物摘要与目标回执，消费同一封存字节，失败时明确停止。测试覆盖篡改、输入失效、Push 未确认、目标竞争和响应丢失恢复。

工程脚本可在当前命令终态输出中发出以下有界来源回执：

```text
XAPT_OBSERVATION_V1 {"version":1,"activityId":"<随机UUID>","activity":"build","status":"succeeded","workId":"<本机范围随机UUID>","durationMs":1200}
```

只提取严格字段；最多读取末尾64 KiB、16条回执、单行8 KiB。`workId` 是不透明的本机范围身份，不能放敏感输入/命令/路径的哈希。回执可靠关联到实际命令 Item，但其内容仍是“来源报告”，不等于独立子进程追踪；没有 duration 就保持未知。普通日志、模型终态文字、静态分支不证明实际内部构建。

```bash
bun test scripts/observationContract.test.ts scripts/observability apps/xapt/src/observability apps/web/platform/execution/observations.test.ts
bun run eval:observability --skills-root /path/to/x-skills --runs 2
bun run eval:observability-overhead
```

真实评估入口通过 App Server 加载指定 Skill Bundle，每个变体完成两次 Repair → Update，先登记最多8次真实调用、单次5分钟上限，交替运行基线/优化。它同时核对 Cooking 状态转换、独立补报、读取导出、构建次数和产物回执。所有 Git Push 与部署仅作用于临时假目标，不连接真实环境；保留安全报告和独立轨迹。此入口是功能/诊断回归，**不能用于正式性能收益验收**。正式收益仍需规划票约定的观测开关对照及至少5对可比样本，当前不宣称真实工程已提速。

## 代码结构

按业务拥有者组织代码。一个目录对应一组需要一起理解和修改的业务行为；小函数、数据库行类型和仅服务于该业务的校验放在实现附近。

```text
apps/web/
├── app/          Next 路由、布局和路由级接入
├── cooking/      提测与缺陷交付业务，职责见下表
└── platform/     领域无关的认证、数据库、文件、错误、Agent 与 Execution

apps/xapt/src/    本机 CLI、daemon、连接、Codex、Execution 与本机状态
packages/
├── execution-contract/  Web 与 xapt 共享的 Execution 协议
├── runner-contract/     Web 与 xapt 共享的 Agent 协议和 HTTP 客户端
└── runner-conformance/  通过协议驱动场景的验收 Adapter
```

Cooking 的职责归属：

| 目录           | 负责的行为                                             |
| -------------- | ------------------------------------------------------ |
| `projects/`    | 私密项目、项目成员和邀请；组合项目管理页面中的各项设置 |
| `engineering/` | 工程、工程成员、环境配置、Agent 绑定及绑定申请         |
| `submissions/` | 提测单与提测项、环境使用权和切换；按角色聚合完整工作区 |
| `bugs/`        | 缺陷报告、分诊归属、关联关系和删除；看板与缺陷详情     |
| `repair/`      | Repair Attempt、修复结果、修复会话同步及候选交接       |
| `update/`      | Update Batch 冻结、更新执行、部署结果和更新会话同步    |
| `lifecycle/`   | 验证、重开、取消与恢复、归档；关闭提测及 Cleanup       |
| `runtime/`     | 跨业务依赖装配、Execution 事件分发和 Runner HTTP 接入  |
| `shared/`      | 多个业务实际共用且含义一致的契约、写入和界面能力       |
| `ui/`          | Cooking 共享页面框架                                   |
| `testing/`     | 真实业务场景与协议测试的隔离装配                       |

业务目录内，`contract.ts` 保存共享数据 Interface，`server/` 保存查询、事务和 Server Actions，`ui/` 保存界面及交互。测试与被测实现就近放置。客户端通过 Server Actions 或 HTTP 发起操作，使用纯数据契约，不导入数据库实现。

工程绑定属于工程配置：Binding Schema 放在 `engineering/contract.ts`，绑定操作入口放在 `engineering/server/actions.ts`，工程成员与归档校验归 `engineeringQueries.ts`。`bindingService.ts` 管长期绑定和仓库确认，`bindingRequestService.ts` 管有时限的目录选择申请及领取、完成状态。

工程与环境配置共用同一份 `CookingWriteStore`，由 `EngineeringService` 装配；`EnvironmentService` 保留环境创建、更新、删除的业务职责。项目邀请与环境引用检查直接绑定已有方法，避免仅转发参数的装配函数。

提测工作区是聚合视图。`submissions/contract.ts` 定义提测基础数据；`submissions/workspace.ts` 定义包含缺陷、修复、更新和生命周期投影的快照；`submissions/server/workspaceService.ts` 在访问权限通过后准备到期更新，再读取并组合这些投影。聚合快照与基础契约分开，避免基础实体相互引用，同时让界面能直接使用纯数据 Schema。

`bugs/server/bugQueries.ts` 集中缺陷读取与可操作条件；删除、转交命令和工作区操作展示共用其中的规则。一次工作区读取只计算一次当前用户是否为提测项负责人。关联记录与删除事务仍分别由 `bugRelations.ts`、`bugDeletion.ts` 负责。关联验收判定由 `lifecycle/server/lifecycleQueries.ts` 集中读取两端阶段、归档、环境和权限，查询投影与事务入口共用；界面只组合展示关联卡片。

`submissions/server/submissionItems.ts` 负责提测项配置校验、快照写入和环境接管，并返回受影响的提测单。创建、追加工程、环境切换和关闭提测的业务入口只返回受影响提测单及变更时间；`TestSubmissionWriteStore` 在业务事务中去重并递增这些提测单的工作区版本，成功提交后统一通知，回放或回滚不重复通知。当前提测单的版本仍由具体业务变更决定。冲突预检由业务入口完成权限和输入校验后，只传项目与提测项列表；追加预检不再转换为创建提测输入。`environmentAccess.ts` 保留跨业务的环境占用、确认和接管规则；`references.ts` 保留供项目、工程配置检查使用的低依赖查询。

修复、更新和生命周期的 SQL 行类型分别与查询放在 `repairQueries.ts`、`updateQueries.ts` 和 `lifecycleQueries.ts`。修复输入读取统一归 `repairQueries.ts`：只读取执行使用的报告、目标分支、绑定、历史反馈和带角色附件，附件直接使用 Execution Brief 所需的引用结构。`repairService.ts` 创建修复执行时直接组装 Execution Brief 和继续执行所需的新事实；`updateDelivery.ts` 同样就近组装更新与外部部署失败反馈，不再经过单一调用方的 Brief 转换文件。两个业务入口直接绑定查询和交付方法，保留调用 Interface，省去纯转发函数。

`updateDelivery.ts` 负责候选调度、批次冻结、执行准备和交付完成后的缺陷推进、候选清空，并拥有 `FrozenBatch`。Agent 更新成功与人工确认外部部署成功都调用同一完成逻辑；`updateProjection.ts` 专注 Execution 事件和会话同步结果的解释，两条结果回写路径共用按冻结部署配置选择的校验。`repairHandoffs.ts` 同时供批次冻结和离线迁移使用，保留独立的交接一致性校验。读取、业务状态变更和 Execution 投影各自保留明确职责，避免把整个业务堆进一个文件。

`lifecycle/server/submissionClosure.ts` 负责关闭前的业务校验、关闭状态、环境释放和受影响提测单的识别。其只读 `submissionCloseBlocker` 统一判断未完成缺陷、活跃修复或更新执行、未完成更新批次；工作区关闭入口和关闭事务共用该规则，访问权限、测试负责人和版本检查仍由各自入口完成。侧边栏直接使用工作区的 `CLOSE` 操作标记，不再根据缺陷列表自行推断能否关闭。`cleanupService.ts` 负责选择清理范围、创建任务、重试及执行结果投影。关闭事务调用 `createForClosedSubmission`，只传入提测单与时间，不拼装各工程的工作区范围；无资源的提测项不创建清理任务。清理结果解析是 Cleanup 的内部实现，清理展示标签与 `lifecycleQueries.ts` 的视图读取放在一起；装配入口向命令与清理共用同一份查询实例。

`repair/server/results.ts` 拥有修复状态标签、结果投影及已保存候选提交和手动操作的解析。Update 冻结、读取 Repair 产生的数据时直接复用这些解析，不经 `shared/` 转接或再包装一层函数。跨业务使用并不改变数据的拥有者。

`shared/server/writeStore.ts` 负责事务、幂等结果校验和审计编排；`auditEvent.ts` 保留仅依赖数据库的审计落库函数，供执行投影等调用方使用。将二者合并会让这些调用方提前加载业务 Schema，已在生产构建中触发初始化错误，因此保留这个低依赖 Interface。`executionState.ts` 处理执行状态、Task Skill Binding、执行事件详情和无效结果标记；交互脱敏与角色投影、通用执行展示和 Server Action 传输也由多个业务共用。`shared/` 只保存含义一致且没有单一业务拥有者的共用能力。

`runtime/createCooking.ts` 是生产和集成测试共同使用的执行链装配入口，统一连接修复、更新、生命周期和工作区读取。Platform 发出事务内 APPLY 与提交后 AFTER 事件，Cooking 根据归属选择投影；Session Synchronization 先确认 Repair 或 Update 归属。HTTP 路由和协议测试共用 `platform/runner/router.ts`，业务装配在 `runtime/runnerHttp.ts`。

耗时报告的上传、读取与导出由 `platform/execution/observationHttp.ts` 处理；Cooking 只通过 `runtime/observationAccess.ts` 注入业务访问规则。通用 HTTP 格式、预算和错误处理不依赖 Cooking。

xapt 按本机职责分为 `cli/`、`daemon/`、`agent/`、`codex/`、`execution/`、`state/`、`install/`、`skills/`、`observability/`、`platform/` 和 `testing/`。操作系统与外部 Codex、HTTP 通信有真实的生产和测试 Adapter，继续通过这些 Interface 验证。Server 不接收本机仓库绝对路径，xapt 不导入 Cooking。

`execution/workspaces.ts` 统一保存本机工作区状态、Git 身份校验、忽略内容镜像与创建、复用、清理流程。仅供该实现使用的 Git 调用和路径校验保持文件内私有；调用方继续通过 `ExecutionWorkspaceManager` 使用工作区能力，测试通过真实隔离 Git 仓库验证身份与清理保护。

依赖方向：

```text
app routes → cooking/runtime → cooking/*/server → platform
app routes → cooking/*/ui → contract / Server Actions
app routes → platform
platform ✕→ cooking
xapt → execution-contract + runner-contract
xapt ✕→ web / cooking
```

Platform 与 xapt 的依赖限制由 `platform/architectureBoundaries.test.ts` 验证。移动或合并实现时同步修改导入、扫描范围和文档指针，保留调用方的业务 Interface 和原有验收；按职责判断拆分，不用文件大小或行数替代这个判断。

## 安全边界

- Session Cookie 为 `HttpOnly`；数据库只保存 Session Token Hash 和 Agent Credential Hash。
- 跨边界输入输出由 Zod Schema 校验并推导 TypeScript 类型。
- 业务写入使用事务、实体 Version、Mutation ID、Audit 与 Workspace Revision。
- Tester 看不到 Commit、Prompt、Session、技术失败详情或本机路径。
- 任何角色都无法通过 Server 或网页读取 Agent 本机绝对仓库路径。
- 不自动 force push、不自动推测外部 Pipeline 成功、不连接 CI Provider API。
