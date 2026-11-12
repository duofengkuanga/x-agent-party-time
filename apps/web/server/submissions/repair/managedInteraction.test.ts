import { expect, test } from 'bun:test';
import { testDatabases } from '@/testing/database';
import { mutation } from '@/testing/submissions/project';
import { RunnerHttpClient } from '@agent-party-time/runner-contract/http-client';
import {
  currentBug,
  repairFixture,
  repairProtocolFetch,
  startLatest,
} from './repairFixture';

const setup = repairFixture(testDatabases());

test('正式 Agent 协议确认释放可幂等重放，其他 Agent 不能释放原会话', async () => {
  const f = await setup();
  const started = await startLatest(f, 'protocol-yield');
  const http = new RunnerHttpClient(repairProtocolFetch(f));
  const request = {
    leaseToken: started.leaseToken,
    sessionId: started.sessionId,
    kind: 'USER_INPUT' as const,
    method: 'item/tool/requestUserInput',
    payload: { questions: [{ id: 'a', header: '继续', question: '继续？' }] },
  };
  await http.openInteraction(
    'https://fixture.test',
    f.pairedRunner.credential,
    started.executionId,
    request,
  );
  const yielded = await http.yieldInteraction(
    'https://fixture.test',
    f.pairedRunner.credential,
    started.executionId,
    request,
  );
  expect(yielded.state).toBe('WAITING_FOR_INTERACTION');
  expect(yielded.outcome).toBeNull();
  expect(
    (
      await http.yieldInteraction(
        'https://fixture.test',
        f.pairedRunner.credential,
        started.executionId,
        request,
      )
    ).state,
  ).toBe('WAITING_FOR_INTERACTION');
  await expect(
    http.yieldInteraction(
      'https://fixture.test',
      undefined,
      started.executionId,
      request,
    ),
  ).rejects.toThrow();
  const other = f.runners.pair(
    f.runners.issuePairingCode(f.users.owner.id).code,
    '其他 Agent',
  );
  await expect(
    http.yieldInteraction(
      'https://fixture.test',
      other.credential,
      started.executionId,
      request,
    ),
  ).rejects.toThrow();
});

test('工程负责人在平台回答异步修复问题，且权限只能批准当前请求', async () => {
  const f = await setup();
  const started = await startLatest(f, 'managed-repair');
  const execution = f.executions.get(started.executionId);
  expect(execution.approvalPolicy).toBe('on-request');
  expect(execution.codexTurn).toHaveProperty('managedInteractions', true);
  const interaction = f.executions.openInteraction(f.runner.id, started.executionId, {
    leaseToken: started.leaseToken,
    kind: 'USER_INPUT',
    method: 'xapt/asyncQuestions',
    payload: {
      itemId: 'question',
      turnId: 'turn',
      questions: [
        {
          id: 'question:0',
          header: '修复方案',
          question: '请选择修复方案',
          options: [
            { label: '保留布局', description: '' },
            { label: '调整布局', description: '' },
          ],
        },
      ],
    },
  });
  const view = f.repairs.repairView(f.users.developer.id, f.requested.bug.id)!;
  const attempt = view.timeline.find((node) => node.kind === 'REPAIR_ATTEMPT');
  expect(attempt).toMatchObject({
    interactions: [
      {
        kind: 'USER_INPUT',
        canResolve: true,
        request: {
          questions: [{ options: [{ label: '保留布局' }, { label: '调整布局' }] }],
        },
      },
    ],
  });
  const resolution = { answers: { 'question:0': { answers: ['保留布局'] } } };
  expect(() =>
    f.repairs.resolveInteraction(f.users.tester.id, interaction.id, {
      ...mutation(currentBug(f.database, f.requested.bug.id).version),
      resolution,
    }),
  ).toThrow('只有该工程负责人');
  f.repairs.resolveInteraction(f.users.developer.id, interaction.id, {
    ...mutation(currentBug(f.database, f.requested.bug.id).version),
    resolution,
  });
  await f.executions.waitInteraction(
    f.runner.id,
    started.executionId,
    interaction.id,
    started.leaseToken,
    0,
  );
  const approval = f.executions.openInteraction(f.runner.id, started.executionId, {
    leaseToken: started.leaseToken,
    kind: 'APPROVAL',
    method: 'item/commandExecution/requestApproval',
    payload: { command: 'bun test' },
  });
  expect(() =>
    f.repairs.resolveInteraction(f.users.developer.id, approval.id, {
      ...mutation(currentBug(f.database, f.requested.bug.id).version),
      resolution: { decision: 'acceptForSession' },
    }),
  ).toThrow('当前请求');
  f.repairs.resolveInteraction(f.users.developer.id, approval.id, {
    ...mutation(currentBug(f.database, f.requested.bug.id).version),
    resolution: { decision: 'decline' },
  });
  expect(f.executions.get(started.executionId)).toMatchObject({
    state: 'WAITING_TO_RESUME',
    outcome: null,
  });
});
