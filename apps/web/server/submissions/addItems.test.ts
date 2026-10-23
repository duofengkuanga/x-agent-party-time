import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { testDatabases } from '@/testing/database';
import {
  createSubmission,
  insertBug,
  item,
  submissionFixture,
} from './submissionFixture';

const setup = submissionFixture(testDatabases());

test('负责人追加工程保留已有缺陷、快照和锁，重复请求不重复追加', async () => {
  const f = await setup();
  const submission = createSubmission(f, [
    item(f, 'front', 'developerA', 'frontA', 'main'),
  ]);
  const before = f.database.all('SELECT * FROM submission_item');
  const original = f.service.getWorkspace(f.users.tester.id, submission.id).submission
    .items[0]!;
  insertBug(f, submission.id, original.id);
  const bugs = f.database.all('SELECT * FROM submission_bug');
  const input = {
    mutationId: randomUUID(),
    expectedVersion: submission.version,
    items: [item(f, 'back', 'developerB', 'backB', 'release')],
  };
  const result = f.service.addItems(f.users.developerA.id, submission.id, input);
  expect(f.service.addItems(f.users.developerA.id, submission.id, input)).toEqual(result);
  expect(result.version).toBe(submission.version + 1);
  expect(result.workspaceRevision).toBe(submission.workspaceRevision + 1);
  expect(
    f.database.all('SELECT * FROM submission_item WHERE id = ?', original.id),
  ).toEqual(before);
  expect(f.database.all('SELECT * FROM submission_bug')).toEqual(bugs);
  expect(f.database.all('SELECT * FROM submission_environment_lock')).toHaveLength(2);
  const view = f.service.getWorkspace(f.users.tester.id, submission.id).submission;
  expect(view.items).toHaveLength(2);
  expect(view.items[1]?.targetBranch).toBe('release');
  expect(f.events.at(-1)).toEqual({
    submissionId: submission.id,
    revision: result.workspaceRevision,
  });
});

test('测试负责人可以追加，普通成员、重复工程、过期版本和关闭提测不能追加', async () => {
  const f = await setup();
  const submission = createSubmission(f, [
    item(f, 'front', 'developerA', 'frontA', 'main'),
  ]);
  const input = {
    mutationId: randomUUID(),
    expectedVersion: submission.version,
    items: [item(f, 'back', 'developerB', 'backB', 'main')],
  };
  expect(
    f.service.getWorkspace(f.users.member.id, submission.id).submission.availableActions,
  ).not.toContain('ADD_ITEMS');
  expect(() => f.service.addItems(f.users.member.id, submission.id, input)).toThrow(
    '只有提测负责人',
  );
  expect(() =>
    f.service.addItems(f.users.tester.id, submission.id, {
      ...input,
      expectedVersion: 99,
    }),
  ).toThrow('提测单已更新');
  expect(() =>
    f.service.addItems(f.users.tester.id, submission.id, {
      ...input,
      items: [item(f, 'front', 'developerA', 'frontA', 'main')],
    }),
  ).toThrow('只能出现一次');
  expect(() =>
    f.service.addItems(f.users.tester.id, submission.id, {
      ...input,
      items: [...input.items, ...input.items],
    }),
  ).toThrow('只能出现一次');
  expect(f.database.all('SELECT * FROM submission_item')).toHaveLength(1);
  const result = f.service.addItems(f.users.tester.id, submission.id, input);
  expect(result.version).toBe(2);
  f.database.run("UPDATE test_submission SET status = 'CLOSED' WHERE id = ?", [
    submission.id,
  ]);
  expect(() =>
    f.service.addItems(f.users.tester.id, submission.id, {
      ...input,
      mutationId: randomUUID(),
      expectedVersion: result.version,
    }),
  ).toThrow('已关闭');
});

