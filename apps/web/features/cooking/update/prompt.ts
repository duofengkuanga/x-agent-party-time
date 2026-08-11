import { createHash } from 'node:crypto';
import type { JsonObject } from '@agent-party-time/execution-contract';
import {
  CiCdUpdateOutputJsonSchema,
  LocalScriptUpdateOutputJsonSchema,
} from './contract';

export const LOCAL_SCRIPT_UPDATE_PROMPT_KIND = 'cooking.update.local-script';
export const LOCAL_SCRIPT_UPDATE_PROMPT_VERSION = 4;
export const CI_CD_UPDATE_PROMPT_KIND = 'cooking.update.ci-cd';
export const CI_CD_UPDATE_PROMPT_VERSION = 4;

const QUALITY_GATE_RULES = `- 质量门以仓库内明确文档和与本次变更直接相关的检查为准；不得仅因 package.json 中存在某个 script 就把它视为必跑质量门。
- 执行前确认命令及其配置确实适用于当前工程；例如 tsc 没有 tsconfig.json、jsconfig.json、显式输入文件或仓库明确要求时应记为 SKIPPED 并在 warnings 说明，不得据此判定失败。`;

const STABLE_PREFIX = `你是本机仓库中的统一更新执行者。请遵守仓库内 AGENTS.md 等规则，原子集成本批全部候选提交。

安全与执行边界：
- 在独立 Detached HEAD Integration Worktree 中基于目标分支最新远端状态工作。
- 严格按冻结顺序集成每个候选 Commit，不得遗漏、拆批、squash、amend、rebase 或改写历史。
- 解决冲突后运行仓库规则要求的测试和构建；任何一项失败都返回 FAILED。
${QUALITY_GATE_RULES}
- 验证通过后只允许普通 push，禁止 force push。
- 不得伪造 Commit、测试、Push、部署或执行结果。
- 如需验证网页功能，跳过浏览器验证，不启动或等待浏览器验证流程；改用代码级测试、静态检查或其他无需浏览器的验证方式。
- 成功结果必须返回 completedActions、validations 和 warnings；失败结果必须返回 failedStep、reason、completedActions 和 pendingActions。
- 最终只返回符合输出 Schema 的 JSON。`;

export type UpdatePromptInput = {
  workspaceKey: string;
  submissionTitle: string;
  engineeringName: string;
  repositoryUrl: string;
  targetBranch: string;
  environmentName: string;
  entries: Array<{
    bugShortId: number;
    bugTitle: string;
    commits: string[];
  }>;
};

export type LocalScriptUpdatePromptInput = UpdatePromptInput & {
  deploymentCommand: string;
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
  return snapshot(
    LOCAL_SCRIPT_UPDATE_PROMPT_KIND,
    LOCAL_SCRIPT_UPDATE_PROMPT_VERSION,
    LocalScriptUpdateOutputJsonSchema as JsonObject,
    `${STABLE_PREFIX}
- 普通 push 成功后执行给定 LOCAL_SCRIPT；脚本失败返回 FAILED。

${batchDetails(input)}
- LOCAL_SCRIPT：${input.deploymentCommand}

完成完整集成、验证、普通 Push 和 LOCAL_SCRIPT 后返回结构化结果。`,
  );
}

export function buildInitialCiCdUpdatePrompt(
  input: UpdatePromptInput,
): UpdatePromptSnapshot {
  return snapshot(
    CI_CD_UPDATE_PROMPT_KIND,
    CI_CD_UPDATE_PROMPT_VERSION,
    CiCdUpdateOutputJsonSchema as JsonObject,
    `${STABLE_PREFIX}
- 本次部署方式为 CI/CD：只负责完成集成、验证和普通 Push。
- Push 成功必须返回 PUSHED；PUSHED 不代表 Pipeline 或部署成功。
- 不得轮询、猜测或伪造外部 Pipeline 结果。

${batchDetails(input)}

完成完整集成、验证和普通 Push 后返回结构化结果；外部结果由工程负责人另行报告。`,
  );
}

