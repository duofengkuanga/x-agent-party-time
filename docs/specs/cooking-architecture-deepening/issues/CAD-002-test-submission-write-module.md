# CAD-002 — 深化 Test Submission 写入 module

**What to build:** 在通用 CookingWriteStore 之上建立 Test Submission 专用 deep write module，集中 mutation replay、audit、workspace revision 与 exactly-once invalidation。

**Blocked by:** CAD-001.

**Status:** blocked

## 验收标准

- Submission、Bug、Repair、Update Batch、Lifecycle mutation 不再自行查询 replay 或复制 revision SQL。
- replay 不重复 audit、revision 或 invalidation。
- transaction 失败不发布 invalidation。
- Project、Engineering 与 Binding 继续使用不含 Test Submission 规则的通用 write module。
- 现有领域结果与错误语义不变。

## 验证

- deep write module contract tests。
- Submission、Bug、Repair、Update、Lifecycle mutation tests。
- SSE revision/invalidation tests。

