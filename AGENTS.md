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

- 本项目只使用 Codex；根 `AGENTS.md` 是项目规则入口，目录内可使用更近的 `AGENTS.md` 收紧该范围规则，项目 skill 只放在 `.agents/`。
- 不创建、不维护 `CLAUDE.md`、`.claude/` 或其他 Claude Code 兼容副本。
- GitNexus 索引更新只使用 `node .gitnexus/run.cjs analyze --index-only`，避免覆盖项目规则或注入其他工具副本。
- `.agents/` 与各级 `AGENTS.md` 纳入 Git；`.gitnexus/` 是本地索引，不提交。
- 修改 `apps/web/` 下的文件时同时遵守 `apps/web/AGENTS.md`。

## 文档职责

- `CONTEXT.md` 只保存稳定领域术语和概念边界，不记录实现细节、计划或进度。
- `docs/adr/` 只记录难反转、缺少上下文会令人意外、且经过真实取舍的重要架构决策。
- `docs/specs/` 保存已经确认、仍需跨会话实施或验收的 Spec 与 Tickets；完成后提炼长期结论并删除当前文件，历史由 Git 保留。
- `docs/product/` 保存长期产品和设计语言；对应目录的 `AGENTS.md` 只保留强制摘要和读取入口。
- `.scratch/` 只保存未确认、一次性或可丢弃的调查、草稿、原型和验收材料；完成或被取代后必须蒸馏并清理，不建立历史归档。
- `README.md` 保存项目能力、安装、运行、开发和使用说明。

## 开发期不兼容策略

- 除非用户明确指出存在生产数据、已发布协议或外部系统契约，否则直接修正到最新领域模型、Schema、协议、路由和行为，不实现向后兼容。
- 不引入双写、fallback、deprecated 字段、兼容 adapter、宽松联合类型、占位默认值或长期中间状态；旧开发数据允许清空重建。
- 只有改动会影响生产数据、已发布协议或外部系统时，才先说明破坏面并由用户决定迁移方案。

## 全局架构边界

- Runner 只承载领域无关的本机 Execution，不实现 Cooking 业务状态机或仓库工作流；背景见 `docs/adr/0001-keep-runner-domain-neutral.md`。
- Server 不接收、保存或返回开发者本机仓库绝对路径；路径映射只存在于对应 Agent 本机；背景见 `docs/adr/0002-keep-repository-paths-on-agent.md`。
- 用户界面使用 `Agent`，内部代码、数据库和协议继续使用 `Runner`；统一语言见 `CONTEXT.md`。
