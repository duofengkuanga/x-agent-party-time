import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { serverPaths } from '@/server/config';
import { SERVER_SCHEMA_VERSION } from '@/server/database/schema';
import { prepareDevelopmentDatabase } from './prepare-development';

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
  test('重建 Schema 版本不匹配的 .scratch 开发数据', async () => {
    await mkdir(scratchRoot, { recursive: true });
    const home = await mkdtemp(join(scratchRoot, 'prepare-development-'));
    temporaryDirectories.push(home);
    const paths = serverPaths({ AGENT_PARTY_TIME_HOME: home });
    await mkdir(paths.server, { recursive: true });

    const oldDatabase = new Database(paths.database, { create: true });
    oldDatabase.exec('CREATE TABLE stale_data(id TEXT PRIMARY KEY) STRICT');
    oldDatabase.exec(`PRAGMA user_version = ${SERVER_SCHEMA_VERSION - 1}`);
    oldDatabase.close();

    expect(prepareDevelopmentDatabase({ AGENT_PARTY_TIME_HOME: home })).toEqual(
      { database: paths.database, reset: true },
    );

    const currentDatabase = new Database(paths.database, { readonly: true });
    try {
      expect(
        currentDatabase
          .query<{ user_version: number }, []>('PRAGMA user_version')
          .get()?.user_version,
      ).toBe(SERVER_SCHEMA_VERSION);
      expect(
        currentDatabase
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE name = 'stale_data'",
          )
          .get(),
      ).toBeNull();
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

    expect(() =>
      prepareDevelopmentDatabase({ AGENT_PARTY_TIME_HOME: home }),
    ).toThrow('开发数据目录必须位于仓库 .scratch 内');

    const preservedDatabase = new Database(paths.database, { readonly: true });
    try {
      expect(
        preservedDatabase
          .query<{ user_version: number }, []>('PRAGMA user_version')
          .get()?.user_version,
      ).toBe(SERVER_SCHEMA_VERSION - 1);
    } finally {
      preservedDatabase.close();
    }
  });
});
