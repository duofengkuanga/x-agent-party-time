import { runnerFetch } from '@/platform/runner/router';
import { AuthService } from '@/platform/auth/service';
import { ExecutionService } from '@/platform/execution/service';
import { LocalFileStore } from '@/platform/files/local-file-store';
import { RunnerService } from '@/platform/runner/service';
import { testDatabases } from '@/testing/database';
import type { EnqueueExecutionInput } from '@agent-party-time/execution-contract';
import {
  ProtocolAgent,
  ProtocolError,
} from '@agent-party-time/runner-conformance';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const createDatabase = testDatabases();

async function setup() {
  const { directory, database } = await createDatabase();
  const user = await new AuthService(database).seedUser({
    id: 'conformance-user',
    username: 'conformance-user',
    displayName: 'Conformance 用户',
    password: 'password',
  });
  const runners = new RunnerService(database);
  const paired = runners.pair(
    runners.issuePairingCode(user.id).code,
    'Conformance Agent',
  );
  const executions = new ExecutionService(database);
  const files = new LocalFileStore(database, join(directory, 'server-files'));
  const bindingRefs = new Set<string>();
  const dispatch = protocolFetch(runners, executions, files, bindingRefs);
  const agent = new ProtocolAgent({
    serverUrl: 'http://server.test',
    fetch: dispatch,
    credential: paired.credential,
  });
  return {
    agent,
    bindingRefs,
    database,
    dispatch,
    executions,
    files,
    paired,
    runners,
    user,
  };
}

describe('Runner Contract Conformance Harness', () => {
  test('缺失或错误 Credential 被拒绝，正确 Credential 可心跳', async () => {
    const fixture = await setup();
    const missing = new ProtocolAgent({
      serverUrl: 'http://server.test',
      fetch: fixture.dispatch,
    });
    const wrong = new ProtocolAgent({
      serverUrl: 'http://server.test',
      fetch: fixture.dispatch,
      credential: `wrong-${'x'.repeat(32)}`,
    });

    await expect(missing.heartbeat()).rejects.toMatchObject({
      status: 401,
    });
    await expect(wrong.heartbeat()).rejects.toMatchObject({ status: 401 });
    expect(await fixture.agent.heartbeat()).toMatchObject({
      id: fixture.paired.runner.id,
    });
  });

  test('浏览器授权通过正式 Contract 领取 Credential 并用于后续请求', async () => {
    const fixture = await setup();
    const agent = new ProtocolAgent({
      serverUrl: 'http://server.test',
      fetch: fixture.dispatch,
    });
    const verifier = 'v'.repeat(43);
    const issue = await agent.createAuthorization({
      installationId: '00000000-0000-4000-8000-000000000010',
      verifier,
      fingerprint: 'AAAA-BBBB-CCCC',
      suggestedName: '授权 Agent',
    });
    const approval = fixture.runners.prepareAuthorizationApproval(
      fixture.user.id,
      issue.requestId,
    );
    fixture.runners.approveAuthorization(
      fixture.user.id,
      issue.requestId,
      approval.approvalToken!,
      '授权 Agent',
    );

    const claimed = await agent.claimAuthorization(issue.requestId, verifier);
    expect(claimed.state).toBe('AUTHORIZED');
    expect(await agent.heartbeat()).toMatchObject({ name: '授权 Agent' });
  });

  test('Binding Contract 不接收或返回本机绝对路径', async () => {
    const fixture = await setup();
    const id = bindingId(1);

    const confirmed = await fixture.agent.confirmBinding(
      id,
      'git@example.com:team/repository.git',
    );
    fixture.bindingRefs.add(id);

    expect(confirmed).toEqual({
      bindingId: id,
      repositoryUrl: 'https://example.com/team/repository.git',
    });
    expect(await fixture.agent.listBindings()).toEqual([{ bindingId: id }]);
    expect(JSON.stringify({ confirmed })).not.toMatch(
      /repositoryPath|\/Users\/|\/tmp\//,
    );
  });

  test('Execution、附件与 Outcome 严格穿过 HTTP Contract', async () => {
    const fixture = await setup();
    const binding = bindingId(2);
    const file = await fixture.files.put({
      bytes: new TextEncoder().encode('fixture attachment'),
      originalName: 'fixture.txt',
      mediaType: 'text/plain',
      uploadedByUserId: fixture.user.id,
    });
    const execution = fixture.executions.enqueue({
      ...input(fixture.paired.runner.id, binding, 'happy-path'),
      attachmentIds: [file.id],
    });

    const completed = await fixture.agent.runNext(async (claimed) => ({
      kind: 'SUCCEEDED',
      result: {
        attachment: new TextDecoder().decode(
          await fixture.agent.downloadExecutionFile(
            claimed.id,
            claimed.attachments[0]!.id,
            claimed.lease.token,
          ),
        ),
      },
    }));

    expect(completed).toMatchObject({
      id: execution.id,
      state: 'SUCCEEDED',
      outcome: {
        kind: 'SUCCEEDED',
        result: { attachment: 'fixture attachment' },
      },
    });
  });

  test('Interaction 解决后通过 wait Contract 恢复同一 Execution', async () => {
    const fixture = await setup();
    const execution = fixture.executions.enqueue(
      input(fixture.paired.runner.id, bindingId(3), 'interaction'),
    );
    const claimed = await fixture.agent.waitForExecution({ timeoutMs: 500 });
    const sessionId = `session-${claimed.id}`;
    await fixture.agent.startExecution(claimed.id, {
      kind: 'STARTED',
      leaseToken: claimed.lease.token,
      sessionId,
      taskSkillBinding: null,
    });
    const interaction = await fixture.agent.openInteraction(claimed.id, {
      leaseToken: claimed.lease.token,
      kind: 'USER_INPUT',
      method: 'item/tool/requestUserInput',
      payload: {
        questions: [
          {
            id: 'continue',
            header: '继续',
            question: '继续执行吗？',
            options: [],
          },
        ],
      },
    });
    fixture.executions.resolveInteraction(interaction.id, {
      answers: { continue: { answers: ['继续'] } },
    });

    const waited = await fixture.agent.waitInteraction(
      claimed.id,
      interaction.id,
      claimed.lease.token,
      0,
    );
    expect(waited).toMatchObject({
      laneAcquired: true,
      interaction: { state: 'RESOLVED' },
    });
    const completed = await fixture.agent.completeExecution(claimed.id, {
      leaseToken: claimed.lease.token,
      sessionId,
      outcome: { kind: 'SUCCEEDED', result: { resumed: true } },
    });
    expect(completed).toMatchObject({ id: execution.id, state: 'SUCCEEDED' });
  });

  test('失败请求与非法 Outcome 在协议 seam 明确失败', async () => {
    const fixture = await setup();
    const execution = fixture.executions.enqueue(
      input(fixture.paired.runner.id, bindingId(4), 'invalid-outcome'),
    );
    const next = await fixture.agent.waitForExecution({ timeoutMs: 500 });
    await fixture.agent.startExecution(next.id, {
      kind: 'STARTED',
      leaseToken: next.lease.token,
      sessionId: 'invalid-session',
      taskSkillBinding: null,
    });
    await expect(
      fixture.agent.completeExecution(execution.id, {
        leaseToken: next.lease.token,
        sessionId: 'invalid-session',
        outcome: { kind: 'UNKNOWN' },
      } as never),
    ).rejects.toThrow();
    await expect(
      fixture.agent.completeExecution(execution.id, {
        leaseToken: `wrong-${'x'.repeat(32)}`,
        sessionId: 'invalid-session',
        outcome: { kind: 'SUCCEEDED', result: {} },
      }),
    ).rejects.toBeInstanceOf(ProtocolError);
  });
});

