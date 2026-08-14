import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import { RunnerService } from './service';
import {
  handleRunnerAuthorizationClaim,
  handleRunnerAuthorizationCreate,
  handleRunnerBindingConfirmation,
  handleRunnerBindingWorkClaim,
  handleRunnerBindingWorkCompletion,
  handleRunnerBindings,
  handleRunnerHeartbeat,
  handleBugDelete,
  handleRunnerPair,
  handleRunnerSelfRevocation,
} from './http';

const directories: string[] = [];
const databases: AppDatabase[] = [];

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-time-http-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
  const auth = new AuthService(database);
  const user = await auth.seedUser({
    id: 'http-runner-user',
    username: 'http-runner-user',
    displayName: 'HTTP Runner 用户',
    password: 'password',
  });
  const runners = new RunnerService(database);
  return { runners, user };
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Runner HTTP protocol', () => {
  test('Pair Route 只在成功响应返回一次明文 Credential', async () => {
    const { runners, user } = await setup();
    const code = runners.issuePairingCode(user.id).code;
    const request = pairRequest({ code, name: 'HTTP Runner' });
    const response = await handleRunnerPair(request, runners);
    const body = (await response.json()) as {
      runner: { id: string };
      credential: string;
    };
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.credential.length).toBeGreaterThan(32);

    const replay = await handleRunnerPair(
      pairRequest({ code, name: 'Replay Runner' }),
      runners,
    );
    expect(replay.status).toBe(401);
    expect(JSON.stringify(await replay.json())).not.toContain(body.credential);
  });

  test('Heartbeat 和 Binding Route 只接受 Bearer Credential', async () => {
    const { runners, user } = await setup();
    const paired = runners.pair(
      runners.issuePairingCode(user.id).code,
      'Bearer Runner',
    );
    const unauthorized = await handleRunnerHeartbeat(
      new Request('http://server/api/runner/heartbeat', { method: 'POST' }),
      runners,
    );
    expect(unauthorized.status).toBe(401);

    const heartbeat = await handleRunnerHeartbeat(
      bearerJsonRequest(
        'http://server/api/runner/heartbeat',
        paired.credential,
        { availableSlots: 2 },
      ),
      runners,
    );
    expect(heartbeat.status).toBe(200);
    expect(JSON.stringify(await heartbeat.json())).not.toContain(
      paired.credential,
    );

    const bindings = await handleRunnerBindings(
      bearerRequest('http://server/api/runner/bindings', paired.credential),
      runners,
      () => [{ bindingId: '00000000-0000-4000-8000-000000000001' }],
    );
    expect(bindings.status).toBe(200);
    const body = JSON.stringify(await bindings.json());
    expect(body).toContain('00000000-0000-4000-8000-000000000001');
    expect(body).not.toContain(paired.credential);
    expect(body).not.toMatch(/\/Users\/|localPath/iu);

    const confirmation = await handleRunnerBindingConfirmation(
      bearerJsonRequest(
        'http://server/api/runner/bindings',
        paired.credential,
        {
          bindingId: '00000000-0000-4000-8000-000000000001',
          repositoryUrl: 'git@Example.com:team/project.git',
        },
      ),
      runners,
      (runnerId, bindingId, repositoryUrl) => {
        expect(runnerId).toBe(paired.runner.id);
        expect(bindingId).toBe('00000000-0000-4000-8000-000000000001');
        expect(repositoryUrl).toBe('https://example.com/team/project.git');
        return repositoryUrl;
      },
    );
    expect(confirmation.status).toBe(200);
    expect(await confirmation.json()).toEqual({
      bindingId: '00000000-0000-4000-8000-000000000001',
      repositoryUrl: 'https://example.com/team/project.git',
    });
  });

  test('Agent 自撤销只能撤销当前 Credential，撤销后立即失效', async () => {
    const { runners, user } = await setup();
    const current = runners.pair(
      runners.issuePairingCode(user.id).code,
      'Current Agent',
    );
    const other = runners.pair(
      runners.issuePairingCode(user.id).code,
      'Other Agent',
    );

    const response = await handleRunnerSelfRevocation(
      bearerRequest('http://server/api/runner', current.credential, 'DELETE'),
      runners,
    );

    expect(response.status).toBe(200);
    expect(() => runners.heartbeat(current.credential)).toThrow(
      expect.objectContaining({ code: 'NOT_AUTHENTICATED' }),
    );
    expect(runners.heartbeat(other.credential).id).toBe(other.runner.id);
    const repeated = await handleRunnerSelfRevocation(
      bearerRequest('http://server/api/runner', current.credential, 'DELETE'),
      runners,
    );
    expect(repeated.status).toBe(401);
  });

  test('浏览器授权 Route 不向浏览器或响应泄露 verifier 与长期凭据', async () => {
    const { runners, user } = await setup();
    const verifier = 'v'.repeat(43);
    const creation = await handleRunnerAuthorizationCreate(
      new Request('http://server/api/runner/authorizations', {
        method: 'POST',
        body: JSON.stringify({
          installationId: '00000000-0000-4000-8000-000000000010',
          verifierHash: createHash('sha256').update(verifier).digest('hex'),
          fingerprint: 'ABCD-1234-EF56',
          suggestedName: 'HTTP Agent',
        }),
        headers: { 'content-type': 'application/json' },
      }),
      runners,
    );
    expect(creation.status).toBe(201);
    const issue = (await creation.json()) as {
      requestId: string;
      expiresAt: string;
    };
    expect(issue.requestId.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(issue)).not.toContain(verifier);
    expect(JSON.stringify(issue)).not.toContain('credential');

    const approval = runners.prepareAuthorizationApproval(
      user.id,
      issue.requestId,
    );
    runners.approveAuthorization(
      user.id,
      issue.requestId,
      approval.approvalToken!,
      'HTTP Agent',
    );
    const claim = await handleRunnerAuthorizationClaim(
      new Request(
        `http://server/api/runner/authorizations/${issue.requestId}/claim`,
        {
          method: 'POST',
          body: JSON.stringify({ verifier }),
          headers: { 'content-type': 'application/json' },
        },
      ),
      issue.requestId,
      runners,
    );
    expect(claim.status).toBe(200);
    expect(await claim.json()).toMatchObject({
      state: 'AUTHORIZED',
      runner: { name: 'HTTP Agent' },
    });
  });

  test('Agent 只通过 Bearer 出站领取并完成 Binding 请求', async () => {
    const { runners, user } = await setup();
    const paired = runners.pair(
      runners.issuePairingCode(user.id).code,
      'Binding Agent',
    );
    const work = {
      requestId: '00000000-0000-4000-8000-000000000011',
      bindingId: '00000000-0000-4000-8000-000000000012',
      expiresAt: '2026-07-28T13:05:00.000Z',
    };
    const unauthorized = await handleRunnerBindingWorkClaim(
      new Request('http://server/api/runner/binding-requests'),
      runners,
      () => work,
    );
    expect(unauthorized.status).toBe(401);

    const claim = await handleRunnerBindingWorkClaim(
      bearerRequest(
        'http://server/api/runner/binding-requests',
        paired.credential,
      ),
      runners,
      (runnerId) => {
        expect(runnerId).toBe(paired.runner.id);
        return work;
      },
    );
    const claimedWork = await claim.json();
    expect(claimedWork).toEqual({ request: work });
    expect(JSON.stringify(claimedWork)).not.toContain('/Users/');

    const completion = await handleRunnerBindingWorkCompletion(
      bearerJsonRequest(
        `http://server/api/runner/binding-requests/${work.requestId}`,
        paired.credential,
        {
          outcome: 'SUCCEEDED',
          repositoryUrl: 'git@Example.com:team/project.git',
        },
      ),
      work.requestId,
      runners,
      (runnerId, requestId, result) => {
        expect(runnerId).toBe(paired.runner.id);
        expect(requestId).toBe(work.requestId);
        expect(result).toEqual({
          outcome: 'SUCCEEDED',
          repositoryUrl: 'https://example.com/team/project.git',
        });
        return 'SUCCEEDED';
      },
    );
    expect(await completion.json()).toEqual({ state: 'SUCCEEDED' });
  });

  test('无效 JSON 和非法请求结构返回安全 Validation Error', async () => {
    const { runners } = await setup();
    const malformed = await handleRunnerPair(
      new Request('http://server/api/runner/pair', {
        method: 'POST',
        body: '{broken',
        headers: { 'content-type': 'application/json' },
      }),
      runners,
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', message: '请求内容无效' },
    });
  });

  test('缺陷删除 Route 只接受 Bearer Credential', async () => {
    const { runners, user } = await setup();
    const paired = runners.pair(
      runners.issuePairingCode(user.id).code,
      'Bug Delete Agent',
    );
    const unauthorized = await handleBugDelete(
      bearerJsonRequest(
        'http://server/api/cooking/bugs/delete',
        'invalid-credential',
        { all: true },
      ),
      runners,
      { deleteBugs: () => ({ deletedBugIds: [], deletedExecutionIds: [] }) },
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await handleBugDelete(
      bearerJsonRequest(
        'http://server/api/cooking/bugs/delete',
        paired.credential,
        { all: true, force: true },
      ),
      runners,
      {
        deleteBugs: (input) => {
          expect(input).toEqual({ all: true, force: true });
          return {
            deletedBugIds: ['944d519c-1ed0-4711-a3b1-325bec5bbe56'],
            deletedExecutionIds: ['00000000-0000-4000-8000-000000000001'],
          };
        },
      },
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      deletedBugIds: ['944d519c-1ed0-4711-a3b1-325bec5bbe56'],
      deletedExecutionIds: ['00000000-0000-4000-8000-000000000001'],
    });
  });

  test('缺陷删除 Route 非法请求结构返回安全 Validation Error', async () => {
    const { runners, user } = await setup();
    const paired = runners.pair(
      runners.issuePairingCode(user.id).code,
      'Bug Delete Malformed Agent',
    );
    const malformed = await handleBugDelete(
      new Request('http://server/api/cooking/bugs/delete', {
        method: 'POST',
        body: '{broken',
        headers: {
          authorization: `Bearer ${paired.credential}`,
          'content-type': 'application/json',
        },
      }),
      runners,
      { deleteBugs: () => ({ deletedBugIds: [], deletedExecutionIds: [] }) },
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', message: '请求内容无效' },
    });
  });
});

function pairRequest(body: unknown): Request {
  return new Request('http://server/api/runner/pair', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function bearerRequest(
  url: string,
  credential: string,
  method = 'GET',
): Request {
  return new Request(url, {
    method,
    headers: { authorization: `Bearer ${credential}` },
  });
}

function bearerJsonRequest(
  url: string,
  credential: string,
  body: unknown,
): Request {
  return new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
  });
}
