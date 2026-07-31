---
status: accepted
---

# xapt 留在产品 monorepo 内独立发布

xapt 作为独立应用、独立版本和独立 GitHub Release 留在当前 monorepo，目标代码位置是 `apps/xapt/`；`execution-contract` 与 `runner-contract` 继续作为 Web 和 xapt 之间的共享 Interface。开发期协议仍会快速共同演进，同仓允许 Server、Contract、xapt 和端到端测试在一个提交中原子修改，避免过早引入跨仓 Contract 发布、兼容矩阵和协调发布；当协议稳定、维护权或复用场景真正独立后再评估拆仓。
