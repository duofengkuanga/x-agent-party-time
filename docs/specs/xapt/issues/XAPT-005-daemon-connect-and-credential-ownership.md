# XAPT-005 — 让 daemon 独占 Server 连接与 Credential

**What to build:** 实现 `xapt daemon connect <server-url>` 的浏览器授权闭环，使运行中的 daemon 成为连接配置、Runner Credential、心跳连接状态和重新授权的唯一所有者，CLI 只通过本机 control socket 提交请求并渲染结果。

**Blocked by:** XAPT-004。

**Status:** blocked

## 用户结果

- 用户启动 daemon 后，可以通过一条 connect 命令打开浏览器并完成 Agent 授权。
- 浏览器无法自动打开时，CLI 返回可复制 URL，不丢失当前授权请求。
- 同一 Server 的健康重复连接幂等；Credential 被撤销后可重新授权。
- 已连接另一 Server 时明确拒绝，不隐式删除或切换现有连接。

## 实施范围

- 规范化并验证 HTTP/HTTPS Server URL，保存规范化 Origin。
- CLI 通过 control socket 请求 daemon 创建 verifier、短指纹和授权请求。
- daemon 打开系统浏览器，并向 CLI 报告成功、拒绝、过期、超时和浏览器打开失败。
- 授权成功后将非秘密连接元数据写入 `connection.json`，Credential 原文写入 Keychain。
- daemon 启动或重连时从 Keychain 读取 Credential；CLI 不读取 Keychain。
- 建立连接中、已连接、降级、已撤销状态和最近心跳时间的 Projection。
- connect 期间 Activity 为 BUSY，阻止 stop、update 和 uninstall。
- 对相同 Server 的失效 Credential 支持重新授权；不同 Server 必须拒绝。

## 非范围

- 不提供 profile、disconnect、Server 切换或多 Server。
- 不通过 CLI 参数、环境变量、JSON 或日志传递 Credential。
- 不领取 Binding 或 Execution；这些属于后续 Ticket。
- 不实现卸载时的远程自撤销。

## 验收标准

- 完整授权成功后，Server 只保存 Credential Hash，本机 JSON 不含 Credential 原文。
- connect 在 daemon 未运行时失败，不隐式执行 start。
- 相同 Server 已健康连接时不创建新 Credential；已撤销时可发起新授权。
- 不同 Server 已连接时不修改现有连接、Credential 或心跳状态。
- 授权拒绝、过期、网络错误、浏览器错误和 daemon 重启均不会留下无法解释的半连接状态。
- CLI 和 daemon 日志经过秘密扫描，不包含 verifier、Credential、完整内部 ID 或本机路径。

## 验证

- CLI/control/daemon 授权状态矩阵单测。
- 使用 Fake Keychain 和 Fake Browser 验证秘密所有权和浏览器回退。
- 使用真实测试 Server 完成一次授权、心跳、撤销和重新授权集成测试。
- 运行 Server 授权、Runner Contract、xapt daemon 和类型检查。
- GitNexus `detect_changes` 只命中授权、连接、状态与必要 Contract 流程。
