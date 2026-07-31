# XAPT-011 — 实现原子更新、Schema 安全与自动回退

**What to build:** 实现 `xapt update` 的稳定 Release 检查、强制校验、空闲切换、Codex 兼容预检、本机 Schema 安全和失败回退，使运行中的 Agent 不会因半完成更新或不可逆状态迁移离线。

**Blocked by:** XAPT-002、XAPT-004、XAPT-008、XAPT-010。

**Status:** blocked

## 用户结果

- 当前版本已是最新时不改文件、不重启 daemon。
- daemon 停止时更新后保持停止；运行且空闲时更新后恢复运行。
- daemon 忙碌或无响应时拒绝更新，不等待、不取消任务。
- 新版本健康检查失败时自动恢复上一个成功二进制和可读取状态。

## 实施范围

- 查询 GitHub 最新稳定 Release，忽略 Draft、Prerelease、beta、RC 和 nightly。
- 拒绝版本参数、降级和本地版本高于稳定版本时的自动切换。
- 复用 XAPT-010 的资产名、SHA 解析和强制校验逻辑。
- 切换前验证目标 xapt 的最低 Codex 版本和当前 Codex initialize 能力。
- 切换前只读验证现有状态；需要 Schema 变化时使用权限受控快照或 copy-on-write。
- 安全停止空闲 daemon，写入新版本目录并原子切换 `current`。
- 启动新 daemon并检查二进制、状态、LaunchAgent、control socket 和 Codex initialize 健康。
- 失败时联合恢复旧二进制、旧状态和原 daemon 运行状态。
- 成功后只保留当前版本和上一个成功版本。

## 非范围

- 不支持指定版本、beta 渠道、nightly、降级或 `update --force`。
- 不因 Server 暂时离线判定新版本不健康。
- 不自动更新 Codex。
- 不允许“二进制回退但本机状态已不可逆升级”的中间状态。

## 验收标准

- 已是最新、本地较新、daemon 停止、daemon 空闲运行、daemon 忙碌和 daemon 无响应均符合 Spec。
- 新 xapt 要求更高 Codex 版本时，在切换前拒绝并保留当前版本。
- 新二进制不可执行、状态不可读、LaunchAgent 启动失败、Socket 无响应或 Codex initialize 失败都会完整回退。
- Server 离线但本机健康检查通过时，更新成功并将连接显示为降级，而不是错误回退。
- 回退后 Outbox 和恢复状态仍可由旧版本读取。
- 成功更新后 `install.json`、current/previous 和实际软链接保持一致。

## 验证

- 使用两个人工版本 Fixture 覆盖成功更新、每个健康检查失败点和状态回退。
- 测试当前/上一版本的 Outbox 与状态双向读取边界。
- 覆盖下载中断、SHA 错误、磁盘写入失败、进程停止超时和回退失败报告。
- 运行 xapt update、daemon、状态 Schema 和安装资产测试。
- GitNexus `detect_changes` 只命中版本管理、更新、状态迁移和 daemon 控制流程。
