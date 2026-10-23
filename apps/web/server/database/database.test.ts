import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { PlatformError } from '@/server/platform/errors/index';
import { openDatabase } from './index';
import { SERVER_SCHEMA_VERSION } from './schema';

const temporaryDirectories: string[] = [];

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-time-db-'));
  temporaryDirectories.push(directory);
  return join(directory, 'server.sqlite');
}

function tableNames(
  database: ReturnType<typeof openDatabase>,
  pattern: string,
): string[] {
  return database
    .all<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE ? ORDER BY name`,
      pattern,
    )
    .map(({ name }) => name);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('Server SQLite schema', () => {
  test.each([26, 27, 28])(
    '交接契约切换拒绝旧 Schema %i 并保留原数据',
    async (version) => {
      const path = await temporaryDatabasePath();
      const raw = new Database(path, { create: true });
      raw.exec(
        `CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('keep'); PRAGMA user_version = ${version}`,
      );
      raw.close();
      expect(() => openDatabase(path)).toThrow('数据库版本不匹配');
      const saved = new Database(path, { readonly: true });
      expect(saved.query('SELECT value FROM preserved').get()).toEqual({ value: 'keep' });
      expect(saved.query('PRAGMA user_version').get()).toEqual({ user_version: version });
      saved.close();
    },
  );

  test('从空目录创建最新 Schema 并启用安全 PRAGMA', async () => {
    const path = await temporaryDatabasePath();
    const database = openDatabase(path);
    try {
      expect(
        database.get<{ user_version: number }>('PRAGMA user_version')?.user_version,
      ).toBe(SERVER_SCHEMA_VERSION);
      expect(
        database.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys,
      ).toBe(1);
      expect(
        database.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode,
      ).toBe('wal');
      expect(database.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout).toBe(
        5_000,
      );
      expect(tableNames(database, 'platform_%')).toEqual([
        'platform_audit_event',
        'platform_binding_request',
        'platform_engineering',
        'platform_engineering_binding',
        'platform_engineering_membership',
        'platform_environment',
        'platform_execution',
        'platform_execution_attachment',
        'platform_execution_interaction',
        'platform_file',
        'platform_mutation',
        'platform_observation_batch',
        'platform_observation_event',
        'platform_observation_head',
        'platform_observation_report',
        'platform_observation_tombstone',
        'platform_project',
        'platform_project_invitation',
        'platform_project_membership',
        'platform_runner',
        'platform_runner_authorization_request',
        'platform_runner_pairing_code',
        'platform_session',
        'platform_user',
      ]);
      expect(
        database
          .all<{ name: string }>('PRAGMA table_info(platform_runner)')
          .map(({ name }) => name),
      ).toContain('installation_id');
      expect(
        database.get<{ name: string }>(`SELECT name FROM sqlite_master
             WHERE type = 'index' AND name = 'platform_runner_owner_installation'`)?.name,
      ).toBe('platform_runner_owner_installation');
      expect(
        database
          .all<{ name: string }>(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN (
               'submission_bug_feedback',
               'submission_verification_attachment',
               'submission_reopen_record',
               'submission_reopen_attachment'
             ) ORDER BY name`,
          )
          .map(({ name }) => name),
      ).toEqual([
        'submission_reopen_attachment',
        'submission_reopen_record',
        'submission_verification_attachment',
      ]);
      expect(
        database.get<{ sql: string }>(`SELECT sql FROM sqlite_master
             WHERE type = 'table' AND name = 'submission_cleanup'`)?.sql,
      ).not.toContain('BUG_CANCELLED');
      expect(tableNames(database, 'submission_%repair%')).toEqual([
        'submission_bug_repair_context',
        'submission_repair_attempt',
        'submission_repair_session_sync',
      ]);
      expect(
        database
          .all<{ name: string }>('PRAGMA table_info(submission_bug)')
          .map(({ name }) => name),
      ).not.toContain('notes');
      expect(
        database.get<{ sql: string }>(`SELECT sql FROM sqlite_master
             WHERE type = 'table' AND name = 'submission_bug_attachment'`)?.sql,
      ).toContain("role IN ('ACTUAL_RESULT', 'EXPECTED_RESULT')");
      expect(tableNames(database, 'submission_%update%')).toEqual([
        'submission_update_attempt',
        'submission_update_batch',
        'submission_update_batch_entry',
        'submission_update_session_sync',
      ]);
    } finally {
      database.close();
    }

    const reopened = openDatabase(path);
    reopened.close();
  });

  test('旧版本数据库明确失败且不执行迁移', async () => {
    const path = await temporaryDatabasePath();
    const raw = new Database(path, { create: true });
    raw.exec('PRAGMA user_version = 20');
    raw.close();

    expect(() => openDatabase(path)).toThrow(PlatformError);
    try {
      openDatabase(path);
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe('SCHEMA_VERSION_MISMATCH');
      expect((error as Error).message).toContain('数据已保留');
    }
  });

  test('未知的现有表不会被当作空库覆盖', async () => {
    const path = await temporaryDatabasePath();
    const raw = new Database(path, { create: true });
    raw.exec('CREATE TABLE unexpected(id TEXT PRIMARY KEY) STRICT');
    raw.close();

    expect(() => openDatabase(path)).toThrow(
      expect.objectContaining({ code: 'SCHEMA_VERSION_MISMATCH' }),
    );
  });
});
