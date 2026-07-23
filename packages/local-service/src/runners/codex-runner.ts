import { Codex, type ThreadEvent } from '@openai/codex-sdk';
import {
  ERROR_CODES,
  RunnerContextSchema,
  RunnerHealthSchema,
  RunnerProgressSchema,
  RunnerResultSchema,
  createAppError,
  type AgentRunner,
  type RunnerCallbacks,
  type RunnerContext,
  type RunnerHealth,
  type RunnerResult,
} from '@agent-party-time/shared';
import type { Clock } from '../health/heartbeat.js';
import type { Logger } from '../logging/logger.js';

export type CodexClientFactory = () => Codex;
export interface CodexRunnerOptions {
  clientFactory?: CodexClientFactory;
  defaultModel?: string;
  logger: Logger;
  clock: Clock;
}

export class CodexRunner implements AgentRunner {
  readonly name = 'codex';
  private closed = false;
  constructor(private readonly options: CodexRunnerOptions) {}

  async run(
    raw: RunnerContext,
    callbacks: RunnerCallbacks,
    signal: AbortSignal,
  ): Promise<RunnerResult> {
    const context = RunnerContextSchema.parse(raw);
    if (this.closed) return this.failed('runner 已关闭');
    if (signal.aborted) return this.cancelled();
    const timeoutMs = Math.max(
      1,
      Date.parse(context.deadlineAt) - this.options.clock.now().getTime(),
    );
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let threadId = context.session.codexThreadId;
    try {
      await this.progress(callbacks, 'starting', '正在启动 Codex run');
      const client = (this.options.clientFactory ?? (() => new Codex()))();
      const threadOptions = {
        workingDirectory: context.workspacePath,
        model: context.agent.model ?? this.options.defaultModel,
        skipGitRepoCheck: true,
      };
      const thread =
        context.session.codexThreadId && context.session.status === 'active'
          ? client.resumeThread(context.session.codexThreadId, threadOptions)
          : client.startThread(threadOptions);
      const streamed = await thread.runStreamed(this.buildInput(context), {
        signal: combined,
      });
      let finalText = '';
      let inputTokens = 0;
      let outputTokens = 0;
      for await (const event of streamed.events) {
        if (event.type === 'thread.started') threadId = event.thread_id;
        if (
          event.type === 'item.started' &&
          [
            'command_execution',
            'file_change',
            'mcp_tool_call',
            'web_search',
          ].includes(event.item.type)
        )
          await this.progress(callbacks, 'tool', `正在使用 ${event.item.type}`);
        if (
          event.type === 'item.completed' &&
          event.item.type === 'agent_message'
        )
          finalText = event.item.text;
        if (event.type === 'turn.completed') {
          inputTokens = event.usage.input_tokens;
          outputTokens = event.usage.output_tokens;
        }
        if (event.type === 'turn.failed' || event.type === 'error')
          throw new Error(
            event.type === 'error' ? event.message : event.error.message,
          );
      }
      await this.progress(callbacks, 'finalizing', '正在整理最终结果');
      if (!finalText.trim()) throw new Error('Codex 未返回最终文本');
      return RunnerResultSchema.parse({
        status: 'succeeded',
        finalText,
        sessionUpdate:
          threadId && threadId !== context.session.codexThreadId
            ? {
                sessionKey: context.session.key,
                expectedRevision: context.session.revision,
                codexThreadId: threadId,
              }
            : null,
        completionArtifact: null,
        usage: { inputTokens, outputTokens },
      });
    } catch (error) {
      const sessionUpdate =
        threadId && threadId !== context.session.codexThreadId
          ? {
              sessionKey: context.session.key,
              expectedRevision: context.session.revision,
              codexThreadId: threadId,
            }
          : null;
      if (combined.aborted)
        return RunnerResultSchema.parse({
          status: signal.aborted ? 'cancelled' : 'failed',
          error: signal.aborted ? this.cancelError() : this.timeoutError(),
          sessionUpdate,
        });
      this.options.logger.error('runner.failed', 'Codex run 失败', error, {
        jobId: context.jobId,
        runId: context.runId,
      });
      return RunnerResultSchema.parse({
        status: 'failed',
        error: this.mapSdkError(error),
        sessionUpdate,
      });
    }
  }
  async health(): Promise<RunnerHealth> {
    return RunnerHealthSchema.parse({
      status: this.closed ? 'unavailable' : 'ready',
      runnerName: this.name,
      checkedAt: this.options.clock.now().toISOString(),
      ...(this.closed ? { message: 'runner 已关闭' } : {}),
    });
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  buildInput(context: RunnerContext): string {
    return [
      context.agent.instructions
        ? `角色说明：\n${context.agent.instructions}`
        : '',
      `任务类型：${context.objective.kind}`,
      context.objective.taskId ? `Task：${context.objective.taskId}` : '',
      `本次目标：\n${context.objective.instructions}`,
      '请完成目标，并只在最终回复中给出可直接发送给用户的结果。',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  private async progress(
    callbacks: RunnerCallbacks,
    phase: 'starting' | 'thinking' | 'tool' | 'finalizing',
    message: string,
  ) {
    try {
      await callbacks.onProgress(
        RunnerProgressSchema.parse({
          phase,
          message,
          occurredAt: this.options.clock.now().toISOString(),
        }),
      );
    } catch (error) {
      this.options.logger.warn(
        'runner.progress_callback_failed',
        'runner progress 回调失败',
        { error: String(error) },
      );
    }
  }
  private mapSdkError(error: unknown) {
    return createAppError({
      code: ERROR_CODES.runnerFailed,
      category: 'runner',
      message:
        error instanceof Error && /auth|credential|login/i.test(error.message)
          ? 'Codex 认证失败'
          : 'Codex 执行失败',
      retryable:
        error instanceof Error &&
        /tempor|rate|unavailable|network/i.test(error.message),
    });
  }
  private timeoutError() {
    return createAppError({
      code: ERROR_CODES.runnerTimedOut,
      category: 'timeout',
      message: 'Codex run 超时',
      retryable: true,
    });
  }
  private cancelError() {
    return createAppError({
      code: ERROR_CODES.runnerCancelled,
      category: 'cancelled',
      message: 'Codex run 已取消',
      retryable: false,
    });
  }
  private failed(message: string): RunnerResult {
    return RunnerResultSchema.parse({
      status: 'failed',
      error: createAppError({
        code: ERROR_CODES.runnerFailed,
        category: 'runner',
        message,
        retryable: false,
      }),
      sessionUpdate: null,
    });
  }
  private cancelled(): RunnerResult {
    return RunnerResultSchema.parse({
      status: 'cancelled',
      error: this.cancelError(),
      sessionUpdate: null,
    });
  }
}
