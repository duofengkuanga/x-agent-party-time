import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { serverPaths } from '@/platform/config';
import { SERVER_SCHEMA_VERSION } from '@/platform/database/schema';
import { prepareDevelopmentDatabase } from './prepareDevelopment';

const temporaryDirectories: string[] = [];
const scratchRoot = resolve(import.meta.dir, '../../..', '.scratch');

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('开发数据库准备', () => {
  test('未知版本保留开发数据并明确失败', async () => {
    await mkdir(scratchRoot, { recursive: true });
    const home = await mkdtemp(join(scratchRoot, 'prepare-development-'));
    temporaryDirectories.push(home);
    const paths = serverPaths({ AGENT_PARTY_TIME_HOME: home });
    await mkdir(paths.server, { recursive: true });

    const oldDatabase = new Database(paths.database, { create: true });
    oldDatabase.exec('CREATE TABLE stale_data(id TEXT PRIMARY KEY) STRICT');
    oldDatabase.exec('PRAGMA user_version = 20');
    oldDatabase.close();

    expect(() => prepareDevelopmentDatabase({ AGENT_PARTY_TIME_HOME: home })).toThrow(
      '数据已保留',
    );

    const currentDatabase = new Database(paths.database, { readonly: true });
    try {
      expect(
        currentDatabase.query<{ user_version: number }, []>('PRAGMA user_version').get()
          ?.user_version,
      ).toBe(20);
      expect(
        currentDatabase
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE name = 'stale_data'",
          )
          .get(),
      ).toEqual({ name: 'stale_data' });
    } finally {
      currentDatabase.close();
    }
  });

  test('拒绝处理仓库 .scratch 之外的数据目录', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-party-time-unsafe-'));
    temporaryDirectories.push(home);
    const paths = serverPaths({ AGENT_PARTY_TIME_HOME: home });
    await mkdir(paths.server, { recursive: true });

    const oldDatabase = new Database(paths.database, { create: true });
    oldDatabase.exec(`PRAGMA user_version = ${SERVER_SCHEMA_VERSION - 1}`);
    oldDatabase.close();

    expect(() => prepareDevelopmentDatabase({ AGENT_PARTY_TIME_HOME: home })).toThrow(
      '开发数据目录必须位于仓库 .scratch 内',
    );

    const preservedDatabase = new Database(paths.database, { readonly: true });
    try {
      expect(
        preservedDatabase.query<{ user_version: number }, []>('PRAGMA user_version').get()
          ?.user_version,
      ).toBe(SERVER_SCHEMA_VERSION - 1);
    } finally {
      preservedDatabase.close();
    }
  });
});
