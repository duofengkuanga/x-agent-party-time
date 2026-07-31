# 实施规格

`docs/specs/` 保存已经确认、仍需跨会话实施或验收的 Spec 与 Tickets，并纳入 Git。

## 生命周期

```text
.scratch/<feature>/
  调查、访谈记录、原型、草稿和一次性验收材料
        ↓ 方案确认
docs/specs/<feature>/
  spec.md 与 issues/，作为当前实施约束
        ↓ 实施和验收完成
提炼到 CONTEXT.md、docs/adr/、README.md、正式测试或项目规则
        ↓
删除 docs/specs/<feature>/；历史由 Git 保留
```

## 规则

- 未确认或可随时丢弃的材料不得提前进入本目录。
- 当前 Spec 必须声明状态、范围、非目标、验收标准和真实 blocking edges。
- Ticket 必须是可以独立演示或验证的纵向切片，不按文件层机械拆分。
- 已完成、已取代或不再构成实施约束的 Spec 不在当前文件树中归档。
- 一次性截图、日志、数据库、Seed 和实验脚本保留在 `.scratch/`；具有回归价值的验证代码移入正式测试或 `scripts/`。
