import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  ERROR_CODES,
  SessionRecordSchema,
  createAppError,
  type PageRequest,
  type SessionFilter,
  type SessionRecord,
  type SessionRepository,
  type SessionUpdate,
} from '@agent-party-time/shared';
import type { Clock } from '../health/heartbeat.js';
import type { Logger } from '../logging/logger.js';

export const SessionScopeSchema = z.object({
  agentId: z.string().min(1),
  channelKey: z.string().min(1),
  workspacePath: z.string().min(1),
});
export type SessionScope = z.infer<typeof SessionScopeSchema>;
const SessionKeyScopeSchema = z.object({
  agentId: z.string().min(1),
  channelKey: z.string().min(1),
  canonicalWorkspacePath: z.string().min(1),
});
export function buildSessionKey(
  input: z.input<typeof SessionKeyScopeSchema>,
): string {
  const scope = SessionKeyScopeSchema.parse(input);
  return `session:${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`;
}
export interface WorkspaceResolver {
  resolve(path: string): Promise<string>;
}
export const DEFAULT_WORKSPACE_RESOLVER: WorkspaceResolver = {
  resolve: async (path) => {
    const canonical = await realpath(resolve(path));
    if (!(await stat(canonical)).isDirectory())
      throw new Error('workspace is not a directory');
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  },
};
export interface SessionManagerOptions {
  sessions: SessionRepository;
  clock: Clock;
  workspaceResolver: WorkspaceResolver;
  logger: Logger;
}

export class SessionManager {
  constructor(private readonly options: SessionManagerOptions) {}
  get(key: string) {
    return this.options.sessions.get(key);
  }
  async getOrCreate(raw: SessionScope): Promise<SessionRecord> {
    const scope = SessionScopeSchema.parse(raw);
    const workspacePath = await this.options.workspaceResolver.resolve(
      scope.workspacePath,
    );
    const key = buildSessionKey({
      agentId: scope.agentId,
      channelKey: scope.channelKey,
      canonicalWorkspacePath: workspacePath,
    });
    const existing = await this.options.sessions.get(key);
    if (existing && ['pending', 'active'].includes(existing.status))
      return existing;
    const now = this.options.clock.now().toISOString();
    const record = SessionRecordSchema.parse({
      key,
      generation: (existing?.generation ?? 0) + 1,
      agentId: scope.agentId,
      channelKey: scope.channelKey,
      workspacePath,
      codexThreadId: null,
      status: 'pending',
      invalidatedReason: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
    try {
      return await this.options.sessions.create(record);
    } catch {
      const concurrent = await this.options.sessions.get(key);
      if (concurrent) return concurrent;
      throw createAppError({
        code: ERROR_CODES.storeConstraintConflict,
        category: 'conflict',
        message: '无法创建 session',
        retryable: false,
      });
    }
  }
  async updateAfterRun(
    key: string,
    generation: number,
    update: SessionUpdate,
  ): Promise<SessionRecord> {
    const current = await this.options.sessions.get(key);
    if (!current || current.generation !== generation) throw this.notFound();
    if (
      current.status === 'invalidated' ||
      update.sessionKey !== key ||
      update.expectedRevision !== current.revision
    )
      throw createAppError({
        code: ERROR_CODES.storeConstraintConflict,
        category: 'conflict',
        message: 'session update 冲突',
        retryable: false,
      });
    return this.options.sessions.update(
      SessionRecordSchema.parse({
        ...current,
        codexThreadId: update.codexThreadId,
        status: 'active',
        revision: current.revision + 1,
        updatedAt: this.options.clock.now().toISOString(),
      }),
      current.revision,
    );
  }
  async invalidate(
    key: string,
    generation: number,
    expectedRevision: number,
    reason: string,
  ): Promise<SessionRecord> {
    const current = await this.options.sessions.get(key);
    if (!current || current.generation !== generation) throw this.notFound();
    return this.options.sessions.invalidate(key, reason, expectedRevision);
  }
  list(filter: SessionFilter, page: PageRequest) {
    return this.options.sessions.list(filter, page);
  }
  private notFound() {
    return createAppError({
      code: ERROR_CODES.entityNotFound,
      category: 'not_found',
      message: 'session 不存在',
      retryable: false,
    });
  }
}
