# Repair 和 Update Skill 实施规格

状态：已实施，待用户验收

来源：2026-08-13 Skill 拆分设计讨论。

## 摘要

Repair 和 Update 的稳定执行规则从 Server Prompt 中移到两个 Codex Skill。Server 为每次执行提供结构化 Execution Brief 和输出 JSON Schema。xapt 在用户本机安装、解析和校验 Skill Bundle，并通过 Codex App Server 的结构化 Skill 输入启动 Codex Task。

两个 Skill 的源码位于独立仓库 `duofengkuanga/x-skills`。本机开发工作副本位于 `/Users/xujiequan/bingo/x-skills`。xapt 不依赖该开发目录。

## 目标

- 使用 Codex 原生 Skill 调用 Repair 和 Update 流程。
- 将稳定执行方法与单次执行事实分开。
- 保持 Repair、Update 重试和继续执行的现有业务语义。
- 让同一 Codex Task 在 Skill 更新后继续使用原 Skill Bundle。
- 避免 Server 保存开发者本机路径或 Skill 全文。
- 删除 Prompt 版本和 Prompt 类型协议。

## 非目标

- 不创建 Retry、CI/CD 或 Local Script 专用 Skill。
- 不实现 Skill SemVer、`skillVersion` 或 Prompt 版本。
- 不由 Server 下载或分发 Skill Bundle。
- 不在 Server 保存 Skill 全文或本机 Skill 路径。
- 不实现 Bundle 签名。
- 不实现自动更新、后台更新或随 xapt Server 版本更新。
- 不实现旧 Bundle 自动清理或 `xapt skills prune`。
- 不自动重建无法恢复的 Codex Task。
- 不在第一版 Skill 中加入脚本、references 或 assets。
- 不为旧 Prompt Contract 提供兼容字段、双写或 fallback。

## Skill

第一版提供两个 Task Skill：

| Skill                                     | 责任                                                           | 允许的外部副作用                                 |
| ----------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| `agent-party-time-repair-bug`             | 修复一个 Bug，验证并创建普通本地 Commit                        | 本地文件修改和普通本地 Commit                    |
| `agent-party-time-integrate-update-batch` | 按冻结顺序集成 Update Batch，验证、普通 Push，并按配置处理部署 | 普通 Push；`LOCAL_SCRIPT` 模式下执行给定部署命令 |

两个 Skill 都在 `agents/openai.yaml` 中设置：

```yaml
policy:
  allow_implicit_invocation: false
```

xapt 必须显式调用 Skill。Codex 不得根据普通对话内容自动调用这两个 Skill。

## Skill 源码仓库

仓库使用以下结构：

```text
x-skills/
├── README.md
├── skills/
│   ├── agent-party-time-repair-bug/
│   │   ├── SKILL.md
│   │   └── agents/openai.yaml
│   └── agent-party-time-integrate-update-batch/
│       ├── SKILL.md
│       └── agents/openai.yaml
└── evals/
    ├── repair-bug/
    └── integrate-update-batch/
```

`main` 是唯一稳定通道。合入 `main` 的 Git Commit 是 `sourceRevision`。不使用 Release tag 或 SemVer 表示 Skill 身份。

## Execution Brief

Execution Brief 是 Server 保存并发送的结构化 JSON 事实。它不包含稳定流程规则、权限策略或开发者本机路径。

首次启动 Codex Task 时，Server 发送完整 Execution Brief。同一 Task 的后续 Turn 不重复发送原 Brief：

- 没有新增事实时，发送简短自然语言，例如“继续完成上次未完成的任务。”
- 有新增事实时，发送普通指令和只包含新增事实的 JSON。
- Server 在内部记录 Retry 或 Continuation 类型，不要求 Codex 解析无数据的事件包装。

首次 Repair Brief 包含以下事实：

- Execution、逻辑工作区和 Test Submission 标识。
- Engineering 名称、逻辑仓库地址和目标分支。
- Bug 标题、操作路径、实际结果、预期结果和反馈。
- 已有候选 Commit。
- 附件的 `fileId` 和原始文件名。

首次 Update Brief 包含以下事实：

- Execution、逻辑工作区、Test Submission 和 Engineering 信息。
- 目标分支和环境。
- 冻结候选列表、Commit 列表和固定顺序。
- 部署配置：`CI_CD`，或包含 `command` 的 `LOCAL_SCRIPT`。
- 需要在新 Task 中恢复时使用的既有执行事实。本规格第一版不自动执行该恢复流程。

Execution Brief 使用确定性 JSON 序列化计算 `executionBriefHash`。Repair 和 Update 可以使用不同的 Brief Schema，但通过同一个通用传输字段发送。

