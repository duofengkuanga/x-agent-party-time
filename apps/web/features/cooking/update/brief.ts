import type { JsonObject } from '@agent-party-time/execution-contract';

export function buildInitialUpdateBrief(input: {
  executionId: string;
  workspaceKey: string;
  batchId: string;
  submissionId: string;
  submissionTitle: string;
  submissionItemId: string;
  engineeringName: string;
  repositoryUrl: string;
  targetBranch: string;
  environmentName: string;
  entries: Array<{
    bugId: string;
    bugShortId: number;
    bugTitle: string;
    commits: string[];
  }>;
  deployment: { mode: 'CI_CD' } | { mode: 'LOCAL_SCRIPT'; command: string };
}): JsonObject {
  return {
    executionId: input.executionId,
    workspaceKey: input.workspaceKey,
    updateBatchId: input.batchId,
    testSubmission: {
      id: input.submissionId,
      title: input.submissionTitle,
      itemId: input.submissionItemId,
    },
    engineering: {
      name: input.engineeringName,
      repositoryUrl: input.repositoryUrl,
      targetBranch: input.targetBranch,
      environmentName: input.environmentName,
    },
    frozenCandidates: input.entries.map((entry, position) => ({
      position,
      ...entry,
    })),
    deployment: input.deployment,
  };
}

export function buildUpdateRetryInput(): string {
  return '继续完成上次未完成的任务。';
}

export function buildUpdateExternalFailureInput(input: {
  reportRound: number;
  summary: string;
  attachments: Array<{ fileId: string; originalName: string }>;
}): string {
  return `继续处理原 Update Batch。新增外部部署失败事实：${JSON.stringify({
    reportRound: input.reportRound,
    summary: input.summary,
    attachments: input.attachments,
  })}`;
}
