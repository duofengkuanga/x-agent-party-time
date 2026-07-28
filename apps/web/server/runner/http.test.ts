import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import { RunnerService } from './service';
import {
  handleRunnerBindingConfirmation,
  handleRunnerBindings,
  handleRunnerHeartbeat,
  handleRunnerPair,
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
      bearerRequest(
        'http://server/api/runner/heartbeat',
        paired.credential,
        'POST',
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
