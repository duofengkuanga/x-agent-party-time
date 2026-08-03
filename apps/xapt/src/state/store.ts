import { basename, join } from 'node:path';
import { resolve } from 'node:path';
import type { ZodType } from 'zod';
import type { LocalFileSystem } from '../platform/files';
import type { XaptPaths } from '../platform/paths';
import {
  BindingStateSchema,
  ConnectionStateSchema,
  ExecutionRecoveryStateSchema,
  InstallStateSchema,
  LocalBindingSchema,
  OutboxEntrySchema,
  STATE_SCHEMA_VERSION,
  type BindingState,
  type ConnectionState,
  type ExecutionRecoveryState,
  type InstallState,
  type OutboxEntry,
} from './schemas';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const ATOMIC_TEMPORARY_FILE =
  /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

export class LocalStateStore {
  constructor(
    private readonly paths: XaptPaths,
    private readonly files: LocalFileSystem,
  ) {}

  async initialize(): Promise<void> {
    for (const path of this.managedDirectories())
      await this.files.ensureDirectory(path, PRIVATE_DIRECTORY_MODE);
    for (const path of [
      this.paths.installRoot,
      this.paths.applicationSupport,
      this.paths.outbox,
      this.paths.executions,
    ])
      await this.cleanupTemporaryFiles(path);
  }

  async saveConnection(value: ConnectionState): Promise<void> {
    await this.writeState(
      this.paths.connection,
      ConnectionStateSchema.parse(value),
    );
  }

  async loadConnection(): Promise<ConnectionState | null> {
    return await this.readState(
      this.paths.connection,
      ConnectionStateSchema,
      true,
    );
  }

  async removeConnection(): Promise<void> {
    await this.files.remove(this.paths.connection);
  }

  async saveBindings(value: BindingState): Promise<void> {
    await this.writeState(this.paths.bindings, BindingStateSchema.parse(value));
  }

  async loadBindings(): Promise<BindingState> {
    return (
      (await this.readState(this.paths.bindings, BindingStateSchema, true)) ?? {
        schemaVersion: STATE_SCHEMA_VERSION,
        bindings: {},
      }
    );
  }

  async bind(bindingId: string, repositoryPath: string): Promise<void> {
    const current = await this.loadBindings();
    const path = resolve(repositoryPath);
    const existing = current.bindings[bindingId];
    if (existing && existing.repositoryPath !== path)
      throw new BindingStateError(
        'BINDING_CONFLICT',
        'Binding 已映射到另一仓库，不会静默覆盖',
      );
    if (existing) return;
    current.bindings[bindingId] = LocalBindingSchema.parse({
      bindingId,
      repositoryPath: path,
      updatedAt: new Date().toISOString(),
    });
    await this.saveBindings(current);
  }

  async removeBinding(bindingId: string): Promise<boolean> {
    const current = await this.loadBindings();
    if (!current.bindings[bindingId]) return false;
    delete current.bindings[bindingId];
    await this.saveBindings(current);
    return true;
  }

  async pruneBindings(activeBindingIds: readonly string[]): Promise<string[]> {
    const active = new Set(activeBindingIds);
    const current = await this.loadBindings();
    const removed = Object.keys(current.bindings)
      .filter((bindingId) => !active.has(bindingId))
      .sort();
    for (const bindingId of removed) delete current.bindings[bindingId];
    if (removed.length) await this.saveBindings(current);
    return removed;
  }

  async resolveBinding(bindingId: string): Promise<string | null> {
    return (
      (await this.loadBindings()).bindings[bindingId]?.repositoryPath ?? null
    );
  }

  async saveExecution(value: ExecutionRecoveryState): Promise<void> {
    const parsed = ExecutionRecoveryStateSchema.parse(value);
    await this.writeState(
      join(this.paths.executions, `${parsed.executionId}.json`),
      parsed,
    );
  }

  async loadExecutions(): Promise<ExecutionRecoveryState[]> {
    return await this.readDirectory(
      this.paths.executions,
      ExecutionRecoveryStateSchema,
    );
  }

  async removeExecution(executionId: string): Promise<void> {
    await this.files.remove(join(this.paths.executions, `${executionId}.json`));
  }

  async saveOutbox(value: OutboxEntry): Promise<void> {
    const parsed = OutboxEntrySchema.parse(value);
    await this.writeState(join(this.paths.outbox, `${parsed.id}.json`), parsed);
  }

