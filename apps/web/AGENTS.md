# Web 应用规则

本文件适用于 `apps/web/` 下的 App Router、Cooking Features、Server、脚本、样式和测试；根目录 `AGENTS.md` 仍然生效。

## 用户界面

- 新增或修改用户界面前读取并遵守 `docs/product/web-design-system.md`。
- 除品牌名称、品牌标语和登录页固定文案 `the agents is having a party` 外，面向用户的文案使用中文。
- 状态、操作、提示和错误不得直接展示内部英文枚举、数据库术语或不必要英文。
- 用户页面、导航、按钮、提示、状态和用户路由使用 `Agent`；内部代码、数据库、HTTP 协议、包名和领域类型继续使用 `Runner`。
- Agent 用户管理路由是 `/cooking/agents`；开发期不保留 `/cooking/runners` 重定向或兼容入口。

## 产品与交互

- 页面根据当前角色、任务、内容关系和操作频率组织，不套用通用 Dashboard、后台模板或另一套视觉体系。
- 复用全局视觉变量、按钮和交互规则，不通过更高优先级局部样式建立冲突配色。
- 高频操作就近、直接、少步骤；低频技术或管理信息渐进披露；空状态只提供最合理的下一步。
- 删除、撤销等高风险操作必须说明后果并要求确认。
- 未经用户再次确认，不改变已经认可的信息关系、操作路径或反馈方式。

## Cooking 页面框架

- `app/cooking/layout.tsx` 统一挂载 `features/cooking/presentation/cooking-shell.tsx`；所有顶层 Cooking 页面必须继承该共享品牌区、主题切换、账号菜单、尺寸和间距。
- 页面或业务组件不得再次引用 `CookingShell` 或复制 `.collab-topbar`；头部需求只修改共享 Shell。
- 修改 Cooking 框架或头部后，在桌面视口对照验证 `/cooking`、`/cooking/projects` 和 `/cooking/agents`。
- `features/cooking/presentation/cooking-shell.test.ts` 是架构回归测试，不得删除或绕过；新增顶层 Cooking 页面时加入消费者断言。

## 状态与可达性

- 新增或修改操作必须检查默认、悬停、键盘焦点、禁用和持久状态；详细颜色和状态规则见产品设计文档。
- 超出内容使用可滚动容器；隐藏滚动条不得取消滚轮、触控板、键盘或触屏滚动。
- 不用 `overflow: hidden` 代替滚动；弹窗和全屏布局必须能够到达全部内容和操作。
- 固定数量的状态看板分栏不得依赖横向滚动展示。

## 验收

- 用户界面改动必须验证默认、悬停、焦点、禁用、选中、展开、加载、空状态和错误状态。
- 明暗主题及桌面视口下的内容与操作必须可达；移动端单独适配不作为当前交付门。
- 修改 Cooking 页面框架时除自动化检查外，还必须完成三个顶层页面的浏览器对照验证。
