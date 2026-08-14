import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { PlatformError } from '@/server/errors';
import { openDatabase } from './index';
import { SERVER_SCHEMA_VERSION } from './schema';

const temporaryDirectories: string[] = [];

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-time-db-'));
  temporaryDirectories.push(directory);
  return join(directory, 'server.sqlite');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('Server SQLite schema', () => {
  test('从空目录创建最新 Schema 并启用安全 PRAGMA', async () => {
    const path = await temporaryDatabasePath();
    const database = openDatabase(path);
    try {
      expect(
        database
          .query<{ user_version: number }, []>('PRAGMA user_version')
          .get()?.user_version,
      ).toBe(SERVER_SCHEMA_VERSION);
      expect(
        database
          .query<{ foreign_keys: number }, []>('PRAGMA foreign_keys')
          .get()?.foreign_keys,
      ).toBe(1);
      expect(
        database
          .query<{ journal_mode: string }, []>('PRAGMA journal_mode')
          .get()?.journal_mode,
      ).toBe('wal');
      expect(
        database.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()
          ?.timeout,
      ).toBe(5_000);
      expect(
        database
          .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'platform_%'
             ORDER BY name`,
          )
          .all()
          .map(({ name }) => name),
      ).toEqual([
        'platform_execution',
        'platform_execution_attachment',
        'platform_execution_interaction',
        'platform_file',
        'platform_runner',
        'platform_runner_authorization_request',
        'platform_runner_pairing_code',
        'platform_session',
        'platform_user',
      ]);
      expect(
        database
          .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN (
               'cooking_bug_feedback',
               'cooking_verification_attachment',
               'cooking_reopen_record',
               'cooking_reopen_attachment'
             ) ORDER BY name`,
          )
          .all()
          .map(({ name }) => name),
      ).toEqual([
        'cooking_reopen_attachment',
        'cooking_reopen_record',
        'cooking_verification_attachment',
      ]);
      expect(
        database
          .query<{ sql: string }, []>(
            `SELECT sql FROM sqlite_master
             WHERE type = 'table' AND name = 'cooking_cleanup'`,
          )
          .get()?.sql,
      ).not.toContain('BUG_CANCELLED');
      expect(
        database
          .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'cooking_%repair%'
             ORDER BY name`,
          )
          .all()
          .map(({ name }) => name),
      ).toEqual(['cooking_bug_repair_context', 'cooking_repair_attempt']);
      expect(
        database
          .query<{ name: string }, []>('PRAGMA table_info(cooking_bug)')
          .all()
          .map(({ name }) => name),
      ).not.toContain('notes');
      expect(
        database
          .query<{ sql: string }, []>(
            `SELECT sql FROM sqlite_master
             WHERE type = 'table' AND name = 'cooking_bug_attachment'`,
          )
          .get()?.sql,
      ).toContain("role IN ('ACTUAL_RESULT', 'EXPECTED_RESULT')");
      expect(
        database
          .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'cooking_%update%'
             ORDER BY name`,
          )
          .all()
          .map(({ name }) => name),
      ).toEqual([
        'cooking_update_attempt',
        'cooking_update_batch',
        'cooking_update_batch_entry',
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
      expect((error as Error).message).toContain('清空 Server 数据目录');
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