test('追加时环境冲突原子回滚，确认后转移环境并保留原单数据', async () => {
  const f = await setup();
  const first = createSubmission(f, [item(f, 'back', 'developerB', 'backB', 'main')]);
  const second = createSubmission(f, [item(f, 'front', 'developerA', 'frontA', 'main')]);
  const input = {
    mutationId: randomUUID(),
    expectedVersion: second.version,
    items: [item(f, 'back', 'developerB', 'backB', 'main')],
  };
  const eventsBeforeFailure = f.events.length;
  expect(() => f.service.addItems(f.users.owner.id, second.id, input)).toThrow(
    '已被其他活动提测单占用',
  );
  expect(f.events).toHaveLength(eventsBeforeFailure);
  expect(
    f.service.getWorkspace(f.users.owner.id, second.id).submission.items,
  ).toHaveLength(1);
  const conflicts = f.service.addedItemConflicts(f.users.owner.id, second.id, input);
  expect(conflicts).toHaveLength(1);
  const confirmed = { ...input, environmentTakeovers: conflicts };
  f.events.length = 0;
  const result = f.service.addItems(f.users.owner.id, second.id, confirmed);
  expect(f.events.map(({ submissionId }) => submissionId).sort()).toEqual(
    [first.id, second.id].sort(),
  );
  const eventsAfterSuccess = [...f.events];
  expect(f.service.addItems(f.users.owner.id, second.id, confirmed)).toEqual(result);
  expect(f.events).toEqual(eventsAfterSuccess);
  expect(
    f.service.getWorkspace(f.users.owner.id, first.id).submission.items[0]
      ?.environmentAccess.owned,
  ).toBe(false);
  expect(
    f.service.getWorkspace(f.users.owner.id, second.id).submission.items[1]
      ?.environmentAccess.deploymentConfirmed,
  ).toBe(false);
});

test('活动提测实时读取部署方式，关闭提测保留历史配置', async () => {
  const f = await setup();
  const submission = createSubmission(f, [
    item(f, 'front', 'developerA', 'frontA', 'main'),
  ]);
  const deployment = { kind: 'LOCAL_SCRIPT', command: 'pnpm run deploy:84' };
  f.database.run('UPDATE platform_environment SET deployment_json = ? WHERE id = ?', [
    JSON.stringify(deployment),
    f.environments.front.id,
  ]);
  expect(
    f.service.getWorkspace(f.users.developerA.id, submission.id).submission.items[0]
      ?.technical?.deployment,
  ).toEqual(deployment);
  f.database.run("UPDATE test_submission SET status = 'CLOSED' WHERE id = ?", [
    submission.id,
  ]);
  f.database.run('DELETE FROM submission_environment_lock WHERE submission_id = ?', [
    submission.id,
  ]);
  f.database.run('DELETE FROM platform_environment WHERE id = ?', [
    f.environments.front.id,
  ]);
  expect(
    f.service.getWorkspace(f.users.developerA.id, submission.id).submission.items[0]
      ?.technical?.deployment,
  ).toEqual({ kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' });
});

test('全部工程已加入后不再显示追加入口', async () => {
  const f = await setup();
  const submission = createSubmission(f, [
    item(f, 'front', 'developerA', 'frontA', 'main'),
  ]);
  expect(
    f.service.getWorkspace(f.users.tester.id, submission.id).submission.availableActions,
  ).toContain('ADD_ITEMS');
  f.service.addItems(f.users.tester.id, submission.id, {
    mutationId: randomUUID(),
    expectedVersion: submission.version,
    items: [item(f, 'back', 'developerB', 'backB', 'main')],
  });
  expect(
    f.service.getWorkspace(f.users.tester.id, submission.id).submission.availableActions,
  ).not.toContain('ADD_ITEMS');
});

test('剩余工程缺少有效环境或绑定时隐藏入口，恢复配置后重新出现', async () => {
  const f = await setup();
  const submission = createSubmission(f, [
    item(f, 'front', 'developerA', 'frontA', 'main'),
  ]);
  const actions = () =>
    f.service.getWorkspace(f.users.tester.id, submission.id).submission.availableActions;
  f.database.run('UPDATE platform_engineering SET archived_at = ? WHERE id = ?', [
    new Date().toISOString(),
    f.engineering.back.id,
  ]);
  expect(actions()).not.toContain('ADD_ITEMS');
  f.database.run('UPDATE platform_engineering SET archived_at = NULL WHERE id = ?', [
    f.engineering.back.id,
  ]);
  expect(actions()).toContain('ADD_ITEMS');
  f.database.run('UPDATE platform_runner SET revoked_at = ?', [new Date().toISOString()]);
  expect(actions()).not.toContain('ADD_ITEMS');
  f.database.run('UPDATE platform_runner SET revoked_at = NULL');
  expect(actions()).toContain('ADD_ITEMS');
  f.database.run('DELETE FROM platform_environment WHERE id = ?', [
    f.environments.back.id,
  ]);
  expect(actions()).not.toContain('ADD_ITEMS');
});
