import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  sanitizeExecutionInteractionPayload,
  serializeDeterministicJson,
  type JsonValue,
} from '@agent-party-time/execution-contract';
import { XAPT_VERSION } from '../version';
import { ownedProcessGroups, processGroupExists } from '../platform/processGroups';
import type {
  CodexExecutionInput,
  CodexExecutor,
  StartedCodexExecution,
  CompletedCodexTurn,
} from './contract';

import {
  asRecord,
  requiredString,
  safeMessage,
  optionalString,
  parseStructuredResult,
  latestAgentMessage,
  turnKey,
  turnFailureMessage,
} from './wireValues';

import { codexUserInput } from './turnInput';
import { asyncQuestions, CodexManualHandoff } from './manualHandoff';

import {
  isInteractionMethod,
  defaultDecline,
  restorePrivateInteractionResolution,
  interactionContinuation,
} from './interaction';

import { CodexAppServerError, CodexSessionReleaseError } from './errors';
import { readCompletedTurn } from './sessionReader';
import type { CodexObservationNotice } from '../observability/protocol';

type JsonRpcRequest = {
  id: string | number;
  method: string;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ActiveTurn = {
  threadId: string;
  turnId: string;
  input: CodexExecutionInput;
  signal: AbortSignal;
  resolve: (result: JsonValue) => void;
  reject: (error: Error) => void;
};

const XAPT_THREAD_SECURITY = {
  approvalsReviewer: 'auto_review',
  sandbox: 'danger-full-access',
} as const;

const asyncQuestionList = z
  .array(
    z.strictObject({
      title: z.string().trim().min(1),
      options: z.array(z.string().trim().min(1)).nullable(),
    }),
  )
  .min(1);

export class CodexAppServerExecutor implements CodexExecutor {
  private observer?: (notice: CodexObservationNotice) => void;
  private readonly operations = new Set<CodexAppServerExecutor>();
  private closing: Promise<void> | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ownedChild: ChildProcessWithoutNullStreams | null = null;
  private managedProcessGroup = false;
  private recordProcessGroups?: CodexExecutionInput['onProcessGroups'];
  private terminationSent = false;
  private unexpectedExit = false;
  private initialized: Promise<void> | null = null;
  private nextRequestId = 1;
  private pendingLine = '';
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly completedTurns = new Map<string, Record<string, unknown>>();
  private readonly agentMessages = new Map<string, string>();
  private readonly handoffs = new Map<string, unknown>();
  private readonly handingOff = new Set<string>();

  constructor(
    private readonly executable = 'codex',
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' = 'medium',
  ) {}

  static async probe(executable: string, timeoutMs = 5_000): Promise<void> {
    const executor = new CodexAppServerExecutor(executable);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        executor.ensureStarted(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('initialize timeout')), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      await executor.close();
    }
  }

  async begin(
    input: CodexExecutionInput,
    signal: AbortSignal,
  ): Promise<StartedCodexExecution> {
    const operation = new CodexAppServerExecutor(
      this.executable,
      this.spawnProcess,
      this.reasoningEffort,
    );
    this.operations.add(operation);
    const release = async () => {
      await operation.close();
      this.operations.delete(operation);
    };
    try {
      const started = await operation.beginOwnedTurn(input, signal);
      return { ...started, completion: started.completion.finally(release) };
    } catch (error) {
      await release();
      throw error;
    }
  }

  private async beginOwnedTurn(
    input: CodexExecutionInput,
    signal: AbortSignal,
  ): Promise<StartedCodexExecution> {
    signal.throwIfAborted();
    this.observer = input.observe;
    this.managedProcessGroup = Boolean(input.managedInteractions);
    this.recordProcessGroups = input.onProcessGroups;
    await this.ensureStarted();
    let threadId = input.taskId;
    try {
      signal.throwIfAborted();
      if (threadId) {
        await this.request('thread/resume', {
          threadId,
          cwd: input.repositoryPath,
          approvalPolicy: input.approvalPolicy,
          config: { model_reasoning_effort: this.reasoningEffort },
          ...XAPT_THREAD_SECURITY,
          approvalsReviewer: input.managedInteractions
            ? 'user'
            : XAPT_THREAD_SECURITY.approvalsReviewer,
        });
      } else {
        const response = asRecord(
          await this.request('thread/start', {
            cwd: input.repositoryPath,
            approvalPolicy: input.approvalPolicy,
            config: { model_reasoning_effort: this.reasoningEffort },
            ...XAPT_THREAD_SECURITY,
            approvalsReviewer: input.managedInteractions
              ? 'user'
              : XAPT_THREAD_SECURITY.approvalsReviewer,
          }),
        );
        threadId = requiredString(asRecord(response.thread), 'id');
      }
      signal.throwIfAborted();
      const response = asRecord(
        await this.request('turn/start', {
          threadId,
          input: codexUserInput(input),
          outputSchema: input.outputSchema,
          effort: this.reasoningEffort,
        }),
      );
      const turnId = requiredString(asRecord(response.turn), 'id');
      return {
        sessionId: threadId,
        completion: this.waitForTurn(threadId, turnId, input, signal),
      };
    } catch (error) {
      if (error instanceof CodexAppServerError) throw error;
      throw new CodexAppServerError(safeMessage(error), threadId);
    }
  }

  async readLastCompletedTurn(
    sessionId: string,
    observe?: (notice: CodexObservationNotice) => void,
  ): Promise<CompletedCodexTurn> {
    const operation = new CodexAppServerExecutor(this.executable, this.spawnProcess);
    operation.observer = observe;
    this.operations.add(operation);
    try {
      return await operation.readOwnedTurn(sessionId);
    } finally {
      await operation.close();
      this.operations.delete(operation);
    }
  }

  async releaseSession(sessionId: string): Promise<void> {
    const operation = new CodexAppServerExecutor(this.executable, this.spawnProcess);
    try {
      await operation.ensureStarted();
      // Loading without turn/start proves no other writer owns the session.
      // Closing the temporary owner releases it before replaying the handoff.
      await operation.request('thread/resume', { threadId: sessionId });
    } finally {
      await operation.close();
    }
  }

  private async readOwnedTurn(sessionId: string): Promise<CompletedCodexTurn> {
    await this.ensureStarted();
    return readCompletedTurn(sessionId, (method, params) => this.request(method, params));
  }

  async close(): Promise<void> {
    await Promise.all([...this.operations].map((operation) => operation.close()));
    if (this.closing) return this.closing;
    const child = this.ownedChild;
    if (!child?.pid) return;
    const pid = child.pid;
    let groups = [pid];
    let ownershipKnown = false;
    this.observe({ type: 'closing' });
    this.closing = (async () => {
      if (this.managedProcessGroup) {
        if (this.unexpectedExit)
          throw new Error('执行进程已异常退出，需人工核验工具进程');
        groups = await ownedProcessGroups(pid);
        ownershipKnown = true;
        await this.recordProcessGroups?.(groups);
        if (this.unexpectedExit) {
          ownershipKnown = false;
          throw new Error('记录释放证明前执行进程已异常退出');
        }
      }
      await new Promise<void>((resolve, reject) => {
        let finishing = false;
        const stop = (signal: NodeJS.Signals) => {
          this.terminationSent = true;
          if (this.managedProcessGroup) {
            for (const group of groups) signalProcessGroup(group, signal);
          } else child.kill(signal);
        };
        const finish = async () => {
          if (finishing) return;
          finishing = true;
          clearTimeout(timeout);
          try {
            if (this.managedProcessGroup) {
              stop('SIGKILL');
              const deadline = Date.now() + 5_000;
              while (groups.some(processGroupExists)) {
                if (Date.now() >= deadline) throw new Error('工具进程组仍未退出');
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
            }
            if (this.managedProcessGroup) await this.recordProcessGroups?.([]);
            this.ownedChild = null;
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        child.once('close', () => {
          void finish();
        });
        const timeout = setTimeout(() => {
          try {
            stop('SIGKILL');
          } catch (error) {
            reject(error);
          }
        }, 5000);
        timeout.unref();
        try {
          stop('SIGTERM');
          if (child.exitCode !== null || child.signalCode !== null) void finish();
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    })().catch((error) => {
      if (this.managedProcessGroup)
        throw new CodexSessionReleaseError(groups, error, !ownershipKnown);
      throw error;
    });
    this.failProcess(new Error('Codex 本机服务已关闭'));
    return this.closing;
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = this.start();
    try {
      await this.initialized;
    } catch (error) {
      this.initialized = null;
      throw error;
    }
  }

  private async start(): Promise<void> {
    this.observe({ type: 'spawn' });
    const child = this.spawnProcess(this.executable, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: this.managedProcessGroup,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.ownedChild = child;
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    child.stderr.on('data', () => this.observe({ type: 'stderr' }));
    child.once('error', (error) => this.failProcess(error));
    child.once('close', (code, closeSignal) => {
      if (this.managedProcessGroup && !this.terminationSent) this.unexpectedExit = true;
      this.observe({ type: 'exit', code });
      this.failProcess(
        new Error(
          `Codex App Server 已退出（code=${String(code)}, signal=${String(
            closeSignal,
          )}）`,
        ),
      );
    });
    if (this.managedProcessGroup && child.pid)
      await this.recordProcessGroups?.([child.pid]);
    await this.request('initialize', {
      clientInfo: {
        name: 'xapt',
        title: 'xapt',
        version: XAPT_VERSION,
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized', {});
  }

  private waitForTurn(
    threadId: string,
    turnId: string,
    input: CodexExecutionInput,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    return new Promise<JsonValue>((resolve, reject) => {
      const key = turnKey(threadId, turnId);
      const finish = (callback: () => void) => {
        signal.removeEventListener('abort', abort);
        this.turns.delete(key);
        this.agentMessages.delete(key);
        callback();
      };
      const abort = () => {
        void this.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
        finish(() => reject(new CodexAppServerError('Codex Turn 已被取消', threadId)));
      };
      const active: ActiveTurn = {
        threadId,
        turnId,
        input,
        signal,
        resolve: (result) => finish(() => resolve(result)),
        reject: (error) => finish(() => reject(error)),
      };
      signal.addEventListener('abort', abort, { once: true });
      this.turns.set(key, active);
      const handoff = this.handoffs.get(key);
      if (handoff && (input.onManualHandoff || input.managedInteractions)) {
        this.handoffs.delete(key);
        this.handleAsyncQuestions(active, handoff);
        return;
      }
      const completed = this.completedTurns.get(key);
      if (completed) {
        this.completedTurns.delete(key);
        this.completeTurn(active, completed);
      } else if (signal.aborted) abort();
    });
  }

  private consume(chunk: Buffer): void {
    this.pendingLine += chunk.toString('utf8');
    const lines = this.pendingLine.split('\n');
    this.pendingLine = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = asRecord(JSON.parse(line));
      } catch {
        continue;
      }
      this.route(message, line);
    }
  }

  private route(message: Record<string, unknown>, _raw: string): void {
    this.observe({ type: 'receive', message });
    const id = message.id;
    if ((typeof id === 'string' || typeof id === 'number') && !message.method) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      const error = asRecord(message.error);
      if (Object.keys(error).length)
        pending.reject(
          new Error(
            typeof error.message === 'string' ? error.message : 'Codex 本机服务请求失败',
          ),
        );
      else pending.resolve(message.result);
      return;
    }

    const method = typeof message.method === 'string' ? message.method : null;
    const params = asRecord(message.params);
    const threadId = optionalString(params.threadId);
    const turnId =
      optionalString(params.turnId) ?? optionalString(asRecord(params.turn).id);
    const active = threadId && turnId ? this.turns.get(turnKey(threadId, turnId)) : null;

    if (method === 'item/completed' && threadId && turnId) {
      const questions = asyncQuestions(params.item);
      if (questions) {
        if (active) this.handleAsyncQuestions(active, params.item);
        else this.handoffs.set(turnKey(threadId, turnId), params.item);
      }
    }

    if (id !== undefined && method) {
      void this.handleServerRequest(
        { id: id as string | number, method, params },
        active,
      );
      return;
    }
    if (method === 'item/completed' && threadId && turnId) {
      const item = asRecord(params.item);
      if (item.type === 'agentMessage' && typeof item.text === 'string')
        this.agentMessages.set(turnKey(threadId, turnId), item.text);
      return;
    }
    if (method === 'turn/completed' && threadId && turnId) {
      if (active) this.completeTurn(active, params);
      else this.completedTurns.set(turnKey(threadId, turnId), params);
    }
  }

  private completeTurn(active: ActiveTurn, params: Record<string, unknown>): void {
    if (this.handingOff.has(turnKey(active.threadId, active.turnId))) return;
    const turn = asRecord(params.turn);
    const status = optionalString(turn.status);
    if (status !== 'completed') {
      active.reject(new CodexAppServerError(turnFailureMessage(turn), active.threadId));
      return;
    }
    const message =
      latestAgentMessage(turn.items) ??
      this.agentMessages.get(turnKey(active.threadId, active.turnId));
    if (typeof message !== 'string') {
      active.reject(
        new CodexAppServerError('Codex Turn 未返回结构化结果', active.threadId),
      );
      return;
    }
    const result = parseStructuredResult(message);
    if (result === undefined) {
      active.reject(
        new CodexAppServerError('Codex Turn 返回的结构化结果无效', active.threadId),
      );
      return;
    }
    active.resolve(result);
  }

  private async handoff(active: ActiveTurn, questions: string[]): Promise<void> {
    const key = turnKey(active.threadId, active.turnId);
    if (this.handingOff.has(key)) return;
    this.handingOff.add(key);
    try {
      await active.input.onManualHandoff!(questions);
      // begin().completion only settles after its finally(release) has closed
      // this operation's child; consumers must not advertise a free session sooner.
      void this.request('turn/interrupt', {
        threadId: active.threadId,
        turnId: active.turnId,
      }).catch(() => undefined);
      active.reject(new CodexManualHandoff(questions));
    } catch (error) {
      active.reject(error instanceof Error ? error : new Error('保存人工接管请求失败'));
    }
  }

  private handleAsyncQuestions(active: ActiveTurn, value: unknown): void {
    if (active.input.managedInteractions) void this.answerAsyncQuestions(active, value);
    else if (active.input.onManualHandoff)
      void this.handoff(active, asyncQuestions(value)!);
  }

  private async answerAsyncQuestions(active: ActiveTurn, value: unknown): Promise<void> {
    const key = turnKey(active.threadId, active.turnId);
    if (this.handingOff.has(key)) return;
    this.handingOff.add(key);
    try {
      const item = asRecord(value);
      const itemId = requiredString(item, 'id');
      const parsed = asyncQuestionList.safeParse(item.questions);
      if (!parsed.success)
        throw new CodexAppServerError(
          'Codex 提问格式无效，未保存不完整的问题或选项',
          active.threadId,
        );
      const questions = parsed.data.map((question, index) => {
        return {
          id: `${itemId}:${index}`,
          header: question.title,
          question: question.title,
          options: question.options?.map((label) => ({ label, description: '' })) ?? null,
        };
      });
      const interaction = {
        method: 'xapt/asyncQuestions',
        payload: sanitizeExecutionInteractionPayload('xapt/asyncQuestions', {
          itemId,
          turnId: active.turnId,
          questions,
        }),
      };
      const resolution = active.input.onInteraction(interaction);
      void resolution.catch(() => undefined);
      // Async messages do not block Codex. Detach this turn before closing its
      // process; only the saved answer may start the next turn in the session.
      this.turns.delete(key);
      void this.request('turn/interrupt', {
        threadId: active.threadId,
        turnId: active.turnId,
      }).catch(() => undefined);
      await this.close();
      const answer = await resolution;
      active.signal.throwIfAborted();
      const resumed = await this.begin(
        {
          ...active.input,
          taskId: active.threadId,
          text: interactionContinuation({ ...interaction, resolution: answer }),
          skill: null,
          boundSkillPath: active.input.skill
            ? join(active.input.skill.path, 'SKILL.md')
            : active.input.boundSkillPath,
          attachments: [],
        },
        active.signal,
      );
      active.resolve(await resumed.completion);
    } catch (error) {
      active.reject(error instanceof Error ? error : new Error('无法续接人工问答'));
    }
  }

  private async handleServerRequest(
    request: JsonRpcRequest,
    active: ActiveTurn | null | undefined,
  ): Promise<void> {
    if (!active || !isInteractionMethod(request.method)) {
      if (this.child) this.respond(request.id, defaultDecline(request.method));
      return;
    }
    try {
      const payload = sanitizeExecutionInteractionPayload(request.method, request.params);
      const result = await active.input.onInteraction({
        method: request.method,
        payload: active.input.managedInteractions
          ? {
              ...(asRecord(payload) as Record<string, JsonValue>),
              // Exact original request identity includes private targets locally;
              // only an opaque digest is persisted with its public projection.
              requestKey: createHash('sha256')
                .update(
                  serializeDeterministicJson({
                    method: request.method,
                    id: request.id,
                    params: request.params as JsonValue,
                    repositoryPath: active.input.repositoryPath,
                  }),
                )
                .digest('hex'),
            }
          : payload,
      });
      this.respond(
        request.id,
        restorePrivateInteractionResolution(request.method, result, request.params),
      );
    } catch {
      if (this.child && !active.signal.aborted)
        this.respond(request.id, defaultDecline(request.method));
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.observe({ type: 'send', message: { id, method, params } });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private respond(id: string | number, result: unknown): void {
    this.observe({ type: 'send', message: { id, result } });
    this.write({ jsonrpc: '2.0', id, result });
  }

  private write(message: unknown): void {
    const child = this.child;
    if (!child || child.exitCode !== null) throw new Error('Codex 本机服务尚未运行');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failProcess(error: Error): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.initialized = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const turn of this.turns.values())
      turn.reject(new CodexAppServerError('Codex App Server 已中断', turn.threadId));
    this.turns.clear();
    this.completedTurns.clear();
    this.agentMessages.clear();
  }

  private observe(notice: CodexObservationNotice): void {
    try {
      this.observer?.(notice);
    } catch {
      // The business execution is independent of diagnostic subscribers.
    }
  }
}

function signalProcessGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