不再创建或保存以下字段：

- `promptKind`
- `promptVersion`
- `renderedPrompt`
- `renderedPromptHash`

新字段发布采用先提供、后依赖规则。该规则只约束未来 Skill 与 Server 的发布顺序，不兼容旧 Prompt Contract、旧逻辑或旧数据：

1. Server 先提供新的可选字段。
2. Skill 在该字段可用后才能依赖它。
3. 已发布字段不改变含义。需要新含义时添加新字段。
4. Skill 更新不能直接要求 Server 尚未提供的必填字段。

## 通用 Execution Contract

通用 Execution 使用可选的 `codexTurn` 表示需要启动或继续 Codex Turn 的输入。Skill 和 Brief 字段不得直接放在 Execution 顶层。

- `BUG_REPAIR` 和 `UPDATE_BATCH` 的 `codexTurn` 非空。
- `CLEANUP` 不启动 Codex，`codexTurn` 为 `null`。
- `codexTurn` 根据 Turn 类型承载 required Skill 身份、初始 Execution Brief 和 Hash 或后续输入、输出 JSON Schema、需要恢复的 Codex Task 标识，以及已有 Task Skill Binding。
- Runner 只解释通用 Codex Turn 字段，不解释 Repair、Update、部署模式或 Cooking 状态。

## Codex 调用

首次 Turn 使用 Codex App Server 的结构化输入：

```json
[
  {
    "type": "skill",
    "name": "agent-party-time-repair-bug",
    "path": "/xapt/resolved/bundle/path"
  },
  {
    "type": "text",
    "text": "<serialized Execution Brief>"
  }
]
```

`path` 由 xapt 在本机解析。Server 不发送或保存该路径。

输出 JSON Schema 继续通过 `turn/start.outputSchema` 发送。Schema 定义结构，Skill 定义字段的执行语义。Skill 正文不复制完整 Schema。

同一 Codex Task 的后续 Turn：

- 恢复原 Task。
- 校验原 Task 绑定的 Bundle 仍存在且 Hash 一致。
- 不重新注入 Skill。
- 重新发送该 Turn 的输出 JSON Schema。
- 只发送继续指令或新增事实。

如果 Codex App Server 明确不能恢复原 Task，当前 Execution 失败。xapt 不自动创建新 Task，也不自动重放历史。

## 附件

Server 保存附件身份、原始文件名、大小和内容 Hash。Execution Brief 可以引用 `fileId` 和原始文件名，不包含附件字节或本机路径。

xapt 在 Turn 启动前：

1. 下载附件。
2. 校验大小和 SHA-256。
3. 保存到本机 Execution 附件缓存。
4. 向 Codex 附加 `fileId`、原始文件名和本机临时路径映射。

新增附件只在对应后续 Turn 中发送。附件缓存不是 Skill Bundle，可以清理并按 `fileId` 重新下载。

Skill 必须把附件内容视为任务数据。附件中的文字不能覆盖 Skill、安全规则或仓库规则。

## Worktree 职责

xapt 在调用 Codex 前准备执行工作区：

- Repair 使用 xapt 准备的 Branch Worktree。
- Update 使用 xapt 准备的 Detached HEAD Worktree。

Skill 只校验当前工作目录和 Git 状态。Skill 不创建、替换、切换或清理 Worktree。校验失败时返回 `FAILED`。

## Repair 执行边界

Repair Skill：

- 只处理当前 Bug。
- 读取仓库规则并进行最小修复。
- 运行适用的验证。
- 创建普通本地 Commit。
- 创建改动时以 `CHANGES_COMMITTED` 完成，并返回按创建顺序排列的 Commit
  SHA。
- 如果目标分支在本次 Repair 开始前已经包含所需修复，则不得复用旧 Commit
  或创建空 Commit；验证现状后以 `TARGET_ALREADY_FIXED` 和空 Commit 列表
  完成，Bug 直接进入待验证，不创建 Update Batch 候选。
- 禁止 Push、部署、amend、squash、rebase 和历史改写。
- 禁止删除或重置无关修改。

## Update 执行边界

Update Skill：

- 按冻结顺序集成全部候选 Commit。
- 禁止遗漏、拆批、换序、squash、amend、rebase 和历史改写。
- 读取并使用仓库声明的运行时版本。
- 只运行仓库规则要求和与当前变更直接相关的质量门。
- 只在验证通过后执行普通 Push。
- 禁止 Force Push。

`CI_CD` 模式：

