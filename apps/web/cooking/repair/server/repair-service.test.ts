import { mutation } from '@/cooking/testing/project';
import { completeSuccessfulExecution } from '@/cooking/testing/execution';
import { testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  currentBug,
  latestAttempt,
  repairFixture,
  startLatest,
} from './repair-fixture';

const setup = repairFixture(testDatabases());

describe('RepairService', () => {
  test('工作区允许缺陷暂未确定工程', async () => {
    const fixture = await setup();
    const unassigned = fixture.bugs.createBug(
      fixture.users.tester.id,
      fixture.submission.id,
      {
        mutationId: randomUUID(),
        submissionItemId: null,
        title: '暂未确定工程的缺陷',
        actualResultAttachmentIds: [],
        expectedResultAttachmentIds: [],
      },
    );

    const workspace = fixture.repairs.workspace(
      fixture.users.tester.id,
      fixture.submission.id,
    );

    expect(workspace.repairByBug[fixture.requested.bug.id]).toBeDefined();
    expect(workspace.repairByBug[unassigned.bug.id]).toBeUndefined();
  });

  test('首次请求创建绑定正确且带隔离 Worktree 的通用 Execution', async () => {
    const fixture = await setup();
    const attempt = latestAttempt(fixture.database, fixture.requested.bug.id);
    const execution = fixture.executions.get(attempt.execution_id);
    expect(execution).toMatchObject({
      owner: { namespace: 'cooking', kind: 'BUG_REPAIR', id: attempt.id },
      attempt: 1,
      previousExecutionId: null,
      runnerId: fixture.runner.id,
      bindingId: fixture.binding.id,
      priority: 0,
      codexTurn: {
        kind: 'INITIAL',
        requiredSkillName: 'agent-party-time-repair-bug',
        taskSkillBinding: null,
        resultAssertions: [
          {
            kind: 'GIT_COMMITS_CREATED',
            resultPath: ['result', 'commits'],
          },
        ],
        executionBrief: {
          targetBranch: 'feature/payment',
          bug: {
            title: '支付按钮无响应',
            actualResult: '点击后没有反应',
            expectedResult: '进入支付流程',
          },
          attachmentReferences: [
            {
              fileId: fixture.resultAttachments.actual.id,
              originalName: '实际结果.png',
              role: 'ACTUAL_RESULT',
            },
            {
              fileId: fixture.resultAttachments.expected.id,
              originalName: '预期结果.txt',
              role: 'EXPECTED_RESULT',
            },
          ],
        },
      },
      workspace: {
        key: `bug-repair:${fixture.requested.bug.id}`,
        isolation: 'BRANCH_WORKTREE',
        baseRef: 'origin/feature/payment',
        branch: `apt/repair/${fixture.requested.bug.id}`,
      },
    });
    expect(execution.codexTurn?.kind).toBe('INITIAL');
    if (execution.codexTurn?.kind !== 'INITIAL')
      throw new Error('需要首次 Turn');
    expect(execution.codexTurn.executionBriefHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(execution.attachments.map(({ id }) => id)).toEqual([
      fixture.resultAttachments.actual.id,
      fixture.resultAttachments.expected.id,
    ]);
    expect(
      fixture.repairs.repairView(
        fixture.users.developer.id,
        fixture.requested.bug.id,
      )?.presentation.visual,
    ).toEqual({
      state: 'QUEUED_FOR_ENGINEERING',
      label: '等待工程执行通道（前方 0 项）',
      symbol: '…',
      aheadCount: 0,
    });
    expect(
      await fixture.executions.claim(fixture.otherRunner.id, 1, 0),
    ).toEqual([]);
    expect(
      (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]?.id,
    ).toBe(execution.id);
  });

  test('成功 Repair 冻结候选提交且不能重新执行', async () => {
    const fixture = await setup();
    const first = await startLatest(fixture, 'repair-session');
    expect(
      fixture.executions.complete(fixture.runner.id, first.executionId, {
        leaseToken: first.leaseToken,
        sessionId: 'repair-session',
        outcome: {
          kind: 'SUCCEEDED',
          result: {
            result: {
              outcome: 'COMPLETED',
              completionKind: 'CHANGES_COMMITTED',
              changes: ['修复支付按钮事件绑定'],
              validations: [
                {
                  name: '支付服务单测',
                  status: 'PASSED',
                  detail: '12 项通过',
                },
              ],
              warnings: [],
              commits: ['aaaaaaa', 'bbbbbbb'],
              manualOperations: [],
            },
          },
        },
      }).state,
    ).toBe('SUCCEEDED');
    expect(
      currentBug(fixture.database, fixture.requested.bug.id),
    ).toMatchObject({ stage: 'WAITING_FOR_UPDATE', version: 3 });
    const testerTimeline = fixture.repairs.repairView(
      fixture.users.tester.id,
      fixture.requested.bug.id,
    )!.timeline;
    const developerTimeline = fixture.repairs.repairView(
      fixture.users.developer.id,
      fixture.requested.bug.id,
    )!.timeline;
    expect(testerTimeline.map(({ kind }) => kind)).toEqual([
      'BUG_REGISTERED',
      'REPAIR_ATTEMPT',
    ]);
    expect(testerTimeline.at(-1)).toMatchObject({
      kind: 'REPAIR_ATTEMPT',
      result: {
        outcome: 'COMPLETED',
        changes: ['修复支付按钮事件绑定'],
        commitCount: 2,
        commits: null,
      },
    });
    expect(developerTimeline.at(-1)).toMatchObject({
      kind: 'REPAIR_ATTEMPT',
      result: {
        outcome: 'COMPLETED',
        commits: ['aaaaaaa', 'bbbbbbb'],
      },
    });

    expect(
      fixture.repairs.repairView(
        fixture.users.developer.id,
        fixture.requested.bug.id,
      )?.availableActions,
    ).not.toContain('RETRY_REPAIR');
    expect(() =>
      fixture.repairs.continueRepair(
        fixture.users.developer.id,
        fixture.requested.bug.id,
        {
          ...mutation(3),
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    expect(
      fixture.repairs.repairView(
        fixture.users.developer.id,
        fixture.requested.bug.id,
      )?.pendingCommits,
    ).toEqual(['aaaaaaa', 'bbbbbbb']);
  });

  test('已保存的完成结果可投影到时间线', async () => {
    const fixture = await setup();
    const started = await startLatest(fixture, 'legacy-result-session');

    fixture.database.run(
      'UPDATE cooking_repair_attempt SET outcome_json = ? WHERE execution_id = ?',
      [
        JSON.stringify({
          outcome: 'COMPLETED',
          completionKind: 'TARGET_ALREADY_FIXED',
          changes: [],
          validations: [{ name: '目标分支检查', status: 'PASSED', detail: '' }],
          warnings: [],
          commits: [],
          manualOperations: [],
        }),
        started.executionId,
      ],
    );

    expect(
      fixture.repairs
        .repairView(fixture.users.developer.id, fixture.requested.bug.id)
        ?.timeline.at(-1),
    ).toMatchObject({
      kind: 'REPAIR_ATTEMPT',
      result: {
        outcome: 'COMPLETED',
        commitCount: 0,
      },
    });
  });

  test('目标分支已包含修复且无新 Commit 时直接进入待验证', async () => {
    const fixture = await setup();
    const started = await startLatest(fixture, 'already-fixed-session');

    expect(
      completeSuccessfulExecution(fixture, started, {
        result: {
          outcome: 'COMPLETED',
          completionKind: 'TARGET_ALREADY_FIXED',
          changes: [],
          validations: [
            {
              name: '目标分支检查',
              status: 'PASSED',
              detail: '当前工作区与目标分支没有 Commit 差异',
            },
          ],
          warnings: [],
          commits: [],
          manualOperations: [],
        },
      }).state,
    ).toBe('SUCCEEDED');
    expect(
      currentBug(fixture.database, fixture.requested.bug.id),
    ).toMatchObject({ stage: 'WAITING_FOR_VERIFICATION', version: 3 });
    expect(
      fixture.repairs.repairView(
        fixture.users.developer.id,
        fixture.requested.bug.id,
      )?.pendingCommits,
    ).toEqual([]);
    expect(
      fixture.repairs
        .repairView(fixture.users.developer.id, fixture.requested.bug.id)
        ?.timeline.at(-1),
    ).toMatchObject({
      kind: 'REPAIR_ATTEMPT',
      result: {
        outcome: 'COMPLETED',
        commitCount: 0,
        commits: [],
      },
    });
    expect(
      fixture.database.get(
        'SELECT COUNT(*) count FROM cooking_pending_delivery WHERE submission_item_id = ?',
        fixture.requested.bug.submissionItemId,
      ),
    ).toEqual({ count: 0 });
  });
});
