import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import { AuthService } from './service';

const temporaryDirectories: string[] = [];
const openDatabases: AppDatabase[] = [];

async function createDatabase(): Promise<{
  path: string;
  database: AppDatabase;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-time-auth-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'server.sqlite');
  const database = openDatabase(path);
  openDatabases.push(database);
  return { path, database };
}

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('AuthService', () => {
  test('Seed 幂等且数据库不保存明文密码', async () => {
    const { database } = await createDatabase();
    const auth = new AuthService(
      database,
      () => new Date('2026-07-26T00:00:00Z'),
    );

    const first = await auth.seedUser({
      id: 'user-one',
      username: 'user.one',
      displayName: '用户一',
      password: 'first-password',
    });
    const repeated = await auth.seedUser({
      id: 'user-one',
      username: 'user.one',
      displayName: '不会覆盖',
      password: 'different-password',
    });

    expect(repeated).toEqual(first);
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) count FROM platform_user',
        )
        .get()?.count,
    ).toBe(1);
    const row = database
      .query<{ password_hash: string }, []>(
        'SELECT password_hash FROM platform_user WHERE id = ?',
      )
      .get('user-one');
    expect(row?.password_hash).toStartWith('scrypt$1$');
    expect(row?.password_hash).not.toContain('first-password');
    expect(await auth.authenticate('USER.ONE', 'first-password')).toEqual(
      first,
    );
    expect(
      await auth.authenticate('user.one', 'different-password'),
    ).toBeNull();
    expect(await auth.authenticate('missing', 'first-password')).toBeNull();
  });

  test('Session 只保存 Token Hash，并可跨数据库重启恢复和撤销', async () => {
    const { path, database } = await createDatabase();
    const now = new Date('2026-07-26T01:00:00Z');
    const auth = new AuthService(database, () => now);
    const user = await auth.seedUser({
      id: 'user-session',
      username: 'session-user',
      displayName: 'Session 用户',
      password: 'session-password',
    });
    const session = auth.createSession(user.id, 60_000);

    const stored = database
      .query<{ token_hash: string }, []>(
        'SELECT token_hash FROM platform_session',
      )
      .get();
    expect(stored?.token_hash).not.toBe(session.token);
    expect(session.token.length).toBeGreaterThan(30);
    expect(auth.currentUser(session.token)).toEqual(user);

    database.close();
    openDatabases.splice(openDatabases.indexOf(database), 1);
    const reopened = openDatabase(path);
    openDatabases.push(reopened);
    const afterRestart = new AuthService(reopened, () => now);
    expect(afterRestart.currentUser(session.token)).toEqual(user);
    afterRestart.revokeSession(session.token);
    expect(afterRestart.currentUser(session.token)).toBeNull();
  });

  test('过期 Session 会被拒绝并清理', async () => {
    const { database } = await createDatabase();
    let now = new Date('2026-07-26T02:00:00Z');
    const auth = new AuthService(database, () => now);
    const user = await auth.seedUser({
      id: 'user-expired',
      username: 'expired-user',
      displayName: '过期用户',
      password: 'expired-password',
    });
    const session = auth.createSession(user.id, 1_000);
    now = new Date('2026-07-26T02:00:02Z');

    expect(auth.currentUser(session.token)).toBeNull();
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) count FROM platform_session',
        )
        .get()?.count,
    ).toBe(0);
  });
});