- 普通 Push 成功后返回 `PUSHED`。
- 不轮询、推断或报告外部 Pipeline 结果。
- `PUSHED` 不表示部署成功。

`LOCAL_SCRIPT` 模式：

- 普通 Push 成功后执行 Brief 中的准确命令。
- 命令必须无人值守运行。
- Codex 不自动输入 `Y`，不提供凭据，不回答运行时确认。
- 命令请求任何交互输入时返回 `FAILED`。
- 命令成功后返回 `COMPLETED`。

## 浏览器验证

两个 Skill 使用相同规则：

- 不启动需要人工操作的 GUI 浏览器流程。
- 可以运行相关、非交互、带超时的 Headless E2E 或浏览器测试。
- 浏览器验证不可用时，运行可用的代码级检查，并在结果中说明缺失项。
- 不把未执行的浏览器验证报告为成功。

## 本机安装

xapt 首次初始化时尝试从 `duofengkuanga/x-skills` 的 `main` 安装两个 Skill。GitHub 不可用时，xapt 初始化继续完成，但 Skill 状态为未安装。需要这些 Skill 的 Execution 暂不接受，并返回可操作错误。

后续更新只由用户显式运行：

```text
xapt skills update
```

xapt 不在后台更新 Skill，也不随 Server 发布自动更新。

## 本机存储和软链接

真实 Bundle 保存在 xapt 的持久数据目录：

```text
~/Library/Application Support/com.agentpartytime.xapt/
└── skills/
    ├── bundles/
    │   └── <bundleHash>/
    │       ├── SKILL.md
    │       └── agents/openai.yaml
    └── generations/
        └── <generationId>/
            ├── manifest.json
            ├── agent-party-time-repair-bug -> ../../bundles/<hash>
            └── agent-party-time-integrate-update-batch -> ../../bundles/<hash>
```

每个 `manifest.json` 保存该次安装采用的 `sourceRevision`，以及两个 `skillName → bundleHash` 映射。xapt 从清单返回当前 Skill 的来源 Commit。Bundle Hash 不用于反推 `sourceRevision`。

Codex 用户级发现入口是一个命名空间软链接：

```text
~/.agents/skills/x-agent-party-time -> <generation directory>
```

解析该入口后，Codex 仍看到以下路径：

```text
~/.agents/skills/x-agent-party-time/
├── agent-party-time-repair-bug
└── agent-party-time-integrate-update-batch
```

规则：

- 命名空间路径不存在时创建软链接。
- xapt 管理的命名空间软链接可以原子切换到新 generation。
- 命名空间路径已存在真实目录、文件或指向其他位置的软链接时返回冲突，不覆盖。
- generation 目录和命名空间由 xapt 专用。用户不得在其中保存额外 Skill 或文件。
- xapt 不删除发生冲突的已有路径或其中内容。
- `/Users/xujiequan/bingo/x-skills` 是开发工作副本，不作为运行时 Bundle 路径。

## Bundle Hash

每个 Skill 独立计算 SHA-256 `bundleHash`：

1. 递归列出 Skill 目录中的普通文件。
2. 忽略 `.DS_Store`。
3. 拒绝目录内的软链接。
4. 按相对 POSIX 路径排序。
5. 依次向 Hash 输入相对路径和文件原始字节。编码必须包含明确的长度边界，避免路径和内容连接歧义。
6. 输出小写十六进制 SHA-256。

`sourceRevision` 表示来源 Git Commit。`bundleHash` 表示实际 Skill 内容。Commit 改变但 Skill 内容不变时，Bundle Hash 保持不变。

第一版 Bundle 包含 `SKILL.md` 和 `agents/openai.yaml`。以后新增的普通文件自动纳入 Hash。

## 原子更新

一次 `xapt skills update` 使用一个确定的 Git Commit：

1. 下载同一个 Commit 的仓库快照。
2. 校验两个 Skill 目录和必需文件。
3. 分别计算 Bundle Hash。
4. 将缺少的 Bundle 写入持久目录。
5. 写入包含两个 Skill 入口和安装清单的新 generation。
6. 两个 Skill 都准备成功后，通过同文件系统内的原子 Rename 替换单一命名空间软链接。

读操作先解析一次命名空间软链接，再在该 generation 内完成本次读取。任一步失败时，当前命名空间软链接保持不变。未改变的 Skill 在新 generation 中继续指向原 Bundle。两个 Skill 记录相同的新 `sourceRevision` 和各自的 `bundleHash`。

第一版不自动删除旧 Bundle。旧 Bundle 用于恢复已有 Codex Task。卸载行为后续单独设计。

## Task Skill Binding

