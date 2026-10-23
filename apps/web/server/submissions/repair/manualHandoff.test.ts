import { testRepairHandoff } from '@/testing/submissions/handoff';
import { expect, test } from 'bun:test';
import { testDatabases } from '@/testing/database';
import { mutation } from '@/testing/submissions/project';
import { completeClaimedExecution } from '@/testing/submissions/execution';
import { repairFixture, startLatest, currentBug } from './repairFixture';

const setup = repairFixture(testDatabases());

test('人工接管保留等待状态和问题，负责人同步最新结果后追加尝试', async () => {
  const f = await setup();
  const bugId = f.requested.bug.id;
  const started = await startLatest(f, 'manual-session');
  const questions = ['确认移除区县大屏权限？'];
  const interaction = f.executions.openInteraction(f.runner.id, started.executionId, {
    leaseToken: started.leaseToken,
    kind: 'USER_INPUT',
    method: 'xapt/manualHandoff',
    payload: { questions },
  });
  const preparing = f.repairs.repairView(f.users.developer.id, bugId)!;
  expect(preparing.presentation.visual.label).toContain('正在释放会话');
  expect(preparing.availableActions).toEqual([]);
  expect(() =>
    f.executions.resolveInteraction(interaction.id, { answers: {} }),
  ).toThrow();
  const receipt = { kind: 'HANDED_OFF' as const, questions };
  completeClaimedExecution(f, started, receipt);
  // Re-delivery must not append another handoff or change the original record.
  completeClaimedExecution(f, started, receipt);
  const view = f.repairs.repairView(f.users.developer.id, bugId)!;
  expect(view.presentation.visual).toMatchObject({ label: '等待人工确认' });
  expect(view.availableActions).toEqual(['SYNC_SESSION']);
  const attempt = view.timeline.find((n) => n.kind === 'REPAIR_ATTEMPT');
  expect(attempt).toMatchObject({
    sessionId: 'manual-session',
    result: { outcome: 'HANDED_OFF', questions },
  });
  expect(JSON.stringify(f.repairs.repairView(f.users.tester.id, bugId))).not.toContain(
    questions[0]!,
  );
  expect(await f.executions.claim(f.runner.id, 3, 0)).toEqual([]);
  expect(currentBug(f.database, bugId).stage).toBe('REPAIRING');

  const sync = () =>
    f.repairs.synchronizeSession(
      f.users.developer.id,
      bugId,
      mutation(currentBug(f.database, bugId).version),
    );
  const unavailable = sync();
  const first = (await f.executions.claim(f.runner.id, 1, 0))[0]!;
  expect(first.id).toBe(unavailable.executionId);
  f.executions.start(f.runner.id, first.id, {
    kind: 'START_FAILED',
    leaseToken: first.lease.token,
    failure: {
      code: 'CODEX_EXECUTION_FAILED',
      message: '最新轮次尚未完成，请完成后再同步',
      retryable: true,
    },
  });
  expect(
    f.repairs.repairView(f.users.developer.id, bugId)!.presentation.visual.label,
  ).toBe('等待人工确认');
  const ready = sync();
  const claimed = (await f.executions.claim(f.runner.id, 1, 0))[0]!;
  expect(claimed.id).toBe(ready.executionId);
  expect(claimed.codexTurn?.kind).toBe('READ_SESSION');
  f.executions.start(f.runner.id, claimed.id, {
    kind: 'STARTED',
    leaseToken: claimed.lease.token,
    sessionId: 'manual-session',
    taskSkillBinding: null,
  });
  f.executions.complete(f.runner.id, claimed.id, {
    leaseToken: claimed.lease.token,
    sessionId: 'manual-session',
    outcome: {
      kind: 'SUCCEEDED',
      result: {
        turnId: 'finished-turn',
        result: {
          result: {
            outcome: 'COMPLETED',
            completionKind: 'CHANGES_COMMITTED',
            handoff: testRepairHandoff(),
            changes: ['移除权限'],
            validations: [{ name: '回归', status: 'PASSED', detail: '' }],
            warnings: [],
            commits: ['abcdef1111111111111111111111111111111111'],
            manualOperations: [],
          },
        },
      },
    },
  });
  expect(currentBug(f.database, bugId).stage).toBe('WAITING_FOR_UPDATE');
  expect(f.executions.get(started.executionId).state).toBe('HANDED_OFF');
  expect(
    f.repairs
      .repairView(f.users.developer.id, bugId)!
      .timeline.filter((n) => n.kind === 'REPAIR_ATTEMPT'),
  ).toHaveLength(2);
});
