import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  watch as watchFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CONFIG_SCHEMA_VERSION,
  ERROR_CODES,
  ServiceConfigSchema,
  createAppError,
  type ConfigStore,
  type ServiceConfig,
} from '@agent-party-time/shared';
import type { Logger } from '../logging/logger.js';

export interface ConfigMigration {
  fromVersion: number;
  toVersion: number;
  migrate(value: unknown): unknown;
}
export interface FileConfigStoreOptions {
  configPath: string;
  migrations?: readonly ConfigMigration[];
  logger: Logger;
  watchDebounceMs?: number;
}

export class FileConfigStore implements ConfigStore {
  constructor(private readonly options: FileConfigStoreOptions) {}

  async load(): Promise<ServiceConfig> {
    const raw = await this.readRaw();
    return this.validate(this.migrate(raw));
  }

  async save(
    next: ServiceConfig,
    expectedRevision: number,
  ): Promise<ServiceConfig> {
    ServiceConfigSchema.parse(next);
    const current = await this.load();
    if (current.revision !== expectedRevision)
      throw this.revisionConflict(expectedRevision, current.revision);
    const saved = ServiceConfigSchema.parse({
      ...next,
      revision: expectedRevision + 1,
    });
    await this.atomicWrite(saved);
    return saved;
  }

  async watch(
    onChange: (config: ServiceConfig) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    await mkdir(dirname(this.options.configPath), {
      recursive: true,
      mode: 0o700,
    });
    let revision = (await this.load()).revision;
    const watcher = watchFile(dirname(this.options.configPath), { signal });
    try {
      for await (const event of watcher) {
        if (
          event.filename &&
          event.filename !== this.options.configPath.split('/').at(-1)
        )
          continue;
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.watchDebounceMs ?? 100),
        );
        try {
          const config = await this.load();
          if (config.revision !== revision) {
            revision = config.revision;
            await onChange(config);
          }
        } catch (error) {
          this.options.logger.error(
            'config.watch_invalid',
            '忽略无效配置变更',
            error,
          );
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }

  private async readRaw(): Promise<unknown> {
    try {
      await access(this.options.configPath, constants.F_OK);
      return JSON.parse(
        await readFile(this.options.configPath, 'utf8'),
      ) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      if (error instanceof SyntaxError)
        throw createAppError({
          code: ERROR_CODES.configInvalidJson,
          category: 'validation',
          message: 'config.json 不是合法 JSON',
          retryable: false,
        });
      if ((error as NodeJS.ErrnoException).code === 'EACCES')
        throw createAppError({
          code: ERROR_CODES.configPermissionDenied,
          category: 'permission',
          message: '无法读取配置文件',
          retryable: false,
        });
      throw error;
    }
  }

  private migrate(value: unknown): unknown {
    if (!value || typeof value !== 'object' || !('schemaVersion' in value))
      return { ...ServiceConfigSchema.parse({}), ...(value as object) };
    let current: unknown = value;
    let version = Number(
      (current as { schemaVersion?: unknown }).schemaVersion,
    );
    if (version > CONFIG_SCHEMA_VERSION)
      throw createAppError({
        code: ERROR_CODES.configVersionUnsupported,
        category: 'validation',
        message: `不支持配置版本 ${version}`,
        retryable: false,
      });
    while (version < CONFIG_SCHEMA_VERSION) {
      const migration = (this.options.migrations ?? []).find(
        (item) => item.fromVersion === version,
      );
      if (!migration)
        throw createAppError({
          code: ERROR_CODES.configMigrationMissing,
          category: 'invariant',
          message: `缺少配置迁移 ${version}`,
          retryable: false,
        });
      current = migration.migrate(current);
      version = migration.toVersion;
    }
    return current;
  }

  private validate(value: unknown): ServiceConfig {
    const result = ServiceConfigSchema.safeParse(value);
    if (!result.success)
      throw createAppError({
        code: ERROR_CODES.configInvalid,
        category: 'validation',
        message: '配置校验失败',
        retryable: false,
        details: {
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
    return result.data;
  }

  private async atomicWrite(config: ServiceConfig): Promise<void> {
    const directory = dirname(this.options.configPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.options.configPath}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.options.configPath);
  }

  private revisionConflict(expected: number, actual: number) {
    return createAppError({
      code: ERROR_CODES.configRevisionConflict,
      category: 'conflict',
      message: '配置已被其他操作修改',
      retryable: false,
      details: { expectedRevision: expected, actualRevision: actual },
    });
  }
}
