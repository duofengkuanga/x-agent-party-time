---
status: accepted
---

# xapt 作为当前用户 daemon 并独占连接状态

xapt 在当前 macOS 用户范围内通过 LaunchAgent 长期运行，不需要 root 权限，关闭终端或重新登录后仍可等待任务。daemon 是 Server Credential、连接配置、心跳和重连状态的唯一读写者；CLI 只通过当前用户私有的本机控制 Interface 提交命令，首次使用先启动 daemon，再由运行中的 daemon 发起浏览器授权，避免 CLI 与后台进程共同修改敏感状态。
