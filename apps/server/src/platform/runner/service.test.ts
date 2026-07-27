import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '@/platform/auth/service';
import type { AppDatabase } from '@/platform/database';
import { openDatabase } from '@/platform/database';
import { RunnerService } from './service';

const directories: string[] = [];
const databases: AppDatabase[] = [];

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-time-runner-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
  const auth = new AuthService(database);
  const users = {
    owner: await auth.seedUser({
      id: 'runner-owner',
      username: 'runner-owner',
      displayName: 'Runner 所有者',
      password: 'password',
    }),
    other: await auth.seedUser({
      id: 'runner-other',
      username: 'runner-other',
      displayName: '其他用户',
      password: 'password',
    }),
  };
  let now = new Date('2026-07-26T10:00:00Z');
  let codeIndex = 0;
  let credentialIndex = 0;
  const service = new RunnerService(
    database,
    () => now,
    undefined,
    {
      pairingCode: () =>
        ['A1B2-C3D4-E5F6-A7B8', 'C9D0-E1F2-A3B4-C5D6'][codeIndex++]!,
      credential: () =>
        `credential-${String(++credentialIndex).padStart(32, 'x')}`,
    },
    30_000,
  );
  return {
    database,
    service,
    users,
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('Runner pairing', () => {
  test('Server 只保存配对码 Hash，成功交换后 Credential 只明文返回一次', async () => {
    const { database, service, users } = await setup();
    const issue = service.issuePairingCode(users.owner.id, 60_000);
    const pairingRow = database
      .query<{ code_hash: string }, []>(
        'SELECT code_hash FROM platform_runner_pairing_code',
      )
      .get();
    expect(pairingRow?.code_hash).not.toBe(issue.code);
    expect(pairingRow?.code_hash).not.toContain(issue.code);

    const paired = service.pair(issue.code, '开发机 Runner');
    expect(paired.runner.ownerUserId).toBe(users.owner.id);
    const runnerRow = database
      .query<{ credential_hash: string }, []>(
        'SELECT credential_hash FROM platform_runner WHERE id = ?',
      )
      .get(paired.runner.id);
    expect(runnerRow?.credential_hash).not.toBe(paired.credential);
    expect(JSON.stringify(runnerRow)).not.toContain(paired.credential);
    expect(() => service.pair(issue.code, '重复 Runner')).toThrow(
      expect.objectContaining({ code: 'AUTHENTICATION_FAILED' }),
    );
    expect(() => service.pair('FFFF-FFFF-FFFF-FFFF', '伪造 Runner')).toThrow(
      expect.objectContaining({ code: 'AUTHENTICATION_FAILED' }),
    );
  });

  test('过期配对码被拒绝且不能指定其他 Owner', async () => {
    const { service, setNow, users } = await setup();
    const issue = service.issuePairingCode(users.owner.id, 1_000);
    setNow('2026-07-26T10:00:02Z');
    expect(() => service.pair(issue.code, '过期 Runner')).toThrow(
      expect.objectContaining({ code: 'AUTHENTICATION_FAILED' }),
    );
  });
});

describe('Runner credential and heartbeat', () => {
  test('Bearer Credential 驱动心跳和在线状态，停止心跳后转离线', async () => {
    const { service, setNow, users } = await setup();
    const issue = service.issuePairingCode(users.owner.id);
    const paired = service.pair(issue.code, '心跳 Runner');
    expect(service.listRunners(users.owner.id)[0]?.online).toBe(false);
    const heartbeat = service.heartbeat(paired.credential);
    expect(heartbeat.lastSeenAt).toBe('2026-07-26T10:00:00.000Z');
    expect(service.listRunners(users.owner.id)[0]?.online).toBe(true);
    setNow('2026-07-26T10:00:31Z');
    expect(service.listRunners(users.owner.id)[0]?.online).toBe(false);
    expect(() =>
      service.heartbeat('forged-credential-value-xxxxxxxxxxxxxxxx'),
    ).toThrow(expect.objectContaining({ code: 'NOT_AUTHENTICATED' }));
  });

  test('只有 Owner 可撤销，撤销后 Credential 立即失效', async () => {
    const { service, users } = await setup();
    const paired = service.pair(
      service.issuePairingCode(users.owner.id).code,
      '可撤销 Runner',
    );
    expect(() =>
      service.revokeRunner(
        users.other.id,
        paired.runner.id,
        paired.runner.version,
      ),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    const revoked = service.revokeRunner(
      users.owner.id,
      paired.runner.id,
      paired.runner.version,
    );
    expect(revoked.revokedAt).not.toBeNull();
    expect(() => service.heartbeat(paired.credential)).toThrow(
      expect.objectContaining({ code: 'NOT_AUTHENTICATED' }),
    );
  });
});
