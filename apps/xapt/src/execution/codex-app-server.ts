import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  sanitizeExecutionInteractionPayload,
  type JsonObject,
  type JsonValue,
} from '@agent-party-time/execution-contract';
import type { MaterializedAttachment } from './attachments';

export type CodexInteraction = {
  method: string;
  payload: JsonValue;
};

export type CodexApprovalPolicy = 'never' | 'on-request';

export type CodexExecutionInput = {
  approvalPolicy: CodexApprovalPolicy;
  executionId: string;
  repositoryPath: string;
  prompt: string;
  outputSchema: JsonObject;
  attachments: MaterializedAttachment[];
  artifactsDirectory: string;
  resumeSessionId: string | null;
  onInteraction: (interaction: CodexInteraction) => Promise<JsonValue>;
};

export type StartedCodexExecution = {
  sessionId: string;
  completion: Promise<JsonValue>;
};

export interface CodexExecutor {
  begin(
    input: CodexExecutionInput,
    signal: AbortSignal,
  ): Promise<StartedCodexExecution>;
}

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
  sandbox: 'workspace-write',
} as const;

export class CodexAppServerError extends Error {
  constructor(
    message: string,
    readonly sessionId: string | null,
  ) {
    super(message);
    this.name = 'CodexAppServerError';
  }
}

export class CodexAppServerExecutor implements CodexExecutor {
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
    await mkdir(input.artifactsDirectory, { recursive: true, mode: 0o700 });
    await this.ensureStarted();
    let threadId = input.resumeSessionId;
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
          input: [
            {
              type: 'text',
              text: promptWithAttachments(input.prompt, input.attachments),
              text_elements: [],
            },
          ],
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

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.initialized = null;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
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
              : 'Codex App Server 请求失败',
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
      throw new Error('Codex App Server 尚未运行');
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

function promptWithAttachments(
  prompt: string,
  attachments: MaterializedAttachment[],
): string {
  if (!attachments.length) return prompt;
  const lines = attachments.map(
    ({ originalName, path }) => `- ${originalName}: ${path}`,
  );
  return `${prompt}\n\n本次 Execution 的附件已物化到以下本机文件：\n${lines.join(
    '\n',
  )}`;
}

function isInteractionMethod(method: string): boolean {
  return [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
  ].includes(method);
}

function defaultDecline(method: string): JsonValue {
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'item/permissions/requestApproval')
    return { permissions: {}, scope: 'turn' };
  return { decision: 'decline' };
}

export function publicInteractionPayload(
  method: string,
  value: unknown,
): JsonValue {
  return sanitizeExecutionInteractionPayload(method, value);
}

export function restorePrivateInteractionResolution(
  method: string,
  resolution: JsonValue,
  privatePayload: unknown,
): JsonValue {
  if (method !== 'item/permissions/requestApproval') return resolution;
  const response = asRecord(resolution);
  if (
    !['turn', 'session'].includes(String(response.scope)) ||
    Object.keys(asRecord(response.permissions)).length === 0
  )
    return resolution;
  const privatePermissions = asRecord(privatePayload).permissions;
  const publicPermissions = asRecord(
    publicInteractionPayload(method, privatePayload),
  ).permissions;
  return {
    ...response,
    permissions: restoreSelectedJson(
      response.permissions,
      publicPermissions,
      privatePermissions,
    ),
  };
}

function restoreSelectedJson(
  selected: unknown,
  publicValue: unknown,
  privateValue: unknown,
): JsonValue {
  if (Array.isArray(selected)) {
    if (!Array.isArray(publicValue) || !Array.isArray(privateValue))
      throw new Error('权限恢复结构与原始请求不一致');
    return selected.map((selectedItem) => {
      const index = publicValue.findIndex((candidate) =>
        isJsonSubset(selectedItem, candidate),
      );
      if (index < 0) throw new Error('权限子集不属于原始请求');
      return restoreSelectedJson(
        selectedItem,
        publicValue[index],
        privateValue[index],
      );
    });
  }
  if (selected && typeof selected === 'object') {
    const publicRecord = asRecord(publicValue);
    const privateRecord = asRecord(privateValue);
    return Object.fromEntries(
      Object.entries(selected).map(([key, child]) => {
        if (!(key in publicRecord) || !(key in privateRecord))
          throw new Error('权限子集不属于原始请求');
        return [
          key,
          restoreSelectedJson(child, publicRecord[key], privateRecord[key]),
        ];
      }),
    );
  }
  if (!jsonEquals(selected, publicValue))
    throw new Error('权限子集不属于原始请求');
  return sanitizeJsonValue(privateValue);
}

function isJsonSubset(candidate: unknown, requested: unknown): boolean {
  if (
    candidate === null ||
    typeof candidate === 'string' ||
    typeof candidate === 'number' ||
    typeof candidate === 'boolean'
  )
    return candidate === requested;
  if (Array.isArray(candidate))
    return (
      Array.isArray(requested) &&
      candidate.every((value) =>
        requested.some((requestedValue) => isJsonSubset(value, requestedValue)),
      )
    );
  if (candidate && typeof candidate === 'object') {
    if (!requested || typeof requested !== 'object' || Array.isArray(requested))
      return false;
    const requestedRecord = requested as Record<string, unknown>;
    return Object.entries(candidate).every(
      ([key, value]) =>
        key in requestedRecord && isJsonSubset(value, requestedRecord[key]),
    );
  }
  return false;
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  )
    return left === right;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEquals(value, right[index]))
    );
  const leftEntries = Object.entries(left);
  const rightRecord = right as Record<string, unknown>;
  return (
    leftEntries.length === Object.keys(rightRecord).length &&
    leftEntries.every(
      ([key, value]) =>
        key in rightRecord && jsonEquals(value, rightRecord[key]),
    )
  );
}

function sanitizeJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        sanitizeJsonValue(child),
      ]),
    );
  return null;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function turnFailureMessage(turn: Record<string, unknown>): string {
  const error = asRecord(turn.error);
  const message = optionalString(error.message);
  const codexErrorInfo = asRecord(error.codexErrorInfo);
  const tooMany = asRecord(codexErrorInfo.responseTooManyFailedAttempts);
  if (
    tooMany.httpStatusCode === 429 ||
    message?.includes('429 Too Many Requests')
  )
    return 'Codex 请求过多：429 Too Many Requests，已超过重试次数。';
  return message?.trim() || 'Codex Turn 未正常完成';
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || !result)
    throw new Error(`Codex App Server 响应缺少 ${key}`);
  return result;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseStructuredResult(message: string): JsonValue | undefined {
  const trimmed = message.trim();
  const candidates: string[] = [trimmed];
  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)]
    .map((match) => match[1].trim())
    .reverse();
  candidates.push(...fences);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as JsonValue;
    } catch {
      // 尝试下一个候选片段
    }
  }
  return undefined;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Codex App Server 请求失败';
}
