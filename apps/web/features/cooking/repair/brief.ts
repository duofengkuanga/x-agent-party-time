import type { JsonObject } from '@agent-party-time/execution-contract';

type BriefAttachment = {
  fileId: string;
  originalName: string;
};

export function buildInitialRepairBrief(input: {
  executionId: string;
  workspaceKey: string;
  submissionId: string;
  submissionTitle: string;
  requirementDescription: string;
  engineeringName: string;
  repositoryUrl: string;
  targetBranch: string;
  bugId: string;
  bugTitle: string;
  operationPath: string | null;
  actualResult: string | null;
  expectedResult: string | null;
  actualResultAttachments: BriefAttachment[];
  expectedResultAttachments: BriefAttachment[];
  feedback: string[];
  pendingCommits: string[];
}): JsonObject {
  return {
    executionId: input.executionId,
    workspaceKey: input.workspaceKey,
    testSubmission: {
      id: input.submissionId,
      title: input.submissionTitle,
      requirementDescription: input.requirementDescription,
    },
    engineering: {
      name: input.engineeringName,
      repositoryUrl: input.repositoryUrl,
      targetBranch: input.targetBranch,
    },
    bug: {
      id: input.bugId,
      title: input.bugTitle,
      operationPath: input.operationPath,
      actualResult: input.actualResult,
      expectedResult: input.expectedResult,
      attachments: {
        actualResult: input.actualResultAttachments,
        expectedResult: input.expectedResultAttachments,
      },
    },
    feedback: input.feedback,
    pendingCommits: input.pendingCommits,
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
