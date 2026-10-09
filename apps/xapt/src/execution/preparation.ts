import {
  serializeDeterministicJson,
  type ClaimedExecution,
  type ExecutionFailure,
  type ExecutionResultAssertion,
  type JsonObject,
  type JsonValue,
} from '@agent-party-time/execution-contract';
import Ajv from 'ajv';
import { createHash } from 'node:crypto';
import type { AuthenticatedRunnerSession } from '../agent/connection';
import type { CodexExecutor } from '../codex/contract';
import { CodexAppServerError } from '../codex/errors';
import type { LocalFileSystem } from '../platform/files';
import {
  SkillBundleManager,
  XAPT_SKILL_NAMES,
  type ResolvedSkill,
  type XaptSkillName,
} from '../skills/manager';
import type { LocalStateStore } from '../state/store';
import type { AttachmentMaterializer, MaterializedAttachment } from './attachments';
import {
  ExecutionResultVerificationError,
  type ExecutionResultBaseline,
  type ExecutionResultVerifier,
} from './result-verification';
import type { ExecutionWorkspaceManager } from './workspaces';
import { failureMessage } from './failure-message';

const sessionResultSchemaValidator = new Ajv({
  allErrors: true,
  strict: false,
});

type InitialTurn = Exclude<
  NonNullable<ClaimedExecution['codexTurn']>,
  { kind: 'READ_SESSION' }
>;

type PreparedExecution =
  | {
      kind: 'READY';
      repositoryPath: string;
      materialized: MaterializedAttachment[];
      resolvedSkill: ResolvedSkill;
      resultAssertions: ExecutionResultAssertion[];
      resultBaseline: ExecutionResultBaseline;
    }
  | { kind: 'WORKSPACE_COMPLETED'; result: JsonValue }
  | { kind: 'FAILED'; failure: ExecutionFailure };

type SynchronizedSession =
  { kind: 'READY'; result: JsonValue } | { kind: 'FAILED'; failure: ExecutionFailure };

function failed(failure: ExecutionFailure) {
  return { kind: 'FAILED' as const, failure };
}

export class ExecutionPreparation {
  constructor(
    private readonly state: LocalStateStore,
    private readonly files: LocalFileSystem,
    private readonly attachments: AttachmentMaterializer,
    private readonly workspaces: ExecutionWorkspaceManager,
    private readonly skills: SkillBundleManager,
    private readonly resultVerifier: ExecutionResultVerifier,
    private readonly executor: CodexExecutor,
  ) {}

