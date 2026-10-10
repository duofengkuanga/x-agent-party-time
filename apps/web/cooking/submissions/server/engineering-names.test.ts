import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EngineeringService } from '@/cooking/engineering/server/engineering-service';
import { createCooking } from '@/cooking/runtime/create-cooking';
import { BugRepairContextService } from '@/cooking/bugs/server/repair-context';
import { completeRepairExecution } from '@/cooking/testing/execution';
import { mutation } from '@/cooking/testing/project';
import { testDatabases } from '@/testing/database';
import { createSubmission, item, submissionFixture } from './submission-fixture';

const setup = submissionFixture(testDatabases());

test('工程改名在已有提测、缺陷、关联、流转目标和更新批次中一致显示', async () => {
  const f = await setup();
  const front = item(f, 'front', 'developerA', 'frontA', 'feature/front');
  const submission = createSubmission(f, [
    front,
    item(f, 'back', 'developerB', 'backB', 'feature/back'),
  ]);
  const app = createCooking(f.database);
  const items = app.workspace.getWorkspace(f.users.tester.id, submission.id).submission
    .items;
  const report = {
    title: '名称展示',
    actualResultAttachmentIds: [],
    expectedResultAttachmentIds: [],
  };
  const single = app.bugs.createBug(f.users.tester.id, submission.id, {
    ...report,
    mutationId: randomUUID(),
    submissionItemId: items[0]!.id,
  }).bug;
  const pair = app.bugs.createLinkedBugs(f.users.tester.id, submission.id, {
    ...report,
    mutationId: randomUUID(),
    submissionItemIds: items.map(({ id }) => id),
  });

  const engineering = new EngineeringService(f.database);
  for (const [key, name] of [
    ['front', '前端土壤大屏'],
    ['back', '后端土壤服务'],
  ] as const) {
    const current = engineering.getEngineering(f.users.owner.id, f.engineering[key].id);
    engineering.updateEngineering(f.users.owner.id, current.id, {
      ...mutation(current.version),
      name,
      type: current.type,
      identifier: current.identifier,
    });
  }

  const view = app.workspace.getWorkspace(f.users.tester.id, submission.id);
  expect(view.submission.items.map(({ engineering }) => engineering.name)).toEqual([
    '前端土壤大屏',
    '后端土壤服务',
  ]);
  const singleView = view.bugs.find(({ id }) => id === single.id)!;
  expect(singleView.assignment?.engineeringName).toBe('前端土壤大屏');
  expect(singleView.routing.targets.map(({ name }) => name)).toEqual(['后端土壤服务']);
  expect(
    view.bugs.find(({ id }) => id === pair.bugs[0]!.id)?.relatedBugs[0]?.engineeringName,
  ).toBe('后端土壤服务');
  expect(
    view.bugs.find(({ id }) => id === pair.bugs[1]!.id)?.relatedBugs[0]?.engineeringName,
  ).toBe('前端土壤大屏');
  expect(new BugRepairContextService(f.database).get(single.id)).toMatchObject({
    engineeringName: '前端土壤大屏',
    targetBranch: 'feature/front',
  });
  const conflicts = f.service.environmentConflicts(f.users.owner.id, f.project.id, {
    mutationId: randomUUID(),
    title: '环境检查',
    requirementDescription: '核查名称显示',
    testerUserId: f.users.tester.id,
    items: [front],
  });
  expect(conflicts[0]?.engineeringName).toBe('前端土壤大屏');

  app.bugs.requestRepair(f.users.tester.id, single.id, mutation(single.version));
  const runner = f.runners.runnerA.runner;
  const claimed = (await app.executions.claim(runner.id, 1, 0))[0]!;
  completeRepairExecution(
    { executions: app.executions, runner },
    claimed.id,
    claimed.lease.token,
    'rename-repair',
    ['abcdef1'],
  );
  app.updates.freezeNow(f.users.developerA.id, items[0]!.id, {
    mutationId: randomUUID(),
  });
  const batch = app.updates.workspace(f.users.tester.id, submission.id).updateBatches[0]!;
  expect(batch.engineeringName).toBe('前端土壤大屏');
  expect(batch.targetBranch).toBe('feature/front');
  expect(batch.environmentName).toBe('前端测试环境');
  expect(batch.deploymentKind).toBe('LOCAL_SCRIPT');
});
