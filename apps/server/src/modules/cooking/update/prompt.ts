import { createHash } from 'node:crypto';
import type { JsonObject } from '@agent-party-time/execution-contract';
import { LocalScriptUpdateOutputJsonSchema } from './contract';

export const LOCAL_SCRIPT_UPDATE_PROMPT_KIND = 'cooking.update.local-script';
export const LOCAL_SCRIPT_UPDATE_PROMPT_VERSION = 1;

const STABLE_PREFIX = `你是本机仓库中的统一更新执行者。请遵守仓库内 AGENTS.md 等规则，原子集成本批全部候选提交。

安全与执行边界：
- 在独立逻辑 Integration Workspace 中基于目标分支最新远端状态工作。
- 严格按冻结顺序集成每个候选 Commit，不得遗漏、拆批、squash、amend、rebase 或改写历史。
- 解决冲突后运行仓库规则要求的测试和构建；任何一项失败都返回 FAILED。
- 验证通过后只允许普通 push，禁止 force push。
- 普通 push 成功后执行给定 LOCAL_SCRIPT；脚本失败返回 FAILED。
- 不得伪造 Commit、测试、Push、脚本或执行结果。
- 最终只返回符合输出 Schema 的 JSON。`;

export type LocalScriptUpdatePromptInput = {
  workspaceKey: string;
  submissionTitle: string;
  engineeringName: string;
  repositoryUrl: string;
  targetBranch: string;
  environmentName: string;
  deploymentCommand: string;
  entries: Array<{
    bugShortId: number;
    bugTitle: string;
    commits: string[];
  }>;
};

export type UpdatePromptSnapshot = {
  kind: string;
  version: number;
  renderedPrompt: string;
  renderedPromptHash: string;
  outputJsonSchema: JsonObject;
};

export function buildInitialLocalScriptUpdatePrompt(
  input: LocalScriptUpdatePromptInput,
): UpdatePromptSnapshot {
  return snapshot(`${STABLE_PREFIX}

本次冻结批次：
- 逻辑工作区：${input.workspaceKey}
- 提测单：${input.submissionTitle}
- 工程：${input.engineeringName}
- 仓库逻辑地址：${input.repositoryUrl}
- 目标分支：${input.targetBranch}
- 环境：${input.environmentName}
- LOCAL_SCRIPT：${input.deploymentCommand}

冻结候选（顺序不可改变）：
${input.entries
  .map(
    (entry, index) =>
      `${index + 1}. 缺陷-${String(entry.bugShortId).padStart(3, '0')} ${entry.bugTitle}\n   Commits: ${entry.commits.join(', ')}`,
  )
  .join('\n')}

完成完整集成、验证、普通 Push 和 LOCAL_SCRIPT 后返回结构化结果。`);
}

export function buildContinuationLocalScriptUpdatePrompt(input: {
  content: string;
}): UpdatePromptSnapshot {
  return snapshot(`继续当前 Update Batch Session。冻结的 Bug、Commit、顺序、分支和环境保持不变。

只处理以下增量信息：
${input.content}

继续完成原批次；不得拆批、跳过候选、force push 或改写历史，最终只返回符合既定 Schema 的 JSON。`);
}

function snapshot(renderedPrompt: string): UpdatePromptSnapshot {
  return {
    kind: LOCAL_SCRIPT_UPDATE_PROMPT_KIND,
    version: LOCAL_SCRIPT_UPDATE_PROMPT_VERSION,
    renderedPrompt,
    renderedPromptHash: createHash('sha256')
      .update(renderedPrompt)
      .digest('hex'),
    outputJsonSchema: LocalScriptUpdateOutputJsonSchema as JsonObject,
  };
}
