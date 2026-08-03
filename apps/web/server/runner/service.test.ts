import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
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
    const { database, service, setNow, users } = await setup();
    const issue = service.issuePairingCode(users.owner.id, 1_000);
    setNow('2026-07-26T10:00:02Z');
    expect(() => service.pair(issue.code, '过期 Runner')).toThrow(
      expect.objectContaining({ code: 'AUTHENTICATION_FAILED' }),
    );
  });
});

describe('Agent 浏览器授权', () => {
  test('公开请求 ID 与 verifier 分离，浏览器确认后凭据只能领取一次', async () => {
    const { database, service, setNow, users } = await setup();
    const verifier = 'v'.repeat(43);
    const issue = service.createAuthorizationRequest({
      verifierHash: createHash('sha256').update(verifier).digest('hex'),
      fingerprint: 'ABCD-1234-EF56',
      suggestedName: '本机 Agent',
    });
    expect(issue.requestId).not.toContain(verifier);
    const stored = database
      .query<{ verifier_hash: string; approval_token_hash: string | null }, []>(
        `SELECT verifier_hash, approval_token_hash
         FROM platform_runner_authorization_request WHERE id = ?`,
      )
      .get(issue.requestId);
    expect(stored?.verifier_hash).not.toBe(verifier);

    expect(service.claimAuthorization(issue.requestId, verifier)).toEqual({
      state: 'WAITING',
      retryAfterMs: 1_000,
    });
    const approval = service.prepareAuthorizationApproval(
      users.owner.id,
      issue.requestId,
    );
    expect(approval).toMatchObject({
      fingerprint: 'ABCD-1234-EF56',
      suggestedName: '本机 Agent',
      state: 'PENDING',
    });
    expect(approval.approvalToken).toBeTruthy();
    expect(
      database
        .query<{ approval_token_hash: string }, []>(
          `SELECT approval_token_hash
           FROM platform_runner_authorization_request WHERE id = ?`,
        )
        .get(issue.requestId)?.approval_token_hash,
    ).not.toBe(approval.approvalToken);
    expect(() =>
      service.prepareAuthorizationApproval(users.other.id, issue.requestId),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(() =>
      service.approveAuthorization(
        users.other.id,
        issue.requestId,
        approval.approvalToken!,
        '伪造 Agent',
      ),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));

    service.approveAuthorization(
      users.owner.id,
      issue.requestId,
      approval.approvalToken!,
      '我的 Mac Agent',
    );
    expect(service.claimAuthorization(issue.requestId, verifier)).toEqual({
      state: 'WAITING',
      retryAfterMs: 750,
    });
    setNow('2026-07-26T10:00:01Z');
    const claimed = service.claimAuthorization(issue.requestId, verifier);
    expect(claimed).toMatchObject({
      state: 'AUTHORIZED',
      runner: {
        ownerUserId: users.owner.id,
        name: '我的 Mac Agent',
      },
    });
    expect(service.claimAuthorization(issue.requestId, verifier)).toMatchObject(
      { state: 'REJECTED' },
    );
  });

  test('拒绝、过期和过快轮询不会创建 Agent', async () => {
    const { database, service, setNow, users } = await setup();
    const verifier = 'x'.repeat(43);
    const issue = service.createAuthorizationRequest(
      {
        verifierHash: createHash('sha256').update(verifier).digest('hex'),
        fingerprint: 'AAAA-BBBB-CCCC',
        suggestedName: '待确认 Agent',
      },
      1_000,
    );
    const approval = service.prepareAuthorizationApproval(
      users.owner.id,
      issue.requestId,
    );
    service.rejectAuthorization(
      users.owner.id,
      issue.requestId,
      approval.approvalToken!,
    );
    expect(service.claimAuthorization(issue.requestId, verifier)).toMatchObject(
      { state: 'REJECTED' },
    );
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) count FROM platform_runner',
        )
        .get()?.count,
    ).toBe(0);
    setNow('2026-07-26T10:00:02Z');
    expect(service.claimAuthorization(issue.requestId, verifier)).toMatchObject(
      { state: 'REJECTED' },
    );
  });
});

describe('Runner credential and heartbeat', () => {
  test('Bearer Credential 驱动心跳和在线状态，停止心跳后转离线', async () => {
    const { database, service, setNow, users } = await setup();
    const issue = service.issuePairingCode(users.owner.id);
    const paired = service.pair(issue.code, '心跳 Runner');
    expect(service.listRunners(users.owner.id)[0]?.online).toBe(false);
    const heartbeat = service.heartbeat(paired.credential, 1);
    expect(heartbeat.lastSeenAt).toBe('2026-07-26T10:00:00.000Z');
    expect(
      database
        .query<{ available_slots: number }, [string]>(
          'SELECT available_slots FROM platform_runner WHERE id = ?',
        )
        .get(paired.runner.id)?.available_slots,
    ).toBe(1);
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

  test('停用后可重新启用原 Agent、Credential 和工程绑定关系', async () => {
    const { service, users } = await setup();
    const paired = service.pair(
      service.issuePairingCode(users.owner.id).code,
      '可恢复 Agent',
    );
    service.heartbeat(paired.credential);
    const revoked = service.revokeRunner(
      users.owner.id,
      paired.runner.id,
      paired.runner.version,
    );

    expect(() =>
      service.reactivateRunner(users.other.id, revoked.id, revoked.version),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));

    const reactivated = service.reactivateRunner(
      users.owner.id,
      revoked.id,
      revoked.version,
    );
    expect(reactivated).toMatchObject({
      id: paired.runner.id,
      lastSeenAt: null,
      revokedAt: null,
      version: revoked.version + 1,
    });
    expect(service.heartbeat(paired.credential).id).toBe(paired.runner.id);
  });
});
