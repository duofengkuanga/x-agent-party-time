import { expect, test } from 'bun:test';
import { testDatabases } from '@/testing/database';
import { mutation } from '@/testing/submissions/project';
import { testSkillBinding } from '@/testing/submissions/execution';
import {
  createAndRequestBug,
  currentBug,
  lifecycleFixture,
  submissionRow,
} from './lifecycleFixture';

const setup = lifecycleFixture(testDatabases());

for (const answered of [false, true])
  test(`测试负责人取消${answered ? '等待恢复' : '等待人工'}的修复，停止确认前不能关闭提测`, async () => {
    const f = await setup();
    const bug = createAndRequestBug(f, f.items[0]!.id, '等待人工的缺陷');
    const claimed = (await f.executions.claim(f.runner.id, 1, 0))[0]!;
    const sessionId = 'cancel-waiting';
    f.executions.start(f.runner.id, claimed.id, {
      kind: 'STARTED',
      leaseToken: claimed.lease.token,
      sessionId,
      taskSkillBinding: testSkillBinding('XBugRepaire'),
    });
    const request = {
      leaseToken: claimed.lease.token,
      kind: 'USER_INPUT' as const,
      method: 'item/tool/requestUserInput',
      payload: {
        questions: [{ id: 'choice', header: '选择方案', question: '选择哪种方案？' }],
      },
    };
    const interaction = f.executions.openInteraction(f.runner.id, claimed.id, request);
    const answer = { answers: { choice: { answers: ['A'] } } };
    if (answered)
      f.repairs.resolveInteraction(f.users.developer.id, interaction.id, {
        ...mutation(currentBug(f.database, bug.id).version),
        resolution: answer,
      });
    expect(() =>
      f.lifecycle.cancelBug(
        f.users.developer.id,
        bug.id,
        mutation(currentBug(f.database, bug.id).version),
      ),
    ).toThrow('只有测试负责人');
    f.lifecycle.cancelBug(
      f.users.tester.id,
      bug.id,
      mutation(currentBug(f.database, bug.id).version),
    );
    expect(currentBug(f.database, bug.id).stage).toBe('CANCELLED');
    expect(f.executions.get(claimed.id).state).toBe('CANCEL_REQUESTED');
    expect(() =>
      f.repairs.resolveInteraction(f.users.developer.id, interaction.id, {
        ...mutation(currentBug(f.database, bug.id).version),
        resolution: answer,
      }),
    ).toThrow();
    expect(() =>
      f.lifecycle.closeSubmission(
        f.users.tester.id,
        f.submission.id,
        mutation(submissionRow(f.database, f.submission.id).version),
      ),
    ).toThrow('执行未结束');
    f.executions.yieldInteraction(f.runner.id, claimed.id, { ...request, sessionId });
    expect(f.executions.get(claimed.id).state).toBe('CANCELLED');
    expect(
      f.lifecycle.workspace(f.users.tester.id, f.submission.id).transitionsByBug[bug.id],
    ).toMatchObject([{ kind: 'CANCELLED' }]);
    expect(await f.executions.claim(f.runner.id, 3, 0)).toEqual([]);
    f.lifecycle.closeSubmission(
      f.users.tester.id,
      f.submission.id,
      mutation(submissionRow(f.database, f.submission.id).version),
    );
    expect(submissionRow(f.database, f.submission.id).status).toBe('CLOSED');
  });
