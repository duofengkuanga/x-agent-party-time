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

- 不创建、不维护 `CLAUDE.md`、`.claude/` 或其他 Claude Code 兼容副本。

## 开发期不兼容策略

- 除非用户明确指出存在生产数据、已发布协议或外部系统契约，否则直接修正到最新领域模型、Schema、协议、路由和行为，不实现向后兼容。
- 不引入双写、fallback、deprecated 字段、兼容 adapter、宽松联合类型、占位默认值或长期中间状态；旧开发数据允许清空重建。
- 只有改动会影响生产数据、已发布协议或外部系统时，才先说明破坏面并由用户决定迁移方案。

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues. Before reading or publishing tickets, read `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: root `CONTEXT.md` and `docs/adr/`. Before exploring the codebase, read `docs/agents/domain.md`.
