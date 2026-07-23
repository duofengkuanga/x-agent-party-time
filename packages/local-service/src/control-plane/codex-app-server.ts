import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  RepairResultSchema,
  type RepairPrompt,
  type RepairResult,
} from '@agent-party-time/shared';

export type CodexAppServerRequestMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'item/tool/requestUserInput';

export interface CodexAppServerInteraction {
  requestId: string | number;
  method: CodexAppServerRequestMethod;
  threadId: string;
  turnId: string;
  itemId: string;
  params: Record<string, unknown>;
}

export type CodexAppServerInteractionHandler = (
  interaction: CodexAppServerInteraction,
) => Promise<unknown>;

export interface StructuredExecutionInput<TResult> {
  executionId: string;
  repositoryPath: string;
  prompt: string;
  outputSchema: RepairPrompt['outputSchema'];
  resultSchema: z.ZodType<TResult>;
  artifactsDirectory: string;
  resumeSessionId?: string | null;
  onInteraction?: CodexAppServerInteractionHandler;
}

export interface StructuredExecutionResult<TResult> {
  sessionId: string | null;
  result: TResult;
}

export interface StructuredExecutor {
  executeStructured<TResult>(
    input: StructuredExecutionInput<TResult>,
    signal: AbortSignal,
  ): Promise<StructuredExecutionResult<TResult>>;
}

export interface RepairExecutionInput {
  attemptId: string;
  repositoryPath: string;
  prompt: string;
  outputSchema: RepairPrompt['outputSchema'];
  artifactsDirectory: string;
  resumeSessionId?: string | null;
}

export interface RepairExecutionResult {
  sessionId: string | null;
  result: RepairResult;
}

export interface RepairExecutor {
  execute(
    input: RepairExecutionInput,
    signal: AbortSignal,
  ): Promise<RepairExecutionResult>;
  executeStructured?: StructuredExecutor['executeStructured'];
}

export interface CodexAppServerExecutorOptions {
  executable?: string;
  spawn?: typeof spawn;
}

export class CodexAppServerError extends Error {
  constructor(
    message: string,
    public readonly sessionId: string | null,
  ) {
    super(message);
    this.name = 'CodexAppServerError';
  }
}

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface ActiveTurn {
  threadId: string;
  turnId: string;
  input: StructuredExecutionInput<unknown>;
  log: WriteStream;
  resolve: (message: string) => void;
  reject: (error: Error) => void;
}

/**
 * Long-lived JSON-RPC client for `codex app-server`. One instance owns one
 * process and multiplexes all repair/update/cleanup threads on the Runner.
 */
