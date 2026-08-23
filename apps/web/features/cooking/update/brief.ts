import type { JsonObject } from '@agent-party-time/execution-contract';

export function buildInitialUpdateBrief(input: {
  targetBranch: string;
  environmentName: string;
  entries: Array<{
    bugTitle: string;
    commits: string[];
  }>;
  deployment: { mode: 'CI_CD' } | { mode: 'LOCAL_SCRIPT'; command: string };
}): JsonObject {
  return {
    targetBranch: input.targetBranch,
    environment: input.environmentName,
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