function protocolFetch(
  runners: RunnerService,
  executions: ExecutionService,
  files: LocalFileStore,
  bindingRefs: Set<string>,
): ReturnType<typeof runnerFetch> {
  return runnerFetch({
    runners,
    executions,
    files,
    prepare: () => {},
    bindings: {
      list: () => [...bindingRefs].map((bindingId) => ({ bindingId })),
      confirm: (_runnerId, _bindingId, repositoryUrl) => repositoryUrl,
      claim: () => null,
      complete: () => 'FAILED',
    },
  });
}

function input(
  runnerId: string,
  localBindingId: string,
  ownerId: string,
): EnqueueExecutionInput {
  return {
    owner: { namespace: 'fixture', kind: 'generic', id: ownerId },
    attempt: 1,
    previousExecutionId: null,
    runnerId,
    bindingId: localBindingId,
    approvalPolicy: 'on-request',
    codexTurn: null,
    attachmentIds: [],
  };
}

function bindingId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

test('正式 Runner 路由保留认证顺序、方法限制和 HEAD 响应', async () => {
  const fixture = await setup();
  for (const [method, path, status] of [
    ['DELETE', '', 401],
    ['POST', '/pair', 400],
    ['POST', '/authorizations', 400],
    ['POST', '/authorizations/request/claim', 400],
    ['POST', '/heartbeat', 401],
    ['GET', '/bindings', 401],
    ['POST', '/bindings', 401],
    ['POST', '/binding-requests', 401],
    ['POST', '/binding-requests/request', 401],
    ['POST', '/executions/claim', 401],
    ['POST', '/executions/execution/start', 401],
    ['POST', '/executions/execution/renew', 401],
    ['POST', '/executions/execution/complete', 401],
    ['POST', '/executions/execution/interactions/open', 401],
    ['POST', '/interactions/interaction/wait', 401],
    ['GET', '/executions/execution/files/file', 401],
    ['GET', '/heartbeat', 405],
    ['PATCH', '/bindings', 405],
    ['GET', '/unknown', 404],
  ] as const) {
    const response = await fixture.dispatch(
      `http://server.test/api/runner${path}`,
      { method },
    );
    expect(response.status, `${method} ${path}`).toBe(status);
  }
  const head = await fixture.dispatch(
    'http://server.test/api/runner/bindings',
    { method: 'HEAD' },
  );
  expect(head.status).toBe(401);
  expect(await head.text()).toBe('');
  expect(head.headers.get('cache-control')).toBe('no-store');
});