export class CodexAppServerExecutor
  implements RepairExecutor, StructuredExecutor
{
  private readonly executable: string;
  private readonly spawnProcess: typeof spawn;
  private child: ChildProcessWithoutNullStreams | null = null;
  private initialized: Promise<void> | null = null;
  private nextRequestId = 1;
  private pendingLine = '';
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly completedTurns = new Map<string, Record<string, unknown>>();
  private readonly agentMessages = new Map<string, string>();

  constructor(options: CodexAppServerExecutorOptions = {}) {
    this.executable = options.executable ?? 'codex';
    this.spawnProcess = options.spawn ?? spawn;
  }

  execute(
    input: RepairExecutionInput,
    signal: AbortSignal,
  ): Promise<RepairExecutionResult> {
    return this.executeStructured(
      {
        executionId: input.attemptId,
        repositoryPath: input.repositoryPath,
        prompt: input.prompt,
        outputSchema: input.outputSchema,
        resultSchema: RepairResultSchema,
        artifactsDirectory: input.artifactsDirectory,
        resumeSessionId: input.resumeSessionId,
      },
      signal,
    );
  }

  async executeStructured<TResult>(
    input: StructuredExecutionInput<TResult>,
    signal: AbortSignal,
  ): Promise<StructuredExecutionResult<TResult>> {
    await mkdir(input.artifactsDirectory, { recursive: true, mode: 0o700 });
    await this.ensureStarted();

    let threadId = input.resumeSessionId ?? null;
    try {
      if (threadId) {
        await this.request('thread/resume', {
          threadId,
          cwd: input.repositoryPath,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
        });
      } else {
        const response = asRecord(
          await this.request('thread/start', {
            cwd: input.repositoryPath,
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
          }),
        );
        threadId = stringAt(asRecord(response.thread), 'id');
      }

      const response = asRecord(
        await this.request('turn/start', {
          threadId,
          input: [
            {
              type: 'text',
              text: input.resumeSessionId ? '继续' : input.prompt,
              text_elements: [],
            },
          ],
          outputSchema: input.outputSchema,
        }),
      );
      const turnId = stringAt(asRecord(response.turn), 'id');
      const raw = await this.waitForTurn(
        threadId,
        turnId,
        input as StructuredExecutionInput<unknown>,
        signal,
      );
      return {
        sessionId: threadId,
        result: input.resultSchema.parse(JSON.parse(stripJsonFence(raw))),
      };
    } catch (error) {
      if (error instanceof CodexAppServerError) throw error;
      throw new CodexAppServerError(messageOf(error), threadId);
    }
  }

  async close() {
    const child = this.child;
    this.child = null;
    this.initialized = null;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
  }

  private async ensureStarted() {
    if (this.initialized) return this.initialized;
    this.initialized = this.start();
    try {
      await this.initialized;
    } catch (error) {
      this.initialized = null;
      throw error;
    }
  }

  private async start() {
    const child = this.spawnProcess(this.executable, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      for (const turn of this.turns.values()) turn.log.write(chunk);
    });
    child.once('error', (error) => this.failProcess(error));
    child.once('close', (code, closeSignal) => {
      this.failProcess(
        new Error(
          `Codex App Server 已退出（code=${String(code)}, signal=${String(closeSignal)}）`,
        ),
      );
    });
    await this.request('initialize', {
      clientInfo: {
        name: 'agent-party-time',
        title: 'Agent Party Time',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized', {});
  }

  private waitForTurn(
    threadId: string,
    turnId: string,
    input: StructuredExecutionInput<unknown>,
    signal: AbortSignal,
  ) {
    const log = createWriteStream(
      join(input.artifactsDirectory, 'codex-app-server.jsonl'),
      {
        flags: 'a',
        mode: 0o600,
      },
    );
    return new Promise<string>((resolve, reject) => {
      const key = turnKey(threadId, turnId);
      const finish = (callback: () => void) => {
        signal.removeEventListener('abort', abort);
        this.turns.delete(key);
        this.agentMessages.delete(key);
        log.end(callback);
      };
      const abort = () => {
        void this.request('turn/interrupt', { threadId, turnId }).catch(
          () => {},
        );
        finish(() =>
          reject(new CodexAppServerError('Codex Turn 已被取消', threadId)),
        );
      };
      signal.addEventListener('abort', abort, { once: true });
      const active: ActiveTurn = {
        threadId,
        turnId,
        input,
        log,
        resolve: (message) => finish(() => resolve(message)),
        reject: (error) => finish(() => reject(error)),
      };
      this.turns.set(key, active);
      const completed = this.completedTurns.get(key);
      if (completed) {
        this.completedTurns.delete(key);
        this.completeTurn(active, completed);
      } else if (signal.aborted) abort();
    });
  }

  private consume(chunk: Buffer) {
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

  private route(message: Record<string, unknown>, raw: string) {
    const id = message.id;
    if ((typeof id === 'string' || typeof id === 'number') && !message.method) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      const response = message as unknown as JsonRpcResponse;
      if (response.error)
        pending.reject(
          new Error(response.error.message ?? 'Codex App Server 请求失败'),
        );
      else pending.resolve(response.result);
      return;
    }

    const method = typeof message.method === 'string' ? message.method : null;
    const params = asRecord(message.params);
    const threadId = optionalString(params.threadId);
    const turnId =
      optionalString(params.turnId) ?? optionalString(asRecord(params.turn).id);
    const active =
      threadId && turnId ? this.turns.get(turnKey(threadId, turnId)) : null;
    if (active) active.log.write(`${raw}\n`);

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

  private completeTurn(active: ActiveTurn, params: Record<string, unknown>) {
    const turn = asRecord(params.turn);
    const status = optionalString(turn.status);
    if (status !== 'completed') {
      active.reject(
        new CodexAppServerError(
          optionalString(asRecord(turn.error).message) ??
            `Codex Turn 状态为 ${String(status)}`,
          active.threadId,
        ),
      );
      return;
    }
    const items = Array.isArray(turn.items) ? turn.items : [];
    const messageText =
      [...items]
        .reverse()
        .map(asRecord)
        .find(
          (item) =>
            item.type === 'agentMessage' && typeof item.text === 'string',
        )?.text ??
      this.agentMessages.get(turnKey(active.threadId, active.turnId));
    if (typeof messageText !== 'string')
      active.reject(
        new CodexAppServerError('Codex Turn 未返回结构化结果', active.threadId),
      );
    else active.resolve(messageText);
  }

  private async handleServerRequest(
    request: JsonRpcRequest,
    active: ActiveTurn | null | undefined,
  ) {
    if (!isInteractionMethod(request.method) || !active?.input.onInteraction) {
      this.respond(request.id, defaultDecline(request.method));
      return;
    }
    const params = asRecord(request.params);
    try {
      const result = await active.input.onInteraction({
        requestId: request.id,
        method: request.method,
        threadId: active.threadId,
        turnId: active.turnId,
        itemId: optionalString(params.itemId) ?? '',
        params,
      });
      this.respond(request.id, result);
    } catch (error) {
      this.respondError(request.id, -32000, messageOf(error));
    }
  }

  private request(method: string, params: unknown) {
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private respond(id: string | number, result: unknown) {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: string | number, code: number, message: string) {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(message: unknown) {
    const child = this.child;
    if (!child || child.exitCode !== null)
      throw new Error('Codex App Server 尚未运行');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failProcess(error: Error) {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.initialized = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const turn of this.turns.values())
      turn.reject(new CodexAppServerError(error.message, turn.threadId));
    this.turns.clear();
    this.completedTurns.clear();
    this.agentMessages.clear();
  }
}

function isInteractionMethod(
  method: string,
): method is CodexAppServerRequestMethod {
  return [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
  ].includes(method);
}

function defaultDecline(method: string) {
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'item/permissions/requestApproval')
    return { permissions: {}, scope: 'turn' };
  return { decision: 'decline' };
}

function turnKey(threadId: string, turnId: string) {
  return `${threadId}:${turnId}`;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function stringAt(value: Record<string, unknown>, key: string) {
  const result = value[key];
  if (typeof result !== 'string' || !result)
    throw new Error(`Codex App Server 响应缺少 ${key}`);
  return result;
}

function optionalString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function stripJsonFence(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? trimmed;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
