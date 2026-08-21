# Agent Party Time

Agent Party Time 将私密项目中的测试交付活动，与开发者本机 Agent 执行的 Codex 工作连接成可恢复的协作闭环。

## 协作边界

**Project**:
成员、工程和提测单的私密协作边界。
_Avoid_: Workspace、团队空间

**Engineering**:
一个可以独立绑定、提测和交付的代码仓库；前端、后端、移动端或基础设施是工程归属，不是不同领域对象。
_Avoid_: Repository、代码库

**Test Submission**:
一次已经确定参与者、工程、目标分支、环境和部署配置的测试交付周期。
_Avoid_: Test Run、测试任务

**Submission Item**:
Test Submission 中某个 Engineering 的执行快照，固定该工程本次交付使用的负责人、Binding、目标分支、环境和部署方式。
_Avoid_: Engineering、子任务

## 本机执行

**xapt**:
安装在用户 Mac 上的 CLI 与后台运行程序，负责连接、运行和诊断本机执行能力；xapt 是工具，不是领域中的 Agent。
_Avoid_: Agent、Runner CLI、Agent CLI

**Agent**:
用户在产品中看到的已连接本机执行节点，由本机 xapt 运行并向 Server 表达在线状态。
_Avoid_: xapt、Runner、Worker

**Agent Installation**:
一份 xapt 安装在正式卸载前保持稳定的本机身份；重新授权、更新或删除连接状态不会创建新的 Agent，正式卸载后重新安装才是新的安装身份。
_Avoid_: Connection、Credential、设备名

**Runner**:
Agent 的内部技术名称，只用于代码、数据库、协议和包；不得作为用户界面术语。
_Avoid_: Agent（仅在内部技术语境中）

**Binding**:
Engineering、工程成员、Agent 与本机 Git 仓库之间的绑定关系；本机仓库位置属于 Agent，不属于 Server。
_Avoid_: Path、Runner Binding

**Execution**:
与 Cooking 业务无关的一次本机 Codex 执行尝试，承载领取、租约、会话、交互和结果。
_Avoid_: Repair、Task、Job

**Execution Brief**:
一次 Execution 首次启动 Codex Task 时提供的结构化事实快照；稳定执行规则属于 Skill，后续 Turn 只补充继续指令或新增事实。
_Avoid_: Prompt、Rendered Prompt

**Skill Bundle**:
xapt 安装在用户本机、由内容 Hash 标识的一份不可变 Codex Skill 文件集合。
_Avoid_: Skill Version、Prompt Version

**Task Skill Binding**:
一个 Codex Task 与首次调用的 Skill Bundle 之间的固定关联；Task 后续 Turn 和恢复继续使用同一 Bundle。
_Avoid_: Binding、Latest Skill

**Interaction**:
Execution 过程中 Codex 明确请求用户输入或权限决定的等待点。
_Avoid_: Feedback、Chat Message

**External Session Continuation**:
开发者在平台外使用既有 Session ID 继续某个 Repair 或 Update Codex Session 的行为；平台仅向工程负责人展示可复制的 Session ID，不展示或生成恢复命令。它仅替代失败后的“重新执行修复”和“重新执行统一更新”入口；会话期间平台保持此前失败状态，工程负责人可显式同步。验证不通过后的返修与已完成 Bug 的重新打开仍由平台携带新反馈，自动在原 Repair Session 中创建下一 Turn。
_Avoid_: Platform Retry、Manual Repair Node

**External Session Attempt**:
由 xapt 在 Session Synchronization 读取并校验结构化结果后，自动追加的 Repair 或 Update 尝试记录；它保留此前失败记录，不覆盖历史。
_Avoid_: Corrected Attempt、Overwritten Failure

**Session Synchronization**:
工程负责人触发的只读同步操作：xapt 读取指定 Codex Session 的最新结果并回报平台。它不启动或继续 Codex、不修改业务代码；仅有效的现有 Repair 或 Update Schema 可以推进业务状态。
_Avoid_: Retry、Resume、Manual Repair Node

## 缺陷交付

**Bug**:
测试负责人在 Test Submission 中报告的实际结果与预期结果之间的偏差。
_Avoid_: Issue、Ticket

**Repair Attempt**:
针对一个 Bug 的一次 Codex 修复尝试；再次执行会产生新的 Attempt，而不是重置已有记录。
_Avoid_: Execution、Repair Task

**Update Batch**:
同一 Submission Item 中一组待更新 Bug 在一个冻结时刻形成的原子集成、Push 和部署单位。
_Avoid_: Deployment、Release

**Verification**:
测试负责人对已更新 Bug 作出通过或失败判断的一次记录。
_Avoid_: Test Result、Review

**Cleanup**:
业务状态结束后，对 Agent 本机临时 Workspace、分支、引用、Session 或 artifact 执行的幂等技术善后。
_Avoid_: Close、Cancel、Delete
