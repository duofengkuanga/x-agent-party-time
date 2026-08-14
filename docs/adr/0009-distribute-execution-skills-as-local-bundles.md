---
status: accepted
---

# 将执行 Skill 作为本机 Bundle 独立分发

Repair 和 Update 的稳定 Codex 流程放在独立的 `x-skills` 仓库，由 xapt 在用户本机安装为内容寻址的 Skill Bundle，并通过 `~/.agents/skills/x-agent-party-time/` 下的软链接供 Codex 发现。Server 只指定 Skill 名称并保存实际 `bundleHash` 和 `sourceRevision`，不保存 Skill 全文或本机路径；同一 Codex Task 固定使用首次绑定的 Bundle。该方案使 Skill 可以独立更新，并保持旧 Task 可恢复，但要求 xapt 管理本机 Bundle Store，并暂时保留不再作为当前入口的旧 Bundle。

## Considered options

- 将 Skill 随 Server 发布：Skill 未变化时仍与 Server 发布耦合。
- 由 Server 为每次 Execution 下发 Skill：重复传输和存储，并使 Server 了解本机 Skill 文件。
- 将 Skill 复制到每个 Session：重复占用空间，并增加清理和一致性处理。

## Consequences

- Skill 更新由用户显式运行 `xapt skills update`。
- `main` 的 Git Commit 和每个 Skill 的内容 Hash 提供身份，不增加 Skill 版本号。
- 第一版不做签名验证、自动更新或旧 Bundle 自动清理。
