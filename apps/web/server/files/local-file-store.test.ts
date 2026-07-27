import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import { AuthService } from '@/server/auth/service';
import { PlatformError } from '@/server/errors';
import { LocalFileStore } from './local-file-store';

const temporaryDirectories: string[] = [];
const openDatabases: AppDatabase[] = [];

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-time-files-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  openDatabases.push(database);
  const auth = new AuthService(database);
  const user = await auth.seedUser({
    id: 'file-user',
    username: 'file-user',
    displayName: '文件用户',
    password: 'file-password',
  });
  const root = join(directory, 'files');
  return { database, root, store: new LocalFileStore(database, root), user };
}

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('LocalFileStore', () => {
  test('原子写入、读取和删除文件内容及元数据', async () => {
    const { database, store, user } = await setup();
    const bytes = new TextEncoder().encode('测试附件');
    const stored = await store.put({
      bytes,
      originalName: '../不会成为路径.txt',
      mediaType: 'text/plain',
      uploadedByUserId: user.id,
    });

    expect(stored.originalName).toBe('../不会成为路径.txt');
    expect(await store.read(stored.id)).toEqual({ file: stored, bytes });
    expect(await store.deleteUnbound(stored.id, 'other-user')).toBe(false);
    expect(await store.deleteUnbound(stored.id, user.id)).toBe(true);
    expect(store.get(stored.id)).toBeNull();
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) count FROM platform_file',
        )
        .get()?.count,
    ).toBe(0);
  });

  test('无效上传不会留下元数据或临时文件', async () => {
    const { database, root, store } = await setup();

    await expect(
      store.put({
        bytes: new TextEncoder().encode('orphan'),
        originalName: 'orphan.txt',
        mediaType: 'text/plain',
        uploadedByUserId: 'missing-user',
      }),
    ).rejects.toThrow();
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) count FROM platform_file',
        )
        .get()?.count,
    ).toBe(0);
    expect(await listFiles(root)).toEqual([]);
  });

  test('恶意存储键不能穿越文件根目录', async () => {
    const { database, store, user } = await setup();
    database
      .prepare(
        `INSERT INTO platform_file(
         id, storage_key, original_name, media_type, size_bytes,
           sha256, uploaded_by_user_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '00000000-0000-4000-8000-000000000001',
        '../../outside',
        'outside.txt',
        'text/plain',
        1,
        '0'.repeat(64),
        user.id,
        new Date().toISOString(),
      );

    await expect(
      store.read('00000000-0000-4000-8000-000000000001'),
    ).rejects.toBeInstanceOf(PlatformError);
  });
});

async function listFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
