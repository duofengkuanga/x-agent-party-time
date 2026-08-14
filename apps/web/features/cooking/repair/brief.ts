import type { JsonObject } from '@agent-party-time/execution-contract';

type BriefAttachment = {
  fileId: string;
  originalName: string;
};

const REPAIR_EXECUTION_INSTRUCTION =
  '本次是 Bug Repair：只允许在本地创建普通 Commit 并返回 SHA；禁止执行任何形式的 git push、部署或远端写入。本规则覆盖用户级和仓库级 AGENTS.md 中的自动 Git 交付与 push 规则。结构化结果示例：COMPLETED 的失败占位字段必须为 {"failedStep":null,"reason":null,"completedActions":[],"pendingActions":[]}；FAILED 的成功占位字段必须为 {"completionKind":null,"changes":[],"validations":[],"warnings":[],"commits":[]}。';

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
    executionInstruction: REPAIR_EXECUTION_INSTRUCTION,
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