  async prepare(
    session: AuthenticatedRunnerSession,
    execution: ClaimedExecution,
    turn: InitialTurn,
  ): Promise<PreparedExecution> {
    const bindingPath = await this.state.resolveBinding(execution.bindingId);
    if (!bindingPath) {
      return failed({
        code: 'BINDING_NOT_FOUND',
        message: '本机未登记该关联',
        retryable: true,
      });
    }
    if ((await this.files.info(bindingPath))?.type !== 'directory') {
      return failed({
        code: 'REPOSITORY_NOT_FOUND',
        message: '本机仓库目录不存在',
        retryable: true,
      });
    }
    let repositoryPath = bindingPath;
    if (execution.workspace)
      try {
        const prepared = await this.workspaces.prepare(bindingPath, execution.workspace);
        if (prepared.kind === 'COMPLETED')
          return { kind: 'WORKSPACE_COMPLETED', result: prepared.result };
        repositoryPath = prepared.cwd;
      } catch {
        return failed({
          code: 'REPOSITORY_NOT_FOUND',
          message: '无法准备隔离的本机 Git 工作区',
          retryable: true,
        });
      }
    let materialized: MaterializedAttachment[];
    try {
      materialized = await this.attachments.materialize(
        session.serverOrigin,
        session.credential,
        execution,
      );
    } catch {
      return failed({
        code: 'ATTACHMENT_DOWNLOAD_FAILED',
        message: '任务附件下载或校验失败',
        retryable: true,
      });
    }
    let resolvedSkill: ResolvedSkill;
    try {
      if (turn.kind === 'INITIAL') {
        const serialized = serializeDeterministicJson(turn.executionBrief);
        if (
          createHash('sha256').update(serialized).digest('hex') !==
          turn.executionBriefHash
        )
          throw new Error('任务说明校验值不匹配');
        if (!XAPT_SKILL_NAMES.includes(turn.requiredSkillName as XaptSkillName))
          throw new Error('任务请求了未知规则');
        resolvedSkill = await this.skills.resolveCurrent(
          turn.requiredSkillName as XaptSkillName,
        );
      } else
        resolvedSkill = await this.skills.resolveBound({
          skillName: turn.taskSkillBinding.skillName as XaptSkillName,
          bundleHash: turn.taskSkillBinding.bundleHash,
          sourceRevision: turn.taskSkillBinding.sourceRevision,
        });
    } catch (error) {
      return failed({
        code: 'CODEX_START_FAILED',
        message: failureMessage(
          error instanceof Error ? error.message : '规则包解析失败',
        ),
        retryable: false,
      });
    }
    const resultAssertions = turn.resultAssertions ?? [];
    let resultBaseline: ExecutionResultBaseline;
    try {
      resultBaseline = await this.resultVerifier.capture(
        repositoryPath,
        resultAssertions,
      );
      await this.state.saveExecutionResultBaseline(execution.id, resultBaseline);
    } catch (error) {
      return failed({
        code: 'CODEX_START_FAILED',
        message: failureMessage(
          error instanceof Error ? error.message : '无法建立本机结果校验基线',
        ),
        retryable: true,
      });
    }
    return {
      kind: 'READY',
      repositoryPath,
      materialized,
      resolvedSkill,
      resultAssertions,
      resultBaseline,
    };
  }

  async readSession(
    execution: ClaimedExecution,
    sessionId: string,
  ): Promise<SynchronizedSession> {
    try {
      const completed = await this.executor.readLastCompletedTurn(sessionId);
      verifySessionResultSchema(execution.codexTurn?.outputJsonSchema, completed.result);
      const resultAssertions = execution.codexTurn?.resultAssertions ?? [];
      if (resultAssertions.length > 0) {
        const bindingPath = await this.state.resolveBinding(execution.bindingId);
        if (!bindingPath)
          throw new ExecutionResultVerificationError(
            '本机未登记原任务关联，无法校验同步结果',
          );
        if (!execution.workspace)
          throw new ExecutionResultVerificationError(
            '同步任务缺少原任务工作区，无法校验结果',
          );
        if (!execution.previousExecutionId)
          throw new ExecutionResultVerificationError(
            '同步任务缺少原执行关联，无法校验结果',
          );
        let repositoryPath: string;
        try {
          repositoryPath = await this.workspaces.resolve(
            bindingPath,
            execution.workspace,
          );
        } catch {
          throw new ExecutionResultVerificationError(
            '原任务工作区不可用，无法校验同步结果',
          );
        }
        const resultBaseline = await this.state.loadExecutionResultBaseline(
          execution.previousExecutionId,
        );
        await this.resultVerifier.verify(
          repositoryPath,
          resultAssertions,
          resultBaseline,
          completed.result,
        );
      }
      return {
        kind: 'READY',
        result: { turnId: completed.turnId, result: completed.result },
      };
    } catch (error) {
      return failed({
        code: 'CODEX_EXECUTION_FAILED',
        message:
          error instanceof CodexAppServerError ||
          error instanceof ExecutionResultVerificationError
            ? failureMessage(error.message)
            : '读取 Codex 会话结果失败',
        retryable: true,
      });
    }
  }
}

function verifySessionResultSchema(
  outputJsonSchema: JsonObject | undefined,
  result: JsonValue,
): void {
  if (!outputJsonSchema)
    throw new ExecutionResultVerificationError('同步任务缺少原任务结果约束');
  let validate;
  try {
    validate = sessionResultSchemaValidator.compile(outputJsonSchema);
  } catch {
    throw new ExecutionResultVerificationError('原任务结果约束无法验证');
  }
  if (!validate(result))
    throw new ExecutionResultVerificationError(
      'Codex 会话的最新轮次不符合原任务结果约束',
    );
}
