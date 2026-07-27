import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnqueueExecutionInput } from '@agent-party-time/execution-contract';
import { AuthService } from '@/platform/auth/service';
import type { AppDatabase } from '@/platform/database';
import { openDatabase } from '@/platform/database';
import { LocalFileStore } from '@/platform/files/local-file-store';
import { RunnerService } from '@/platform/runner/service';
import { ExecutionService } from './service';

const directories: string[] = [];
const databases: AppDatabase[] = [];

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-execution-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
  const user = await new AuthService(database).seedUser({
    id: 'execution-user',
    username: 'execution-user',
    displayName: 'Execution 用户',
    password: 'password',
  });
  const runners = new RunnerService(database);
  const paired = runners.pair(
    runners.issuePairingCode(user.id).code,
    'Execution Runner',
  );
  let now = new Date('2026-07-27T08:00:00.000Z');
  let leaseIndex = 0;
  const executions = new ExecutionService(
    database,
    () => now,
    undefined,
    () => `lease-token-${String(++leaseIndex).padEnd(32, 'x')}`,
    10_000,
  );
  const files = new LocalFileStore(database, join(directory, 'files'));
  return {
    database,
    executions,
    files,
    paired,
    runnerId: paired.runner.id,
    user,
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
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Execution lifecycle', () => {
  test('Binding Reservation 阻止同 Binding 并发并允许不同 Binding 并行', async () => {
    const { executions, runnerId } = await setup();
    const first = executions.enqueue(input(runnerId, bindingId(1), 'first'));
    expect(() =>
      executions.enqueue(input(runnerId, bindingId(1), 'second')),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    const other = executions.enqueue(input(runnerId, bindingId(2), 'other'));

    const claimed = await executions.claim(runnerId, 2, 0);
    expect(claimed.map(({ id }) => id).sort()).toEqual(
      [first.id, other.id].sort(),
    );
    expect(new Set(claimed.map(({ lease }) => lease.token)).size).toBe(2);
  });

  test('Start、Renew、Interaction 和不可变 Outcome 形成完整状态机', async () => {
    const { executions, runnerId, setNow } = await setup();
    const queued = executions.enqueue(input(runnerId, bindingId(3), 'flow'));
    const claimed = (await executions.claim(runnerId, 1, 0))[0]!;
    const token = claimed.lease.token;
    expect(
      executions.start(runnerId, queued.id, {
        kind: 'STARTED',
        leaseToken: token,
        sessionId: 'session-flow',
      }).state,
    ).toBe('RUNNING');

    setNow('2026-07-27T08:00:02.000Z');
    expect(executions.renew(runnerId, queued.id, token)).toEqual({
      expiresAt: '2026-07-27T08:00:12.000Z',
      cancellationRequested: false,
    });
    const interaction = executions.openInteraction(runnerId, queued.id, {
      leaseToken: token,
      kind: 'USER_INPUT',
      method: 'item/tool/requestUserInput',
      payload: { question: '继续吗？' },
    });
    expect(executions.activityForRunner(runnerId)).toEqual({
      activeExecutionCount: 1,
      waitingInteractionCount: 1,
    });
    executions.resolveInteraction(interaction.id, { answer: '继续' });
    expect(
      await executions.waitInteraction(
        runnerId,
        queued.id,
        interaction.id,
        token,
        0,
      ),
    ).toMatchObject({
      state: 'RESOLVED',
      resolution: { answer: '继续' },
    });

    const completion = {
      leaseToken: token,
      sessionId: 'session-flow',
      outcome: { kind: 'SUCCEEDED' as const, result: { ok: true } },
    };
    expect(executions.complete(runnerId, queued.id, completion).state).toBe(
      'SUCCEEDED',
    );
    expect(executions.complete(runnerId, queued.id, completion).state).toBe(
      'SUCCEEDED',
    );
    expect(() =>
      executions.complete(runnerId, queued.id, {
        ...completion,
        outcome: { kind: 'SUCCEEDED', result: { ok: false } },
      }),
    ).toThrow(expect.objectContaining({ code: 'OUTCOME_CONFLICT' }));
    expect(executions.activityForRunner(runnerId).activeExecutionCount).toBe(0);
  });

  test('Lease 过期会使 Interaction 失效、保留 Session 并拒绝旧 Token', async () => {
    const { database, executions, runnerId, setNow } = await setup();
    const queued = executions.enqueue(input(runnerId, bindingId(4), 'lease'));
    const firstClaim = (await executions.claim(runnerId, 1, 0))[0]!;
    executions.start(runnerId, queued.id, {
      kind: 'STARTED',
      leaseToken: firstClaim.lease.token,
      sessionId: 'session-resume',
    });
    const interaction = executions.openInteraction(runnerId, queued.id, {
      leaseToken: firstClaim.lease.token,
      kind: 'APPROVAL',
      method: 'item/commandExecution/requestApproval',
      payload: { command: 'safe-tool' },
    });

    setNow('2026-07-27T08:00:11.000Z');
    const reclaimed = (await executions.claim(runnerId, 1, 0))[0]!;
    expect(reclaimed.id).toBe(queued.id);
    expect(reclaimed.resumeSessionId).toBe('session-resume');
    expect(reclaimed.lease.token).not.toBe(firstClaim.lease.token);
    expect(
      database
        .query<{ state: string }, [string]>(
          'SELECT state FROM platform_execution_interaction WHERE id = ?',
        )
        .get(interaction.id)?.state,
    ).toBe('INVALIDATED');
    expect(() =>
      executions.complete(runnerId, queued.id, {
        leaseToken: firstClaim.lease.token,
        sessionId: 'session-resume',
        outcome: { kind: 'SUCCEEDED', result: null },
      }),
    ).toThrow(expect.objectContaining({ code: 'LEASE_EXPIRED' }));
  });

  test('Start Failure 明确终结 Execution，附件仅活动 Lease 可授权', async () => {
    const { executions, files, runnerId, user } = await setup();
    const file = await files.put({
      bytes: new TextEncoder().encode('attachment'),
      originalName: '说明.txt',
      mediaType: 'text/plain',
      uploadedByUserId: user.id,
    });
    const queued = executions.enqueue({
      ...input(runnerId, bindingId(5), 'attachment'),
      attachmentIds: [file.id],
    });
    const claimed = (await executions.claim(runnerId, 1, 0))[0]!;
    expect(
      executions.authorizeFile(
        runnerId,
        queued.id,
        claimed.lease.token,
        file.id,
      ),
    ).toMatchObject({ file_id: file.id, sha256: file.sha256 });
    const failed = executions.start(runnerId, queued.id, {
      kind: 'START_FAILED',
      leaseToken: claimed.lease.token,
      failure: {
        code: 'REPOSITORY_NOT_FOUND',
        message: '本机仓库目录不存在',
        retryable: true,
      },
    });
    expect(failed).toMatchObject({
      state: 'FAILED',
      outcome: {
        kind: 'FAILED',
        failure: { code: 'REPOSITORY_NOT_FOUND' },
      },
    });
    expect(() =>
      executions.authorizeFile(
        runnerId,
        queued.id,
        claimed.lease.token,
        file.id,
      ),
    ).toThrow(expect.objectContaining({ code: 'LEASE_EXPIRED' }));
  });
});

function input(
  runnerId: string,
  localBindingId: string,
  ownerId: string,
): EnqueueExecutionInput {
  const prompt = `通用任务 ${ownerId}`;
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
