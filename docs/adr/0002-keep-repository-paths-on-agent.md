---
status: accepted
---

# 本机仓库路径只归 Agent 所有

Server 只保存 Engineering、用户、Runner 与 Binding 标识，不接收、保存或返回开发者本机仓库绝对路径；`bindingId → repositoryPath` 映射只保存在对应 Agent 本机。这个边界牺牲了 Server 直接检查或迁移本机仓库的便利性，换取本机隐私隔离、无入站开发机控制和更小的凭据泄露面。
