import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnqueueExecutionInput } from '@agent-party-time/execution-contract';
import {
  ProtocolAgent,
  ProtocolError,
} from '@agent-party-time/runner-conformance';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import {
  handleExecutionClaim,
  handleExecutionComplete,
  handleExecutionFile,
  handleExecutionRenew,
  handleExecutionStart,
  handleOpenInteraction,
  handleWaitInteraction,
} from '@/server/execution/http';
import { ExecutionService } from '@/server/execution/service';
import { LocalFileStore } from '@/server/files/local-file-store';
import {
  handleRunnerAuthorizationClaim,
  handleRunnerAuthorizationCreate,
  handleRunnerBindingConfirmation,
  handleRunnerBindings,
  handleRunnerHeartbeat,
} from '@/server/runner/http';
import { RunnerService } from '@/server/runner/service';

const directories: string[] = [];
const databases: AppDatabase[] = [];

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'runner-conformance-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
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

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
): typeof fetch {
  return async (inputValue, init) => {
    const request =
      inputValue instanceof Request
        ? inputValue
        : new Request(String(inputValue), init);
    const path = new URL(request.url).pathname;
    if (path === '/api/runner/authorizations')
      return handleRunnerAuthorizationCreate(request, runners);
    const authorizationClaim =
      /^\/api\/runner\/authorizations\/([^/]+)\/claim$/u.exec(path);
    if (authorizationClaim)
      return handleRunnerAuthorizationClaim(
        request,
        authorizationClaim[1]!,
        runners,
      );
    if (path === '/api/runner/heartbeat')
      return handleRunnerHeartbeat(request, runners);
    if (path === '/api/runner/bindings' && request.method === 'GET')
      return handleRunnerBindings(request, runners, () =>
        [...bindingRefs].map((bindingId) => ({ bindingId })),
      );
    if (path === '/api/runner/bindings' && request.method === 'POST')
      return handleRunnerBindingConfirmation(
        request,
        runners,
        (_runnerId, _bindingId, repositoryUrl) => repositoryUrl,
      );
    if (path === '/api/runner/executions/claim')
      return handleExecutionClaim(request, runners, executions);
    const executionMatch =
      /^\/api\/runner\/executions\/([^/]+)\/([^/]+)$/u.exec(path);
    if (executionMatch) {
      const [, executionId, operation] = executionMatch;
      if (operation === 'start')
        return handleExecutionStart(request, executionId!, runners, executions);
      if (operation === 'renew')
        return handleExecutionRenew(request, executionId!, runners, executions);
      if (operation === 'complete')
        return handleExecutionComplete(
          request,
          executionId!,
          runners,
          executions,
        );
    }
    const openMatch =
      /^\/api\/runner\/executions\/([^/]+)\/interactions\/open$/u.exec(path);
    if (openMatch)
      return handleOpenInteraction(request, openMatch[1]!, runners, executions);
    const waitMatch = /^\/api\/runner\/interactions\/([^/]+)\/wait$/u.exec(
      path,
    );
    if (waitMatch)
      return handleWaitInteraction(request, waitMatch[1]!, runners, executions);
    const fileMatch =
      /^\/api\/runner\/executions\/([^/]+)\/files\/([^/]+)$/u.exec(path);
    if (fileMatch)
      return handleExecutionFile(
        request,
        fileMatch[1]!,
        fileMatch[2]!,
        runners,
        executions,
        files,
      );
    return Response.json(
      { error: { code: 'NOT_FOUND', message: '未找到' } },
      { status: 404 },
    );
  };
}

function input(
  runnerId: string,
  localBindingId: string,
  ownerId: string,
): EnqueueExecutionInput {
  const prompt = `fixture ${ownerId}`;
  return {
    owner: { namespace: 'fixture', kind: 'generic', id: ownerId },
    attempt: 1,
    previousExecutionId: null,
    runnerId,
    bindingId: localBindingId,
    promptKind: 'fixture.generic',
    promptVersion: 1,
    renderedPrompt: prompt,
    renderedPromptHash: createHash('sha256').update(prompt).digest('hex'),
    outputJsonSchema: { type: 'object' },
    attachmentIds: [],
    resumeSessionId: null,
  };
}

function bindingId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}
