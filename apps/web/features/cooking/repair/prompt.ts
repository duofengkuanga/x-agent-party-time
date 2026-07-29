import { createHash } from 'node:crypto';
import type { JsonObject } from '@agent-party-time/execution-contract';
import { RepairOutputJsonSchema } from './contract';

export const REPAIR_PROMPT_KIND = 'cooking.repair';
export const REPAIR_PROMPT_VERSION = 2;

const STABLE_PREFIX = `你是本机仓库中的修复执行者。请只处理本次给出的缺陷，遵守仓库内 AGENTS.md 等规则。

安全与执行边界：
- 先阅读仓库规则和相关实现，再做最小、可验证的修复。
- 可以使用 Codex 自身工具检查代码、运行必要测试并创建普通本地 Git Commit。
- 不得 push、部署、改写历史、squash、amend、rebase 或清理无关内容。
- 不得伪造测试、Commit 或执行结果。
- 成功时不得留下属于本缺陷的未提交修改，必须返回按创建顺序排列的非空 Commit SHA。
- 成功时还要逐项返回修改内容、检查结果和警告；没有警告时返回空数组。
- 无法安全完成时返回 FAILED，并明确失败阶段、原因、已完成事项和未执行事项，不得编造 Commit。
- 输出始终包含 Schema 中的全部字段。COMPLETED 时 failedStep、reason 为 null，completedActions、pendingActions 为空数组；FAILED 时 changes、validations、warnings、commits 为空数组。
- 最终只返回符合输出 Schema 的 JSON。`;

export type InitialRepairPromptInput = {
  workspaceKey: string;
  submissionTitle: string;
  requirementDescription: string;
  engineeringName: string;
  repositoryUrl: string;
  targetBranch: string;
  bugTitle: string;
  operationPath?: string;
  actualResult?: string;
  expectedResult?: string;
  notes?: string;
  feedback: string[];
  pendingCommits: string[];
};

export type RepairPromptSnapshot = {
  kind: string;
  version: number;
  renderedPrompt: string;
  renderedPromptHash: string;
  outputJsonSchema: JsonObject;
};

export function buildInitialRepairPrompt(
  input: InitialRepairPromptInput,
): RepairPromptSnapshot {
  const renderedPrompt = `${STABLE_PREFIX}

本次修复上下文：
- 逻辑工作区：${input.workspaceKey}
- 提测单：${input.submissionTitle}
- 需求：${input.requirementDescription}
- 工程：${input.engineeringName}
- 仓库逻辑地址：${input.repositoryUrl}
- 目标分支：${input.targetBranch}
- 缺陷标题：${input.bugTitle}
${optionalLine('操作路径', input.operationPath)}
${optionalLine('实际结果', input.actualResult)}
${optionalLine('预期结果', input.expectedResult)}
${optionalLine('补充说明', input.notes)}
- 已有候选 Commit：${input.pendingCommits.join(', ') || '无'}
- 新增反馈：${input.feedback.join('\n  - ') || '无'}

请完成修复、验证并创建普通本地 Commit，然后返回结构化结果。`;
  return snapshot(renderedPrompt);
}

export function buildContinuationRepairPrompt(input: {
  lifecycleContext?: string;
  pendingCommits: string[];
}): RepairPromptSnapshot {
  return snapshot(`重新执行当前修复 Session。沿用原缺陷报告、历史上下文和已经解决的 Interaction，不要求用户补充文本。

${input.lifecycleContext ? `- 生命周期上下文：${input.lifecycleContext}\n` : ''}
- 当前待更新候选 Commit：${input.pendingCommits.join(', ') || '无'}

请重新检查未完成原因，继续修复、验证并创建新的普通本地 Commit；最终只返回符合既定 Schema 的 JSON。`);
}

function snapshot(renderedPrompt: string): RepairPromptSnapshot {
  return {
    kind: REPAIR_PROMPT_KIND,
    version: REPAIR_PROMPT_VERSION,
    renderedPrompt,
    renderedPromptHash: createHash('sha256')
      .update(renderedPrompt)
      .digest('hex'),
    outputJsonSchema: RepairOutputJsonSchema as JsonObject,
  };
}

function optionalLine(label: string, value?: string): string {
  return value ? `- ${label}：${value}` : '';
}
