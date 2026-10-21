import { expect, test } from 'bun:test';
import { testDatabases } from '@/testing/database';
import { mutation } from '@/cooking/testing/project';
import {
  completeClaimedExecution,
  completeSuccessfulExecution,
} from '@/cooking/testing/execution';
import {
  updateFixture,
  startCandidateUpdate,
  latestBatch,
  completedUpdate,
  currentBug,
} from './updateFixture';

const setup = updateFixture(testDatabases());
test('更新会话交给人工后不判失败，原会话同步完成才推进待验证', async () => {
  const f = await setup();
  const { bug, started } = await startCandidateUpdate(
    f,
    '人工确认更新',
    'repair',
    ['abcdef1111111111111111111111111111111111'],
    'update-manual',
  );
  const questions = ['确认本次更新范围？'];
  f.executions.openInteraction(f.runner.id, started.executionId, {
    leaseToken: started.leaseToken,
    kind: 'USER_INPUT',
    method: 'xapt/manualHandoff',
    payload: { questions },
  });
  completeClaimedExecution(f, started, { kind: 'HANDED_OFF', questions });
  const batch = latestBatch(f.database, f.item.id);
  expect(batch.state).toBe('RUNNING');
  const view = f.updates.batchView(f.users.developer.id, batch.id);
  expect(view.presentation.visual.label).toBe('等待人工确认');
  expect(view.availableActions).toEqual(['SYNC_SESSION']);
  expect(JSON.stringify(f.updates.batchView(f.users.tester.id, batch.id))).not.toContain(
    questions[0]!,
  );
  const sync = f.updates.synchronizeSession(
    f.users.developer.id,
    batch.id,
    mutation(batch.version),
  );
  const claimed = (await f.executions.claim(f.runner.id, 1, 0))[0]!;
  expect(claimed.id).toBe(sync.executionId);
  f.executions.start(f.runner.id, claimed.id, {
    kind: 'STARTED',
    leaseToken: claimed.lease.token,
    sessionId: 'update-manual',
    taskSkillBinding: null,
  });
  const read = {
    executionId: claimed.id,
    leaseToken: claimed.lease.token,
    sessionId: 'update-manual',
  };
  completeSuccessfulExecution(f, read, {
    turnId: 'manual-finished',
    result: completedUpdate(),
  });
  expect(latestBatch(f.database, f.item.id).state).toBe('COMPLETED');
  expect(currentBug(f.database, bug.id).stage).toBe('WAITING_FOR_VERIFICATION');
  expect(f.executions.get(started.executionId).state).toBe('HANDED_OFF');
});
