<!-- gitnexus:start -->

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **x-agent-party-time** (2039 symbols, 6748 relationships, 165 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze --index-only` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource                                            | Use for                                  |
| --------------------------------------------------- | ---------------------------------------- |
| `gitnexus://repo/x-agent-party-time/context`        | Codebase overview, check index freshness |
| `gitnexus://repo/x-agent-party-time/clusters`       | All functional areas                     |
| `gitnexus://repo/x-agent-party-time/processes`      | All execution flows                      |
| `gitnexus://repo/x-agent-party-time/process/{name}` | Step-by-step execution trace             |

## CLI

| Task                                         | Read this skill file                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| Understand architecture / "How does X work?" | `.agents/skills/gitnexus/gitnexus-exploring/SKILL.md`       |
| Blast radius / "What breaks if I change X?"  | `.agents/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?"             | `.agents/skills/gitnexus/gitnexus-debugging/SKILL.md`       |
| Rename / extract / split / refactor          | `.agents/skills/gitnexus/gitnexus-refactoring/SKILL.md`     |
| Tools, resources, schema reference           | `.agents/skills/gitnexus/gitnexus-guide/SKILL.md`           |
| Index, status, clean, wiki CLI commands      | `.agents/skills/gitnexus/gitnexus-cli/SKILL.md`             |

<!-- gitnexus:end -->

## Codex-only 项目规则

- 本项目只使用 Codex；`AGENTS.md` 是唯一项目规则入口，项目 skill 只放在 `.agents/`。
- 不创建、不维护 `CLAUDE.md`、`.claude/` 或其他 Claude Code 兼容副本。
- GitNexus 索引更新必须使用 `node .gitnexus/run.cjs analyze --index-only`，避免重新注入 `CLAUDE.md`、`.claude/` 或覆盖项目规则。
- `.agents/` 与 `AGENTS.md` 必须纳入 Git；`.gitnexus/` 仍是本地索引，不提交。
- 不使用 `docs/` 或 `CONTEXT.md`；开发规则和领域硬约束写入 `AGENTS.md`，项目使用说明写入 `README.md`，临时 Spec、Ticket 和调查记录写入 `.scratch/`。

## 开发期不兼容策略

- 本项目处于开发期；除非用户明确指出存在生产数据、已发布协议或外部系统契约，否则所有修改默认不做向后兼容。
- 旧数据允许清空并按最新 Schema 重建；旧字段、旧协议、旧状态、旧路由和旧行为应直接删除，不保留迁移分支或兼容入口。
- 发现领域模型、接口、状态机或数据结构设计错误时，直接修正为当前最清晰的模型，不维持错误设计。
- 禁止为了兼容开发期遗留实现引入双写、fallback、deprecated 字段、兼容 adapter、宽松联合类型、占位默认值或长期中间状态。
- 类型、Schema、数据库和界面必须同时表达最新语义，不得通过可空字段、空字符串或隐式默认值伪装兼容。
- 只有当改动会影响生产数据、已发布协议或外部系统时，才先说明破坏面并由用户决定迁移方案。

## 界面文案语言

- 除品牌名称、品牌标语，以及登录页固定文案 `the agents is having a party` 外，所有面向用户的界面文案必须使用中文。
- 技术术语、状态、操作名称和提示语应优先使用准确的中文表达，不得为了装饰、风格化或营造“产品感”而夹杂英文。
- 内部代码标识、接口字段、协议枚举和用户自行输入的内容不受此规则限制，但不得直接把内部英文枚举原样展示给用户。
- 新增或修改界面时，必须检查标题、按钮、状态、空状态、提示、表单标签和错误信息中是否残留非必要英文。

## 产品级设计原则

- 所有用户页面都必须根据当前角色、当前任务、内容关系和操作频率组织布局；不得套用通用 Dashboard、后台模板或固定页面原型。
- 页面之间的一致性来自共同的视觉变量、交互规则和设计原则，不来自复制相同的页面结构。
- 保持工业纸张控制台的视觉语言：暖灰纸张、黑色墨水、珊瑚强调色及对应夜间主题；使用硬边框、克制的错位阴影和细颗粒纸张纹理。
- Georgia 斜体只用于品牌或重点展示，等宽字体承担主要信息表达；不得引入紫蓝霓虹、玻璃拟态、柔软圆角 SaaS 卡片墙或另一套视觉体系。
- Less is more：默认只展示完成当前任务必需的信息与操作，一屏保持一个清晰的主操作层级，不重复操作，不用装饰性容器制造虚假层级。
- 高频与低频必须按“当前角色 + 当前页面任务”判断。高频操作就近、直接、少步骤；低频操作不抢占主工作区，但必须有明确入口，并在进入专属上下文后直接可见。
- 技术细节、诊断信息和低频管理信息必须渐进披露；空状态只提供最合理的下一步。
- 删除、撤销等低频高风险操作必须说明后果并要求确认。
- 用户明确认可的具体交互属于产品硬约束；未经再次明确确认，不得在重构中改变其信息关系、操作路径或反馈方式。
- 新增或修改用户界面时，必须验证默认、悬停、焦点、禁用、选中、展开、加载、空状态和错误状态，并确保桌面视口下内容与操作可达；移动端适配不作为视觉验收或交付门。

## Agent 用户概念

- 用户页面、导航、按钮、提示、状态与用户路由统一使用 `Agent`；不得向用户暴露内部 `Runner` 术语。
- 内部代码、数据库、HTTP 协议、包名和领域类型继续使用 `Runner`，不得仅为页面文案进行底层重命名。
- Agent 用户管理路由为 `/cooking/agents`；开发期不保留 `/cooking/runners` 重定向或兼容入口。

## Cooking 页面框架一致性

- `app/cooking/layout.tsx` 必须统一挂载 `features/cooking/presentation/cooking-shell.tsx`；`/cooking`、`/cooking/projects`、`/cooking/agents` 及后续新增的 Cooking 页面天然继承同一品牌区、品牌标语、主题切换、账号菜单、尺寸、间距和响应式行为。
- 禁止具体页面或业务组件再次引用 `CookingShell` 或复制 `.collab-topbar`；头部需求只能修改共享 `CookingShell`，页面只能在 layout 提供的共享头部下渲染自身内容。
- 修改 Cooking 页面框架或头部后，必须在桌面视口下对照验证 `/cooking`、`/cooking/projects` 与 `/cooking/agents`，不得仅凭类型检查、测试或构建成功判定界面一致。
- `features/cooking/presentation/cooking-shell.test.ts` 是该约束的架构回归测试，不得删除或绕过；新增顶层 Cooking 页面时必须加入共享框架消费者断言。

## 按钮交互规范

- 所有面向用户的按钮，以及视觉上作为按钮使用的链接，必须遵守统一的默认态和悬停态，不得在局部组件中另设相互冲突的配色。
- 浅色主题默认态：使用透明背景、深色边框和黑色文字（`var(--ink)`）；不得默认使用主题色背景配白字。
- 悬停态：背景色和边框色统一切换为主题色（`var(--accent)`），按钮内文字与图标统一切换为白色。
- 暗色主题使用同一组语义变量，不硬编码浅色主题的黑色；持久选中、展开和禁用状态可保留各自明确的语义状态。
- 新增或修改按钮时必须复核默认态、悬停态、键盘焦点态、禁用态和持久状态；优先复用全局规则，不通过更高优先级的局部样式破坏一致性。

## 滚动与滚动条规范

- 隐藏滚动条只隐藏轨道和滑块，不得取消滚轮、触控板、键盘或触屏滚动能力。
- 需要承载超出内容的页面、面板和弹窗内容区必须使用 `overflow: auto` 或对应方向的 `overflow-x/overflow-y: auto`。
- 布局应优先通过弹性尺寸、响应式网格和换行适应可用空间；只有内容本身无法合理重排时才使用内部滚动。状态看板等固定数量分栏不得依赖横向滚动展示。
- 不得为了隐藏滚动条而使用 `overflow: hidden`；`overflow: hidden` 只允许用于明确的视觉裁剪，或外层固定、内层已有独立滚动容器的布局。
- 新增弹窗和全屏布局时必须确保内容区仍能滚动到全部内容和操作按钮；不要求为移动端单独适配。