  async loadOutbox(): Promise<OutboxEntry[]> {
    return (
      await this.readDirectory(this.paths.outbox, OutboxEntrySchema)
    ).sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        Number(left.kind === 'OUTCOME') - Number(right.kind === 'OUTCOME') ||
        left.id.localeCompare(right.id),
    );
  }

  async removeOutbox(id: string): Promise<void> {
    await this.files.remove(join(this.paths.outbox, `${id}.json`));
  }

  async saveInstall(value: InstallState): Promise<void> {
    await this.writeState(
      this.paths.installState,
      InstallStateSchema.parse(value),
    );
  }

  async loadInstall(): Promise<InstallState | null> {
    return await this.readState(
      this.paths.installState,
      InstallStateSchema,
      true,
    );
  }

  async preflight(): Promise<void> {
    for (const path of [
      this.paths.installRoot,
      this.paths.versions,
      this.paths.applicationSupport,
      this.paths.run,
      this.paths.state,
      this.paths.outbox,
      this.paths.executions,
      this.paths.workspaces,
    ])
      await this.requirePrivateDirectory(path);
    await this.loadConnection();
    await this.loadBindings();
    await this.loadExecutions();
    await this.loadOutbox();
    await this.loadInstall();
  }

  private async readDirectory<T>(
    path: string,
    schema: ZodType<T>,
  ): Promise<T[]> {
    const values: T[] = [];
    for (const name of await this.files.list(path)) {
      if (!name.endsWith('.json')) continue;
      const value = await this.readState(join(path, name), schema, false);
      values.push(value);
    }
    return values;
  }

  private async readState<T>(
    path: string,
    schema: ZodType<T>,
    optional: false,
  ): Promise<T>;
  private async readState<T>(
    path: string,
    schema: ZodType<T>,
    optional: true,
  ): Promise<T | null>;
  private async readState<T>(
    path: string,
    schema: ZodType<T>,
    optional: boolean,
  ): Promise<T | null> {
    const label = basename(path);
    const info = await this.files.info(path);
    if (!info) {
      if (optional) return null;
      throw new LocalStateError('MISSING_STATE', label);
    }
    if (info.type !== 'file' || info.mode !== PRIVATE_FILE_MODE)
      throw new LocalStateError('INSECURE_PERMISSIONS', label);
    const bytes = await this.files.read(path);
    if (!bytes) throw new LocalStateError('MISSING_STATE', label);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new LocalStateError('CORRUPT_STATE', label);
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      !('schemaVersion' in value) ||
      value.schemaVersion !== STATE_SCHEMA_VERSION
    )
      throw new LocalStateError('UNSUPPORTED_SCHEMA', label);
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new LocalStateError('CORRUPT_STATE', label);
    return parsed.data;
  }

  private async writeState(path: string, value: unknown): Promise<void> {
    try {
      await this.files.writeAtomic(
        path,
        `${JSON.stringify(value, null, 2)}\n`,
        PRIVATE_FILE_MODE,
        PRIVATE_DIRECTORY_MODE,
      );
    } catch (error) {
      if (error instanceof LocalStateError) throw error;
      throw new LocalStateError('WRITE_FAILED', basename(path));
    }
  }

  private managedDirectories(): string[] {
    return [
      this.paths.installRoot,
      this.paths.versions,
      this.paths.applicationSupport,
      this.paths.run,
      this.paths.state,
      this.paths.outbox,
      this.paths.executions,
      this.paths.workspaces,
      this.paths.caches,
      this.paths.updateCache,
      this.paths.attachmentCache,
      this.paths.executionCache,
      this.paths.logs,
    ];
  }

  private async cleanupTemporaryFiles(path: string): Promise<void> {
    for (const name of await this.files.list(path)) {
      if (!ATOMIC_TEMPORARY_FILE.test(name)) continue;
      await this.files.remove(join(path, name));
    }
  }

  private async requirePrivateDirectory(path: string): Promise<void> {
    const info = await this.files.info(path);
    if (
      !info ||
      info.type !== 'directory' ||
      info.mode !== PRIVATE_DIRECTORY_MODE
    )
      throw new LocalStateError('INSECURE_PERMISSIONS', basename(path));
  }
}

export type LocalStateErrorCode =
  | 'MISSING_STATE'
  | 'INSECURE_PERMISSIONS'
  | 'CORRUPT_STATE'
  | 'UNSUPPORTED_SCHEMA'
  | 'WRITE_FAILED';

export class LocalStateError extends Error {
  constructor(
    readonly code: LocalStateErrorCode,
    readonly stateName: string,
  ) {
    const reason: Record<LocalStateErrorCode, string> = {
      MISSING_STATE: '状态文件缺失',
      INSECURE_PERMISSIONS: '状态文件权限不安全',
      CORRUPT_STATE: '状态文件已损坏或包含未知字段',
      UNSUPPORTED_SCHEMA: '状态 Schema 不受当前版本支持',
      WRITE_FAILED: '状态文件无法安全写入',
    };
    super(
      `${stateName}：${reason[code]}。下一步：请检查该状态后重试；不要继续启动 daemon。`,
    );
    this.name = 'LocalStateError';
  }
}

export class BindingStateError extends Error {
  constructor(
    readonly code: 'BINDING_CONFLICT',
    message: string,
  ) {
    super(`${message}。下一步：请先处理现有 Binding。`);
    this.name = 'BindingStateError';
  }
}