export function buildRetryLocalScriptUpdatePrompt(): UpdatePromptSnapshot {
  return retrySnapshot(
    LOCAL_SCRIPT_UPDATE_PROMPT_KIND,
    LOCAL_SCRIPT_UPDATE_PROMPT_VERSION,
    LocalScriptUpdateOutputJsonSchema as JsonObject,
    '重新执行原批次，继续完成集成、验证、普通 Push 和 LOCAL_SCRIPT',
  );
}

export function buildRetryCiCdUpdatePrompt(): UpdatePromptSnapshot {
  return retrySnapshot(
    CI_CD_UPDATE_PROMPT_KIND,
    CI_CD_UPDATE_PROMPT_VERSION,
    CiCdUpdateOutputJsonSchema as JsonObject,
    '重新执行原批次，继续完成集成、验证和普通 Push；PUSHED 仍只表示等待外部确认',
  );
}

export function buildContinuationCiCdUpdatePrompt(input: {
  reportRound: number;
  summary: string;
  attachmentNames: string[];
}): UpdatePromptSnapshot {
  const attachmentLine = input.attachmentNames.length
    ? `\n新增证据附件：${input.attachmentNames.join('、')}`
    : '';
  return snapshot(
    CI_CD_UPDATE_PROMPT_KIND,
    CI_CD_UPDATE_PROMPT_VERSION,
    CiCdUpdateOutputJsonSchema as JsonObject,
    `临时补充执行约束：如需验证网页功能，跳过浏览器验证，不启动或等待浏览器验证流程；改用代码级测试、静态检查或其他无需浏览器的验证方式。

${QUALITY_GATE_RULES}

继续当前统一更新批次。冻结的缺陷、Commit、顺序、分支和环境保持不变。

第 ${input.reportRound} 轮外部部署失败：${input.summary}${attachmentLine}

根据新增外部失败证据修正原批次，并重新完成验证和普通 Push；不得拆批、跳过候选、force push 或改写历史，最终只返回符合既定 Schema 的 JSON。`,
  );
}

function batchDetails(input: UpdatePromptInput): string {
  return `本次冻结批次：
- 逻辑工作区：${input.workspaceKey}
- 提测单：${input.submissionTitle}
- 工程：${input.engineeringName}
- 仓库逻辑地址：${input.repositoryUrl}
- 目标分支：${input.targetBranch}
- 环境：${input.environmentName}

冻结候选（顺序不可改变）：
${input.entries
  .map(
    (entry, index) =>
      `${index + 1}. 缺陷-${String(entry.bugShortId).padStart(3, '0')} ${entry.bugTitle}\n   Commits: ${entry.commits.join(', ')}`,
  )
  .join('\n')}`;
}

function retrySnapshot(
  kind: string,
  version: number,
  outputJsonSchema: JsonObject,
  instruction: string,
): UpdatePromptSnapshot {
  return snapshot(
    kind,
    version,
    outputJsonSchema,
    `临时补充执行约束：如需验证网页功能，跳过浏览器验证，不启动或等待浏览器验证流程；改用代码级测试、静态检查或其他无需浏览器的验证方式。

${QUALITY_GATE_RULES}

继续当前统一更新批次。冻结的缺陷、Commit、顺序、分支和环境保持不变。

上一轮结构化失败结果已经保留在当前 Session 中。${instruction}；不得拆批、跳过候选、force push 或改写历史，最终只返回符合既定 Schema 的 JSON。`,
  );
}

function snapshot(
  kind: string,
  version: number,
  outputJsonSchema: JsonObject,
  renderedPrompt: string,
): UpdatePromptSnapshot {
  return {
    kind,
    version,
    renderedPrompt,
    renderedPromptHash: createHash('sha256')
      .update(renderedPrompt)
      .digest('hex'),
    outputJsonSchema,
  };
}
