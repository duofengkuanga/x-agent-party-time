import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { testDatabases } from '@/testing/database';
import { completeSuccessfulExecution } from '@/testing/submissions/execution';
import { EngineeringService } from '@/server/platform/projects/engineering/engineeringService';
import {
  batchEntries,
  completeNextRepair,
  completedUpdate,
  freezeUpdate,
  startExecution,
  updateFixture,
} from './updateFixture';

const setup = updateFixture(testDatabases());

test('同一环境身份的候选一起冻结，名称变更不改变交付目标', async () => {
  const f = await setup();
  const first = f.createBug('第一个缺陷');
  await completeNextRepair(f, 'first-repair', ['a'.repeat(40)]);
  const second = f.createBug('第二个缺陷');
  await completeNextRepair(f, 'second-repair', ['b'.repeat(40)]);
  const { environment_id: id } = f.database.get<{ environment_id: string }>(
    'SELECT environment_id FROM submission_item WHERE id = ?',
    f.item.id,
  )!;
  new EngineeringService(f.database).updateEnvironment(f.users.owner.id, id, {
    name: '新显示名称',
    expectedVersion: 1,
    mutationId: randomUUID(),
  });
  const frozen = freezeUpdate(f);
  expect(batchEntries(f.database, frozen.batchId)).toEqual([
    { bug_id: first.id, commits: ['a'.repeat(40)] },
    { bug_id: second.id, commits: ['b'.repeat(40)] },
  ]);
  const turn = f.executions.get(frozen.executionId!).codexTurn;
  expect(turn).toMatchObject({
    executionBrief: { engineeringDeliveries: [{ environmentKey: 'test' }] },
    resultAssertions: expect.arrayContaining([
      expect.objectContaining({ kind: 'GIT_DELIVERY_STATE', environmentKey: 'test' }),
    ]),
  });
  expect(JSON.stringify(turn)).not.toContain('deploymentCommand');
});

test('交付回执缺失或对应其他环境时，AgentParty 批次不进入待验证', async () => {
  for (const invalid of ['missing', 'wrong-environment']) {
    const f = await setup();
    const bug = f.createBug('缺少可信验收');
    await completeNextRepair(f, 'repair', ['a'.repeat(40)]);
    const frozen = freezeUpdate(f);
    const started = await startExecution(f, frozen.executionId!, 'update');
    const { result } = completedUpdate();
    const delivery = result.deliveries['repo-1'];
    completeSuccessfulExecution(f, started, {
      result: {
        ...result,
        deliveries: {
          'repo-1': {
            ...delivery,
            ...(invalid === 'missing'
              ? { receipt: null }
              : { receipt: { ...delivery.receipt, environmentKey: 'wrong' } }),
          },
        },
      },
    });
    expect(f.updates.batchView(f.users.developer.id, frozen.batchId).state).toBe(
      'FAILED',
    );
    expect(
      f.database.get('SELECT stage FROM submission_bug WHERE id = ?', bug.id),
    ).toEqual({ stage: 'UPDATING' });
  }
});
