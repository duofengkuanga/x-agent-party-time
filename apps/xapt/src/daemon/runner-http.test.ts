import { expect, test } from 'bun:test';
import { RunnerHttpClient, RunnerHttpError } from './runner-http';

const credential = 'credential-secret-at-least-thirty-two-characters';

test('Heartbeat 通过共享 Schema 实时上报可用执行槽', async () => {
  let request: Request | undefined;
  const client = new RunnerHttpClient(async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      runner: {
        id: '00000000-0000-4000-8000-000000000001',
        ownerUserId: 'user-1',
        name: '测试 Agent',
        version: 1,
        lastSeenAt: '2026-08-03T00:00:00.000Z',
        revokedAt: null,
        createdAt: '2026-08-03T00:00:00.000Z',
      },
    });
  });

  await client.heartbeat('https://apt.example.com', credential, 2);

  expect(await request?.json()).toEqual({ availableSlots: 2 });
  expect(request?.headers.get('authorization')).toBe(`Bearer ${credential}`);
});

test('Binding HTTP 请求携带认证但 Payload 从不包含本机路径', async () => {
  const requests: Request[] = [];
  const client = new RunnerHttpClient(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const path = new URL(request.url).pathname;
    if (path === '/api/runner/bindings') return Response.json({ bindings: [] });
    if (path === '/api/runner/binding-requests')
      return Response.json({ request: null });
    return Response.json({ state: 'SUCCEEDED' });
  });

  await client.listBindings('https://apt.example.com', credential);
  await client.claimBindingWork('https://apt.example.com', credential);
  await client.completeBindingWork(
    'https://apt.example.com',
    credential,
    '00000000-0000-4000-8000-000000000001',
    {
      outcome: 'SUCCEEDED',
      repositoryUrl: 'git@github.com:team/repository.git',
    },
  );

  for (const request of requests)
    expect(request.headers.get('authorization')).toBe(`Bearer ${credential}`);
  const bodies = await Promise.all(requests.map((request) => request.text()));
  expect(JSON.stringify(bodies)).not.toMatch(
    /\/Users\/|\/private\/|repositoryPath/,
  );
  expect(bodies.at(-1)).toContain('https://github.com/team/repository.git');
});

test('deleteBugs 携带认证并解析删除结果', async () => {
  let request: Request | undefined;
  const client = new RunnerHttpClient(async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      deletedBugIds: ['944d519c-1ed0-4711-a3b1-325bec5bbe56'],
      deletedExecutionIds: ['00000000-0000-4000-8000-000000000001'],
    });
  });

  const result = await client.deleteBugs(
    'https://apt.example.com',
    credential,
    {
      bugIds: ['944d519c-1ed0-4711-a3b1-325bec5bbe56'],
      all: false,
      force: true,
    },
  );

  expect(result).toEqual({
    deletedBugIds: ['944d519c-1ed0-4711-a3b1-325bec5bbe56'],
    deletedExecutionIds: ['00000000-0000-4000-8000-000000000001'],
  });
  expect(new URL(request!.url).pathname).toBe('/api/cooking/bugs/delete');
  expect(await request?.json()).toEqual({
    bugIds: ['944d519c-1ed0-4711-a3b1-325bec5bbe56'],
    all: false,
    force: true,
  });
  expect(request?.headers.get('authorization')).toBe(`Bearer ${credential}`);
});

test('网络失败被归一为可分类错误且不会泄露 Credential', async () => {
  const client = new RunnerHttpClient(async () => {
    throw new Error(`failed with ${credential}`);
  }, 10);

  await expect(
    client.listBindings('https://apt.example.com', credential),
  ).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  try {
    await client.listBindings('https://apt.example.com', credential);
  } catch (error) {
    expect(error).toBeInstanceOf(RunnerHttpError);
    expect(String(error)).not.toContain(credential);
  }
});