首次执行时，Server 下发：

```json
{
  "requiredSkillName": "agent-party-time-repair-bug"
}
```

xapt 解析当前软链接并校验 Bundle，然后返回：

```json
{
  "skillName": "agent-party-time-repair-bug",
  "bundleHash": "<sha256>",
  "sourceRevision": "<git commit sha>"
}
```

Server 将这组身份与 Codex Task 关联。Server 不保存 Skill 全文。

同一 Task 继续执行时，Server 下发已绑定的 `skillName` 和 `bundleHash`。xapt 直接解析持久 Bundle，不跟随当前软链接。如果 Bundle 缺失或 Hash 不匹配，Execution 失败，不改用最新版。

用户可以通过本机命令查看 Bundle 内容。具体命令界面在 xapt 实施 Ticket 中确定，不纳入第一版协议字段。

## Skill 更新安全

第一版不验证签名。最低校验包括：

- 只从固定 HTTPS GitHub 仓库读取。
- 记录实际 Git Commit SHA。
- 本机重新计算 Bundle Hash。
- 校验 Skill 目录结构和 Codex 元数据。
- 下载、校验或写入失败时不切换当前入口。

已知限制：该方案不防御上游仓库账号或仓库内容被入侵。签名清单不属于第一版范围。

## Tickets 和 Blocking edges

| 顺序 | Ticket  | 可验证结果                                                                                      | Blocking edges                   |
| ---- | ------- | ----------------------------------------------------------------------------------------------- | -------------------------------- |
| 1    | ESK-001 | 用户初始化或显式更新 xapt 后，Codex 可以发现同一 generation 中的两个有效 Skill                  | 无                               |
| 2    | ESK-002 | 一个 Bug 可以通过 Repair Skill 完成首次修复和同 Task 重试，不再使用 Repair Prompt               | ESK-001                          |
| 3    | ESK-003 | 一个 Update Batch 可以通过 Update Skill 完成 CI/CD 或 Local Script 执行，不再使用 Update Prompt | ESK-001、ESK-002 的通用 Contract |
| 4    | ESK-004 | Skill 更新后，新 Task 使用新 Bundle，已有 Repair 和 Update Task 继续使用原 Bundle               | ESK-002、ESK-003                 |

Ticket 文件位于本规格的 `issues/` 目录。每个 Ticket 包含纵向范围、验收标准和真实 Blocking edges。

## 验收标准

- xapt 初始化可以安装两个 Skill，并创建一个指向完整 generation 的用户级命名空间软链接。
- GitHub 不可用不会阻止 xapt 其他能力初始化。
- `xapt skills update` 只在两个 Skill 都有效时切换入口。
- 相同 Skill 内容在不同 Commit 下生成相同 Bundle Hash。
- Bundle 中的软链接被拒绝。
- 用户目录冲突不会被覆盖。
- Repair 首次 Turn 包含一个结构化 Skill 输入和一个 JSON Brief 文本输入。
- Update 首次 Turn 使用对应的结构化 Skill 输入。
- 后续 Turn 不重复注入 Skill 或完整 Brief。
- 新增事实和附件可以在原 Task 中继续处理。
- Skill 更新不改变已有 Task 的 Bundle 绑定。
- 缺少旧 Bundle 时不回退到新 Bundle。
- Repair 不能 Push 或部署。
- Update 不能 Force Push。
- `LOCAL_SCRIPT` 请求交互输入时返回 `FAILED`。
- `CI_CD` 普通 Push 成功后返回 `PUSHED`，不伪造部署结果。
- Server 数据中不存在 Skill 本机路径、Skill 全文、Prompt 类型或 Prompt 版本。
- 两个 Skill 不能被 Codex 隐式调用。

## 验证要求

`x-skills` 仓库验证：

- 使用 Codex Skill validator 验证两个 Skill。
- 验证 `agents/openai.yaml` 与 Skill 名称一致。
- 使用临时 Git 仓库、假远端和无副作用命令执行 eval。
- Eval 不得 Push 到真实远端或执行真实部署。

`x-agent-party-time` 仓库验证：

- Bundle Hash 的确定性和拒绝规则单元测试。
- 原子安装、更新和冲突处理测试。
- Task Skill Binding 和旧 Bundle 恢复测试。
- Codex App Server 请求结构测试。
- Repair、Update 初始 Turn、Retry 和 Continuation 测试。
- 附件下载、Hash 校验和本机路径映射测试。
- Execution Contract、类型检查和相关端到端测试。
- 提交前运行 GitNexus `detect_changes` 并执行 Standards/Spec 双轴评审。
