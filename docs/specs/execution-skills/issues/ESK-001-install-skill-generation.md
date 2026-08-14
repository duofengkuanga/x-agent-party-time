# ESK-001 安装原子 Skill generation

状态：已实施，待用户验收

## 用户结果

用户完成 xapt 初始化或运行 `xapt skills update` 后，Codex 可以发现并显式调用同一次安装中的两个 Agent Party Time Skill。失败的更新不改变当前 Skill。

## 范围

- 在 `x-skills` 为两个 Skill 提供静态检查、可执行 eval 和合入 `main` 的 CI 门。
- 在 xapt 实现固定 GitHub 仓库和 `main` Commit 下载。
- 实现确定性 Bundle Hash、Bundle Store、generation 清单和单一命名空间软链接切换。
- 在 xapt 初始化中执行非阻塞首次安装。
- 提供显式 `xapt skills update`。
- 拒绝 Bundle 内软链接和用户目录冲突。
- 不实现签名、自动更新、自动清理或 prune。

## 验收标准

- 两个 Skill 通过 Codex Skill validator、静态策略检查和无外部副作用的可执行 eval。
- `main` 的 CI 在任一检查失败时失败。仓库管理员单独配置分支保护，要求该 CI 通过后才能合入。
- 首次安装成功后，`~/.agents/skills/x-agent-party-time` 是指向完整 generation 的软链接。
- generation 清单包含 `sourceRevision` 和两个 Bundle Hash。
- 两个 Skill 中任意一个无效时不切换当前 generation。
- 相同内容在不同 Commit 下产生相同 Bundle Hash。
- GitHub 不可用时，xapt 其他初始化继续完成，并报告 Skill 未安装。

## Blocking edges

无。
