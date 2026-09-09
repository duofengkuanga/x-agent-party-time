import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type JsonValue } from '@agent-party-time/execution-contract';
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
  turnKey,
  turnFailureMessage,
} from './wire-values';

import { codexUserInput } from './turn-input';

import {
  isInteractionMethod,
  defaultDecline,
  publicInteractionPayload,
  restorePrivateInteractionResolution,
} from './interaction';

import { CodexAppServerError } from './errors';

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
  log: WriteStream;
  resolve: (result: JsonValue) => void;
  reject: (error: Error) => void;
};

const XAPT_THREAD_SECURITY = {
  approvalsReviewer: 'auto_review',
  sandbox: 'danger-full-access',
} as const;

export class CodexAppServerExecutor implements CodexExecutor {
  private readonly operations = new Set<CodexAppServerExecutor>();
  private closing: Promise<void> | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private initialized: Promise<void> | null = null;
  private nextRequestId = 1;
  private pendingLine = '';
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly completedTurns = new Map<string, Record<string, unknown>>();
  private readonly agentMessages = new Map<string, string>();

  constructor(
    private readonly executable = 'codex',
    private readonly spawnProcess: typeof spawn = spawn,
  ) {}

  async begin(
    input: CodexExecutionInput,
    signal: AbortSignal,
  ): Promise<StartedCodexExecution> {
    const operation = new CodexAppServerExecutor(
      this.executable,
      this.spawnProcess,
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
    await mkdir(input.artifactsDirectory, { recursive: true, mode: 0o700 });
    await this.ensureStarted();
    let threadId = input.taskId;
    try {
      if (threadId) {
        await this.request('thread/resume', {
          threadId,
          cwd: input.repositoryPath,
          approvalPolicy: input.approvalPolicy,
          ...XAPT_THREAD_SECURITY,
        });
      } else {
        const response = asRecord(
          await this.request('thread/start', {
            cwd: input.repositoryPath,
            approvalPolicy: input.approvalPolicy,
            ...XAPT_THREAD_SECURITY,
          }),
        );
        threadId = requiredString(asRecord(response.thread), 'id');
      }
      const response = asRecord(
        await this.request('turn/start', {
          threadId,
          input: codexUserInput(input),
          outputSchema: input.outputSchema,
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

  async readLastCompletedTurn(sessionId: string): Promise<CompletedCodexTurn> {
    const operation = new CodexAppServerExecutor(
      this.executable,
      this.spawnProcess,
    );
    this.operations.add(operation);
    try {
      return await operation.readOwnedTurn(sessionId);
    } finally {
      await operation.close();
      this.operations.delete(operation);
    }
  }

  private async readOwnedTurn(sessionId: string): Promise<CompletedCodexTurn> {
    await this.ensureStarted();
    try {
      const response = asRecord(
        await this.request('thread/read', {
          threadId: sessionId,
          includeTurns: true,
        }),
      );
      const thread = asRecord(response.thread);
      const turns = Array.isArray(thread.turns)
        ? thread.turns.map(asRecord)
        : Array.isArray(response.turns)
          ? response.turns.map(asRecord)
          : [];
      const turn = turns.at(-1);
      const turnId = turn ? optionalString(turn.id) : null;
      if (!turn || !turnId)
        throw new CodexAppServerError(
          'Codex Session 没有已完成的 Turn',
          sessionId,
        );
      if (optionalString(turn.status) !== 'completed')
        throw new CodexAppServerError(
          'Codex Session 的最新 Turn 尚未成功完成，请在原会话完成后再同步',
          sessionId,
        );
      const items = Array.isArray(turn.items) ? turn.items.map(asRecord) : [];
      const message = [...items]
        .reverse()
        .find(
          (item) =>
            item.type === 'agentMessage' && typeof item.text === 'string',
        )?.text;
      if (typeof message !== 'string')
        throw new CodexAppServerError(
          'Codex Session 的最新 Turn 未返回结果',
          sessionId,
        );
      const result = parseStructuredResult(message);
      if (result === undefined)
        throw new CodexAppServerError(
          'Codex Session 的最新 Turn 未返回有效 JSON',
          sessionId,
        );
      return { turnId, result };
    } catch (error) {
      if (error instanceof CodexAppServerError) throw error;
      throw new CodexAppServerError(safeMessage(error), sessionId);
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.operations].map((operation) => operation.close()),
    );
    if (this.closing) return this.closing;
    const child = this.child;
    if (!child) return;
    this.closing = new Promise<void>((resolve) => {
      child.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      timeout.unref();
      child.kill('SIGTERM');
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
    const child = this.spawnProcess(this.executable, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      for (const turn of this.turns.values()) turn.log.write(chunk);
    });
    child.once('error', (error) => this.failProcess(error));
    child.once('close', (code, closeSignal) =>
      this.failProcess(
        new Error(
          `Codex App Server 已退出（code=${String(code)}, signal=${String(
            closeSignal,
          )}）`,
        ),
      ),
    );
    await this.request('initialize', {
      clientInfo: {
        name: 'xapt',
        title: 'xapt',
        version: '0.1.0',
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
    const log = createWriteStream(
      join(input.artifactsDirectory, 'codex-app-server.jsonl'),
      { flags: 'a', mode: 0o600 },
    );
    return new Promise<JsonValue>((resolve, reject) => {
      const key = turnKey(threadId, turnId);
      const finish = (callback: () => void) => {
        signal.removeEventListener('abort', abort);
        this.turns.delete(key);
        this.agentMessages.delete(key);
        log.end(callback);
      };
      const abort = () => {
        void this.request('turn/interrupt', { threadId, turnId }).catch(
          () => undefined,
        );
        finish(() =>
          reject(new CodexAppServerError('Codex Turn 已被取消', threadId)),
        );
      };
      const active: ActiveTurn = {
        threadId,
        turnId,
        input,
        log,
        resolve: (result) => finish(() => resolve(result)),
        reject: (error) => finish(() => reject(error)),
      };
      signal.addEventListener('abort', abort, { once: true });
      this.turns.set(key, active);
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

  private route(message: Record<string, unknown>, raw: string): void {
    const id = message.id;
    if ((typeof id === 'string' || typeof id === 'number') && !message.method) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      const error = asRecord(message.error);
      if (Object.keys(error).length)
        pending.reject(
          new Error(
            typeof error.message === 'string'
              ? error.message
              : 'Codex 本机服务请求失败',
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

  private completeTurn(
    active: ActiveTurn,
    params: Record<string, unknown>,
  ): void {
    const turn = asRecord(params.turn);
    const status = optionalString(turn.status);
    if (status !== 'completed') {
      active.reject(
        new CodexAppServerError(turnFailureMessage(turn), active.threadId),
      );
      return;
    }
    const items = Array.isArray(turn.items) ? turn.items : [];
    const message =
      [...items]
        .reverse()
        .map(asRecord)
        .find(
          (item) =>
            item.type === 'agentMessage' && typeof item.text === 'string',
        )?.text ??
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
        new CodexAppServerError(
          'Codex Turn 返回的结构化结果无效',
          active.threadId,
        ),
      );
      return;
    }
    active.resolve(result);
  }

  private async handleServerRequest(
    request: JsonRpcRequest,
    active: ActiveTurn | null | undefined,
  ): Promise<void> {
    if (!active || !isInteractionMethod(request.method)) {
      this.respond(request.id, defaultDecline(request.method));
      return;
    }
    try {
      const result = await active.input.onInteraction({
        method: request.method,
        payload: publicInteractionPayload(request.method, request.params),
      });
      this.respond(
        request.id,
        restorePrivateInteractionResolution(
          request.method,
          result,
          request.params,
        ),
      );
    } catch {
      this.respond(request.id, defaultDecline(request.method));
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private respond(id: string | number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private write(message: unknown): void {
    const child = this.child;
    if (!child || child.exitCode !== null)
      throw new Error('Codex 本机服务尚未运行');
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
      turn.reject(
        new CodexAppServerError('Codex App Server 已中断', turn.threadId),
      );
    this.turns.clear();
    this.completedTurns.clear();
    this.agentMessages.clear();
  }
}
