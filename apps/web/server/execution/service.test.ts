import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnqueueExecutionInput } from '@agent-party-time/execution-contract';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import { LocalFileStore } from '@/server/files/local-file-store';
import { RunnerService } from '@/server/runner/service';
import { ExecutionService } from './service';
import { createInitialCodexTurn } from './codex-turn';

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
  test('同 Binding 可排队但只串行 Claim，不同 Binding 可并行', async () => {
    const { executions, runnerId } = await setup();
    const first = executions.enqueue(input(runnerId, bindingId(1), 'first'));
    const second = executions.enqueue(input(runnerId, bindingId(1), 'second'));
    const other = executions.enqueue(input(runnerId, bindingId(2), 'other'));

    const claimed = await executions.claim(runnerId, 3, 0);
    expect(claimed.map(({ id }) => id).sort()).toEqual(
      [first.id, other.id].sort(),
    );
    expect(new Set(claimed.map(({ lease }) => lease.token)).size).toBe(2);
    expect(executions.get(second.id).state).toBe('QUEUED');
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
      payload: {
        questions: [
          { id: 'continue', header: '继续处理', question: '继续吗？' },
        ],
      },
    });
    expect(executions.activityForRunner(runnerId)).toEqual({
      activeExecutionCount: 1,
      waitingInteractionCount: 1,
    });
    executions.resolveInteraction(interaction.id, {
      answers: { continue: { answers: ['继续'] } },
    });
    expect(
      await executions.waitInteraction(
        runnerId,
        queued.id,
        interaction.id,
        token,
        0,
      ),
    ).toMatchObject({
      laneAcquired: true,
      interaction: {
        state: 'RESOLVED',
        resolution: { answers: { continue: { answers: ['继续'] } } },
      },
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

  test('Interaction 挂起释放同工程通道，处理后优先于普通 FIFO 恢复', async () => {
    const { executions, runnerId, setNow } = await setup();
    const binding = bindingId(6);
    const first = executions.enqueue(input(runnerId, binding, 'first'));
    const second = executions.enqueue(input(runnerId, binding, 'second'));
    const third = executions.enqueue(input(runnerId, binding, 'third'));
    const firstClaim = (await executions.claim(runnerId, 1, 0))[0]!;
    executions.start(runnerId, first.id, {
      kind: 'STARTED',
      leaseToken: firstClaim.lease.token,
      sessionId: 'session-first',
    });
    const interaction = executions.openInteraction(runnerId, first.id, {
      leaseToken: firstClaim.lease.token,
      kind: 'APPROVAL',
      method: 'item/commandExecution/requestApproval',
      payload: { command: 'bun test' },
    });

    const secondClaim = (await executions.claim(runnerId, 1, 0))[0]!;
    expect(secondClaim.id).toBe(second.id);
    executions.start(runnerId, second.id, {
      kind: 'STARTED',
      leaseToken: secondClaim.lease.token,
      sessionId: 'session-second',
    });

    setNow('2026-07-27T08:00:02.000Z');
    executions.resolveInteraction(interaction.id, { decision: 'accept' });
    expect(executions.get(first.id).state).toBe('WAITING_TO_RESUME');
    expect(executions.get(first.id).sessionId).toBe('session-first');
    expect(
      await executions.waitInteraction(
        runnerId,
        first.id,
        interaction.id,
        firstClaim.lease.token,
        0,
      ),
    ).toMatchObject({ laneAcquired: false });
    expect(executions.queueStatus(first.id)).toEqual({
      state: 'WAITING_TO_RESUME',
      aheadCount: 1,
    });
    expect(executions.queueStatus(third.id)).toEqual({
      state: 'QUEUED',
      aheadCount: 2,
    });
    expect(await executions.claim(runnerId, 1, 0)).toEqual([]);

    executions.complete(runnerId, second.id, {
      leaseToken: secondClaim.lease.token,
      sessionId: 'session-second',
      outcome: { kind: 'SUCCEEDED', result: { ok: true } },
    });
    expect(
      await executions.waitInteraction(
        runnerId,
        first.id,
        interaction.id,
        firstClaim.lease.token,
        0,
      ),
    ).toMatchObject({ laneAcquired: true });
    expect(executions.get(first.id).state).toBe('RUNNING');
    expect(await executions.claim(runnerId, 1, 0)).toEqual([]);

    executions.complete(runnerId, first.id, {
      leaseToken: firstClaim.lease.token,
      sessionId: 'session-first',
      outcome: { kind: 'SUCCEEDED', result: { ok: true } },
    });
    expect((await executions.claim(runnerId, 1, 0))[0]?.id).toBe(third.id);
  });

  test('Lease 过期保留待处理 Interaction，处理后由新 Agent 明确接管', async () => {
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
    expect(await executions.claim(runnerId, 1, 0)).toEqual([]);
    expect(executions.get(queued.id)).toMatchObject({
      state: 'WAITING_FOR_INTERACTION',
      lease: null,
      sessionId: 'session-resume',
    });
    expect(
      database
        .query<{ state: string }, [string]>(
          'SELECT state FROM platform_execution_interaction WHERE id = ?',
        )
        .get(interaction.id)?.state,
    ).toBe('PENDING');
    executions.resolveInteraction(interaction.id, { decision: 'accept' });
    const reclaimed = (await executions.claim(runnerId, 1, 0))[0]!;
    expect(reclaimed.id).toBe(queued.id);
    expect(reclaimed.sessionId).toBe('session-resume');
    expect(reclaimed.lease.token).not.toBe(firstClaim.lease.token);
    expect(reclaimed.recoveredInteraction).toEqual({
      method: 'item/commandExecution/requestApproval',
      payload: { command: 'safe-tool' },
      resolution: { decision: 'accept' },
    });
    expect(() =>
      executions.complete(runnerId, queued.id, {
        leaseToken: firstClaim.lease.token,
        sessionId: 'session-resume',
        outcome: { kind: 'SUCCEEDED', result: null },
      }),
    ).toThrow(expect.objectContaining({ code: 'LEASE_EXPIRED' }));
  });

  test('取消中的 Execution 在 Lease 过期后终止并释放工程通道', async () => {
    const { executions, runnerId, setNow } = await setup();
    const binding = bindingId(8);
    const cancelled = executions.enqueue(input(runnerId, binding, 'cancelled'));
    const next = executions.enqueue(input(runnerId, binding, 'next'));
    const claim = (await executions.claim(runnerId, 1, 0))[0]!;
    executions.start(runnerId, cancelled.id, {
      kind: 'STARTED',
      leaseToken: claim.lease.token,
      sessionId: 'session-cancelled',
    });
    expect(executions.requestCancellation(cancelled.id).state).toBe(
      'CANCEL_REQUESTED',
    );

    setNow('2026-07-27T08:00:11.000Z');
    expect((await executions.claim(runnerId, 1, 0))[0]?.id).toBe(next.id);
    expect(executions.get(cancelled.id)).toMatchObject({
      state: 'CANCELLED',
      outcome: {
        kind: 'CANCELLED',
        reason: '取消中的任务因 Agent 失联而终止',
      },
    });
  });

  test('等待交互或等待恢复的 Execution 取消后立即终止并释放工程通道', async () => {
    const { database, executions, runnerId } = await setup();
    const binding = bindingId(9);
    const waitingInteraction = executions.enqueue(
      input(runnerId, binding, 'waiting-interaction'),
    );
    const next = executions.enqueue(input(runnerId, binding, 'next'));
    const interactionClaim = (await executions.claim(runnerId, 1, 0))[0]!;
    executions.start(runnerId, waitingInteraction.id, {
      kind: 'STARTED',
      leaseToken: interactionClaim.lease.token,
      sessionId: 'session-waiting-interaction',
    });
    const interaction = executions.openInteraction(
      runnerId,
      waitingInteraction.id,
      {
        leaseToken: interactionClaim.lease.token,
        kind: 'APPROVAL',
        method: 'item/commandExecution/requestApproval',
        payload: { command: 'bun test' },
      },
    );

    expect(executions.requestCancellation(waitingInteraction.id)).toMatchObject(
      {
        state: 'CANCELLED',
        lease: null,
        cancellationRequested: true,
      },
    );
    expect(
      database
        .query<{ state: string }, [string]>(
          'SELECT state FROM platform_execution_interaction WHERE id = ?',
        )
        .get(interaction.id)?.state,
    ).toBe('INVALIDATED');
    expect((await executions.claim(runnerId, 1, 0))[0]?.id).toBe(next.id);

    const resumeBinding = bindingId(10);
    const waitingResume = executions.enqueue(
      input(runnerId, resumeBinding, 'waiting-resume'),
    );
    const blocker = executions.enqueue(
      input(runnerId, resumeBinding, 'blocker'),
    );
    const following = executions.enqueue(
      input(runnerId, resumeBinding, 'following'),
    );
    const resumeClaim = (await executions.claim(runnerId, 1, 0))[0]!;
    executions.start(runnerId, waitingResume.id, {
      kind: 'STARTED',
      leaseToken: resumeClaim.lease.token,
      sessionId: 'session-waiting-resume',
    });
    const resolved = executions.openInteraction(runnerId, waitingResume.id, {
      leaseToken: resumeClaim.lease.token,
      kind: 'APPROVAL',
      method: 'item/commandExecution/requestApproval',
      payload: { command: 'bun test' },
    });
    const blockerClaim = (await executions.claim(runnerId, 1, 0))[0]!;
    expect(blockerClaim.id).toBe(blocker.id);
    executions.start(runnerId, blocker.id, {
      kind: 'STARTED',
      leaseToken: blockerClaim.lease.token,
      sessionId: 'session-blocker',
    });
    executions.resolveInteraction(resolved.id, { decision: 'accept' });

    expect(executions.requestCancellation(waitingResume.id)).toMatchObject({
      state: 'CANCELLED',
      lease: null,
      cancellationRequested: true,
    });
    expect(executions.get(waitingResume.id).outcome).toEqual({
      kind: 'CANCELLED',
      reason: '服务端已请求取消',
    });
    executions.complete(runnerId, blocker.id, {
      leaseToken: blockerClaim.lease.token,
      sessionId: 'session-blocker',
      outcome: { kind: 'SUCCEEDED', result: null },
    });
    expect((await executions.claim(runnerId, 1, 0))[0]?.id).toBe(following.id);
  });

  test('领取候选显式排除 cancellation_requested Execution', async () => {
    const { database, executions, runnerId } = await setup();
    const binding = bindingId(11);
    const cancelled = executions.enqueue(
      input(runnerId, binding, 'cancelled-candidate'),
    );
    const available = executions.enqueue(
      input(runnerId, binding, 'available-candidate'),
    );
    database
      .prepare(
        `UPDATE platform_execution
         SET cancellation_requested = 1
         WHERE id = ?`,
      )
      .run(cancelled.id);

    const claimed = await executions.claim(runnerId, 2, 0);
    expect(claimed.map(({ id }) => id)).toEqual([available.id]);
    expect(executions.get(cancelled.id).state).toBe('QUEUED');
  });

  test('等待恢复状态在 Lease 过期后持久保留并在普通 FIFO 前重新领取', async () => {
    const { executions, runnerId, setNow } = await setup();
    const binding = bindingId(7);
    const first = executions.enqueue(input(runnerId, binding, 'resume-first'));
    const second = executions.enqueue(
      input(runnerId, binding, 'resume-second'),
    );
    const third = executions.enqueue(input(runnerId, binding, 'resume-third'));
    const firstClaim = (await executions.claim(runnerId, 1, 0))[0]!;
    executions.start(runnerId, first.id, {
      kind: 'STARTED',
      leaseToken: firstClaim.lease.token,
      sessionId: 'session-persisted-resume',
    });
    const interaction = executions.openInteraction(runnerId, first.id, {
      leaseToken: firstClaim.lease.token,
      kind: 'APPROVAL',
      method: 'item/commandExecution/requestApproval',
      payload: { command: 'bun test' },
    });
    const secondClaim = (await executions.claim(runnerId, 1, 0))[0]!;
    executions.start(runnerId, second.id, {
      kind: 'STARTED',
      leaseToken: secondClaim.lease.token,
      sessionId: 'session-second-running',
    });
    setNow('2026-07-27T08:00:02.000Z');
    executions.resolveInteraction(interaction.id, { decision: 'accept' });
    setNow('2026-07-27T08:00:09.000Z');
    executions.renew(runnerId, second.id, secondClaim.lease.token);
    setNow('2026-07-27T08:00:11.000Z');
    expect(await executions.claim(runnerId, 1, 0)).toEqual([]);
    expect(executions.get(first.id)).toMatchObject({
      state: 'WAITING_TO_RESUME',
      lease: null,
      sessionId: 'session-persisted-resume',
    });
    executions.complete(runnerId, second.id, {
      leaseToken: secondClaim.lease.token,
      sessionId: 'session-second-running',
      outcome: { kind: 'SUCCEEDED', result: { ok: true } },
    });
    const reclaimed = (await executions.claim(runnerId, 1, 0))[0]!;
    expect(reclaimed.id).toBe(first.id);
    expect(reclaimed.sessionId).toBe('session-persisted-resume');
    expect(reclaimed.recoveredInteraction).toEqual({
      method: 'item/commandExecution/requestApproval',
      payload: { command: 'bun test' },
      resolution: { decision: 'accept' },
    });
    expect(executions.get(third.id).state).toBe('QUEUED');
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

  test('首次 Codex Start 校验并持久化 Task Skill Binding', async () => {
    const { executions, runnerId } = await setup();
    const queued = executions.enqueue({
      ...input(runnerId, bindingId(6), 'skill-binding'),
      codexTurn: createInitialCodexTurn({
        requiredSkillName: 'agent-party-time-repair-bug',
        executionBrief: { bug: { id: 'bug-1' } },
        outputJsonSchema: { type: 'object' },
      }),
    });
    const claimed = (await executions.claim(runnerId, 1, 0))[0]!;
    const binding = {
      skillName: 'agent-party-time-repair-bug',
      bundleHash: 'a'.repeat(64),
      sourceRevision: 'b'.repeat(40),
    };

    const started = executions.start(runnerId, queued.id, {
      kind: 'STARTED',
      leaseToken: claimed.lease.token,
      sessionId: 'task-one',
      taskSkillBinding: binding,
    });

    expect(started.codexTurn).toMatchObject({
      kind: 'INITIAL',
      taskSkillBinding: binding,
    });
  });
});

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
    workspace: null,
    attachmentIds: [],
  };
}

function bindingId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}
