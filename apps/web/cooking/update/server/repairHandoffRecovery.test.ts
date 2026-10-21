import { testDatabases } from '@/testing/database';
import { mutation } from '@/cooking/testing/project';
import { expect, test } from 'bun:test';
import {
  completeNextRepair,
  completedUpdate,
  failedUpdate,
  freezeUpdate,
  startExecution,
  updateFixture,
} from './updateFixture';

const setup = updateFixture(testDatabases());

test('外部同步拒绝旧交接格式，追加有效尝试并保持冻结快照和重复同步幂等', async () => {
  const f = await setup();
  f.createBug('恢复中的交接');
  await completeNextRepair(f, 'recovery-repair', ['a'.repeat(40)]);
  const frozen = freezeUpdate(f);
  const started = await startExecution(f, frozen.executionId, 'recovery-update');
  const initial = f.executions.get(frozen.executionId).codexTurn;
  f.executions.complete(f.runner.id, started.executionId, {
    leaseToken: started.leaseToken,
    sessionId: started.sessionId,
    outcome: { kind: 'SUCCEEDED', result: failedUpdate('需要继续核实') },
  });
  const view = () => f.updates.batchView(f.users.developer.id, frozen.batchId);
  const sources = view().entries;
  const attempts = () =>
    view().timeline.filter((entry) => entry.kind === 'UPDATE_ATTEMPT');
  const sync = async (
    turnId: string,
    result: ReturnType<typeof completedUpdate> | ReturnType<typeof failedUpdate>,
  ) => {
    const requested = f.updates.synchronizeSession(
      f.users.developer.id,
      frozen.batchId,
      mutation(view().version),
    );
    const [execution] = await f.executions.claim(f.runner.id, 1, 0);
    expect(execution!.id).toBe(requested.executionId!);
    expect(execution!.codexTurn).toMatchObject({
      kind: 'READ_SESSION',
      taskId: started.sessionId,
    });
    f.executions.start(f.runner.id, execution!.id, {
      kind: 'STARTED',
      leaseToken: execution!.lease.token,
      sessionId: started.sessionId,
    });
    return f.executions.complete(f.runner.id, execution!.id, {
      leaseToken: execution!.lease.token,
      sessionId: started.sessionId,
      outcome: { kind: 'SUCCEEDED', result: { turnId, result } },
    });
  };
  const legacy = completedUpdate();
  Reflect.deleteProperty(legacy.result, 'handoffUse');
  await sync('legacy-turn', legacy);
  expect(view().state).toBe('FAILED');
  expect(attempts()).toHaveLength(1);
  await sync('failed-turn', failedUpdate('仍需核实'));
  expect(attempts()).toHaveLength(2);
  await sync('failed-turn', failedUpdate('仍需核实'));
  expect(attempts()).toHaveLength(2);
  await sync('completed-turn', completedUpdate());
  expect(view().state).toBe('COMPLETED');
  expect(attempts()).toHaveLength(3);
  expect(view().entries).toEqual(sources);
  expect(f.executions.get(frozen.executionId).codexTurn).toEqual(initial);
});
