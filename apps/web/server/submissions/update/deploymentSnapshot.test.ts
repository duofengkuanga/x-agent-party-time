import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { testDatabases } from '@/testing/database';
import { snapshotItemSource } from '../submissionItems';
import { SubmissionQueries } from '../submissionQueries';
import { completeSuccessfulExecution } from '@/testing/submissions/execution';
import {
  batchEntries,
  completeNextRepair,
  completedUpdate,
  freezeUpdate,
  pending,
  startExecution,
  updateFixture,
} from './updateFixture';

const setup = updateFixture(testDatabases());

test('持续集成保留的备用脚本不进入提测或修复执行快照', async () => {
  const f = await setup();
  f.database.run('UPDATE platform_environment SET deployment_json = ? WHERE id = ?', [
    JSON.stringify({ kind: 'CI_CD', scriptCommand: 'bun run deploy:remembered' }),
    f.item.environment_id,
  ]);
  const workspace = new SubmissionQueries(f.database).getWorkspace(
    f.users.developer.id,
    f.submission.id,
  );
  const item = workspace.submission.items[0]!;
  const source = snapshotItemSource(f.database, f.submission.projectId, {
    engineeringId: item.engineering.id,
    responsibleUserId: f.users.developer.id,
    bindingId: item.technical!.bindingId,
    environmentId: f.item.environment_id,
    targetBranch: item.targetBranch,
  });
  expect(JSON.parse(source.deployment_json)).toEqual({ kind: 'CI_CD' });
  expect(item.technical!.deployment).toEqual({ kind: 'CI_CD' });
  const bug = f.createBug('使用持续集成的缺陷');
  expect(
    JSON.parse(
      f.database.get<{ deployment_json: string }>(
        'SELECT deployment_json FROM submission_bug_deployment WHERE bug_id = ?',
        bug.id,
      )!.deployment_json,
    ),
  ).toEqual({ kind: 'CI_CD' });
});

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
      'SELECT * FROM submission_bug_deployment WHERE bug_id = ?',
      created.bug.id,
    ),
  ).toBeNull();
  f.database.run(
    'UPDATE platform_environment SET deployment_json = ? WHERE id = (SELECT environment_id FROM submission_item WHERE id = ?)',
    [JSON.stringify({ kind: 'CI_CD' }), f.item.id],
  );
  const second = f.bugs.requestRepair(f.users.tester.id, created.bug.id, {
    mutationId: randomUUID(),
    expectedVersion: created.bug.version,
  }).bug;
  await completeNextRepair(f, 'old-deployment', [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]);
  await completeNextRepair(f, 'new-deployment', [
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ]);
  const frozen = freezeUpdate(f);
  expect(batchEntries(f.database, frozen.batchId)).toEqual([
    { bug_id: first.id, commits: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] },
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
    { bug_id: second.id, commits: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] },
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
    'UPDATE platform_environment SET deployment_json = ? WHERE id = (SELECT environment_id FROM submission_item WHERE id = ?)',
    [JSON.stringify({ kind: 'LOCAL_SCRIPT', command: 'pnpm run deploy:84' }), f.item.id],
  );
  await completeNextRepair(f, 'original-repair', [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]);
  const frozen = freezeUpdate(f);
  expect(
    f.database.get<{ deployment_json: string }>(
      'SELECT deployment_json FROM submission_update_batch WHERE id = ?',
      frozen.batchId,
    )?.deployment_json,
  ).toBe(JSON.stringify({ kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' }));
  expect(
    f.database.get<{ deployment_json: string }>(
      'SELECT deployment_json FROM submission_bug_deployment WHERE bug_id = ?',
      bug.id,
    )?.deployment_json,
  ).toBe(JSON.stringify({ kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' }));
});
