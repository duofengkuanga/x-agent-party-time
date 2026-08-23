import type { JsonObject } from '@agent-party-time/execution-contract';

type BriefAttachment = {
  fileId: string;
  originalName: string;
  role: 'ACTUAL_RESULT' | 'EXPECTED_RESULT';
};

export function buildInitialRepairBrief(input: {
  targetBranch: string;
  bugTitle: string;
  operationPath: string | null;
  actualResult: string | null;
  expectedResult: string | null;
  attachments: BriefAttachment[];
  feedback: string[];
  pendingCommits: string[];
}): JsonObject {
  return {
    targetBranch: input.targetBranch,
    bug: {
      title: input.bugTitle,
      ...(input.operationPath ? { operationPath: input.operationPath } : {}),
      ...(input.actualResult ? { actualResult: input.actualResult } : {}),
      ...(input.expectedResult ? { expectedResult: input.expectedResult } : {}),
    },
    ...(input.attachments.length
      ? { attachmentReferences: input.attachments }
      : {}),
    ...(input.feedback.length ? { feedback: input.feedback } : {}),
    ...(input.pendingCommits.length
      ? { pendingCommits: input.pendingCommits }
      : {}),
  };
}

export function buildRepairContinuationInput(input: {
  lifecycleContext?: string;
}): string {
  if (!input.lifecycleContext) return '继续完成上次未完成的任务。';
  return `继续完成上次未完成的任务。新增事实：${JSON.stringify({
    lifecycleContext: input.lifecycleContext,
  })}`;
}
