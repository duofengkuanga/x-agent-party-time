import { createHash } from 'node:crypto';
import type { JsonObject } from '@agent-party-time/execution-contract';
import { CleanupOutputJsonSchema } from './contract';

export const CLEANUP_PROMPT_KIND = 'cooking.cleanup';
export const CLEANUP_PROMPT_VERSION = 1;

const PREFIX = `这是 Runner 本机资源清理任务的不可变元数据。实际清理由 Runner 的隔离工作区管理器执行，不启动 Codex 会话。

安全边界：
- 只处理明确列出的逻辑工作区键，不得删除目标仓库、目标分支、用户已有 Worktree、未提交工作或无关文件。
- 资源已经不存在时视为幂等成功。
- 不得 force push、改写历史、删除远端分支或伪造结果。
- 无法确认安全边界时由 Runner 终止任务并记录失败。`;

export type CleanupPromptSnapshot = {
  kind: string;
  version: number;
  renderedPrompt: string;
  renderedPromptHash: string;
  outputJsonSchema: JsonObject;
};

export function buildInitialCleanupPrompt(input: {
  reason: 'BUG_CANCELLED' | 'SUBMISSION_CLOSED';
  submissionTitle: string;
  engineeringName: string;
  targetBranch: string;
  workspaceKeys: string[];
}): CleanupPromptSnapshot {
  return snapshot(`${PREFIX}

本次清理：
- 原因：${input.reason === 'SUBMISSION_CLOSED' ? '提测单关闭' : '缺陷取消'}
- 提测单：${input.submissionTitle}
- 工程：${input.engineeringName}
- 目标分支：${input.targetBranch}
- 逻辑工作区键：
${input.workspaceKeys.map((key) => `  - ${key}`).join('\n')}

Runner 将逐项确认并清理这些临时资源；不存在的资源按成功处理。`);
}

export function buildContinuationCleanupPrompt(): CleanupPromptSnapshot {
  return snapshot(`${PREFIX}

重试原 Cleanup 范围。清理范围保持不变，只处理上次未安全完成的项目；已不存在的资源按成功处理。`);
}

function snapshot(renderedPrompt: string): CleanupPromptSnapshot {
  return {
    kind: CLEANUP_PROMPT_KIND,
    version: CLEANUP_PROMPT_VERSION,
    renderedPrompt,
    renderedPromptHash: createHash('sha256')
      .update(renderedPrompt)
      .digest('hex'),
    outputJsonSchema: CleanupOutputJsonSchema as JsonObject,
  };
}
