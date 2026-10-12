import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { testDatabases } from '@/testing/database';
import { completeSuccessfulExecution } from '@/cooking/testing/execution';
import {
  batchEntries,
  completeNextRepair,
  completedUpdate,
  freezeUpdate,
  pending,
  startExecution,
  updateFixture,
} from './update-fixture';

const setup = updateFixture(testDatabases());

test('登记不冻结配置，首次修复读取最新部署，同工程不同配置串行分批', async () => {
  const f = await setup();
  const first = f.createBug('旧配置缺陷');
  const created = f.bugs.createBug(f.users.tester.id, f.submission.id, {
    mutationId: randomUUID(),
    submissionItemId: f.item.id,
    title: '新配置缺陷',
    actualResultAttachmentIds: [],
    expectedResultAttachmentIds: [],
  });
  expect(
    f.database.get(
      'SELECT * FROM cooking_bug_deployment WHERE bug_id = ?',
      created.bug.id,
    ),
  ).toBeNull();
  f.database.run(
    'UPDATE cooking_environment SET deployment_json = ? WHERE id = (SELECT environment_id FROM cooking_submission_item WHERE id = ?)',
    [JSON.stringify({ kind: 'CI_CD' }), f.item.id],
  );
  const second = f.bugs.requestRepair(f.users.tester.id, created.bug.id, {
    mutationId: randomUUID(),
    expectedVersion: created.bug.version,
  }).bug;
  await completeNextRepair(f, 'old-deployment', ['aaaaaaa']);
  await completeNextRepair(f, 'new-deployment', ['bbbbbbb']);
  const frozen = freezeUpdate(f);
  expect(batchEntries(f.database, frozen.batchId)).toEqual([
    { bug_id: first.id, commits: ['aaaaaaa'] },
  ]);
  expect(f.updates.batchView(f.users.developer.id, frozen.batchId).deploymentKind).toBe(
    'LOCAL_SCRIPT',
  );
  expect(pending(f.database, f.item.id)).not.toBeNull();
  expect(() => freezeUpdate(f)).toThrow();
  const started = await startExecution(f, frozen.executionId!, 'old-update');
  completeSuccessfulExecution(f, started, completedUpdate());
  const next = freezeUpdate(f);
  expect(batchEntries(f.database, next.batchId)).toEqual([
    { bug_id: second.id, commits: ['bbbbbbb'] },
  ]);
  expect(f.updates.batchView(f.users.developer.id, next.batchId).deploymentKind).toBe(
    'CI_CD',
  );
  expect(pending(f.database, f.item.id)).toBeNull();
});

test('已开始修复和更新批次不会因后台修改部署脚本而改变', async () => {
  const f = await setup();
  const bug = f.createBug('已开始修复');
  f.database.run(
    'UPDATE cooking_environment SET deployment_json = ? WHERE id = (SELECT environment_id FROM cooking_submission_item WHERE id = ?)',
    [JSON.stringify({ kind: 'LOCAL_SCRIPT', command: 'pnpm run deploy:84' }), f.item.id],
  );
  await completeNextRepair(f, 'original-repair', ['aaaaaaa']);
  const frozen = freezeUpdate(f);
  expect(
    f.database.get<{ deployment_json: string }>(
      'SELECT deployment_json FROM cooking_update_batch WHERE id = ?',
      frozen.batchId,
    )?.deployment_json,
  ).toBe(JSON.stringify({ kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' }));
  expect(
    f.database.get<{ deployment_json: string }>(
      'SELECT deployment_json FROM cooking_bug_deployment WHERE bug_id = ?',
      bug.id,
    )?.deployment_json,
  ).toBe(JSON.stringify({ kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' }));
});
