import {
  testTestingScope,
  testUpdateTestingScopes,
} from '@/testing/submissions/testingScope';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { testDeploymentReceipt, testSkillBinding } from '@/testing/submissions/execution';
import { testHandoffUse, testRepairHandoff } from '@/testing/submissions/handoff';
import { testDatabases } from '@/testing/database';
import { lifecycleFixture } from './lifecycle/lifecycleFixture';
import { createSubmissionWorkflow } from '@/server/runtime/createSubmissionWorkflow';
import { engineeringScenario } from '@/testing/submissions/scenario';
import { testerChecklist } from '@/app/(pages)/(main)/submissions/[submissionId]/bugs/testerChecklist';

const setup = lifecycleFixture(testDatabases());

test('PersonAgent 的双工程修复可以连续让位，恢复仍保留原来的工作区集合', async () => {
  const f = await setup();
  f.lifecycle.closeSubmission(f.users.tester.id, f.submission.id, {
    mutationId: randomUUID(),
    expectedVersion: f.submission.version,
  });
  const items = f.submissions.getWorkspace(f.users.developer.id, f.submission.id)
    .submission.items;
  const submission = f.submissions.createSubmission(f.users.owner.id, f.project.id, {
    mutationId: randomUUID(),
    title: '人工等待与跨工程队列',
    requirementDescription: '三个缺陷连续修复',
    testerUserId: f.users.tester.id,
    mode: 'PERSON_AGENT',
    personAgent: { responsibleUserId: f.users.developer.id, runnerId: f.runner.id },
    items: items.map((item) => ({
      engineeringId: item.engineering.id,
      responsibleUserId: f.users.developer.id,
      bindingId: item.technical!.bindingId,
      targetBranch: item.targetBranch,
      environmentId: item.environment.id,
    })),
  });
  for (const description of ['问题一', '问题二', '问题三'])
    f.bugs.createBug(f.users.tester.id, submission.id, {
      mutationId: randomUUID(),
      description,
      attachmentIds: [],
      startRepair: true,
    });
  const stopped: Array<{ id: string; interactionId: string; workspaces: unknown }> = [];
  for (let index = 0; index < 2; index++) {
    const claim = (await f.executions.claim(f.runner.id, 3, 0))[0]!;
    expect(claim.workspaces).toHaveLength(2);
    expect(claim.codexTurn).toHaveProperty('managedInteractions', true);
    const sessionId = `person-wait-${index}`;
    f.executions.start(f.runner.id, claim.id, {
      kind: 'STARTED',
      leaseToken: claim.lease.token,
      sessionId,
      taskSkillBinding: testSkillBinding('XBugRepaire'),
    });
    const request = {
      leaseToken: claim.lease.token,
      sessionId,
      kind: 'USER_INPUT' as const,
      method: 'item/tool/requestUserInput',
      payload: { questions: [{ id: 'choice', header: '方案', question: '选择？' }] },
    };
    const interaction = f.executions.openInteraction(f.runner.id, claim.id, request);
    stopped.push({
      id: claim.id,
      interactionId: interaction.id,
      workspaces: claim.workspaces,
    });
    f.clock.set(`2026-07-27T12:0${index + 1}:00.000Z`);
    f.executions.yieldInteraction(f.runner.id, claim.id, request);
  }
  const third = (await f.executions.claim(f.runner.id, 3, 0))[0]!;
  expect(stopped.map(({ id }) => id)).not.toContain(third.id);
  f.executions.resolveInteraction(stopped[0]!.interactionId, {
    answers: { choice: { answers: ['继续'] } },
  });
  expect((await f.executions.claim(f.runner.id, 3, 0)).map(({ id }) => id)).toEqual([]);
  expect(f.executions.get(stopped[0]!.id).workspaces).toEqual(stopped[0]!.workspaces);
});

test.each([false, true])(
  'PersonAgent 保留一条 Bug 并统一交付，双端改动：%s',
  async (both) => {
    const f = await setup();
    f.lifecycle.closeSubmission(f.users.tester.id, f.submission.id, {
      mutationId: randomUUID(),
      expectedVersion: f.submission.version,
    });
    const items = f.submissions.getWorkspace(f.users.owner.id, f.submission.id).submission
      .items;
    const input = {
      mutationId: randomUUID(),
      title: '前后端联合提测',
      requirementDescription: '同一 Agent 调查全部工程',
      testerUserId: f.users.tester.id,
      mode: 'PERSON_AGENT' as const,
      personAgent: { responsibleUserId: f.users.developer.id, runnerId: f.runner.id },
      items: items.map((item) => ({
        engineeringId: item.engineering.id,
        responsibleUserId: f.users.developer.id,
        bindingId:
          item.technical?.bindingId ??
          f.database.get<{ binding_id: string }>(
            'SELECT binding_id FROM submission_item WHERE id = ?',
            item.id,
          )!.binding_id,
        targetBranch: item.targetBranch,
        environmentId: item.environment.id,
      })),
    };
    expect(() =>
      f.submissions.createSubmission(f.users.owner.id, f.project.id, {
        ...input,
        personAgent: { ...input.personAgent, runnerId: randomUUID() },
      }),
    ).toThrow('同一个开发负责人和 Agent');
    const created = f.submissions.createSubmission(f.users.owner.id, f.project.id, {
      ...input,
      items: input.items.slice(0, 1),
    });
    expect(created.mode).toBe('PERSON_AGENT');
    for (const actor of [f.users.tester, f.users.developer]) {
      const waiting = f.bugs.createBug(f.users.tester.id, created.id, {
        mutationId: randomUUID(),
        description: '仅登记的误报',
        attachmentIds: [],
      }).bug;
      expect(f.bugs.workspace(actor.id, created.id).bugs[0]!.availableActions).toContain(
        'DELETE',
      );
      f.bugs.deleteWaitingBug(actor.id, waiting.id, {
        mutationId: randomUUID(),
        expectedVersion: waiting.version,
      });
      expect(f.bugs.workspace(actor.id, created.id).bugs).toHaveLength(0);
    }
    const report = f.bugs.createBug(f.users.tester.id, created.id, {
      mutationId: randomUUID(),
      description: '两端交互结果异常',
      startRepair: true,
      attachmentIds: [],
    });
    expect(report.bug.stage).toBe('REPAIRING');
    const appended = f.submissions.addItems(f.users.developer.id, created.id, {
      mutationId: randomUUID(),
      expectedVersion: created.version,
      items: input.items.slice(1),
    });
    const member = f.submissions.getWorkspace(f.users.developer.id, created.id).submission
      .items[0]!;
    const updateBranch = {
      mutationId: randomUUID(),
      expectedVersion: appended.version,
      title: created.title,
      requirementDescription: created.requirementDescription,
      targetBranches: [{ submissionItemId: member.id, targetBranch: 'feature/verified' }],
    };
    const changed = f.submissions.updateSubmission(
      f.users.developer.id,
      created.id,
      updateBranch,
    );
    const [claimed] = await f.executions.claim(f.runner.id, 1, 0);
    expect(claimed!.workspaces.map(({ workspace }) => workspace)).toMatchObject([
      { baseRef: 'origin/feature/verified' },
      { baseRef: 'origin/main' },
    ]);
    expect(() =>
      f.submissions.updateSubmission(f.users.developer.id, created.id, {
        ...updateBranch,
        mutationId: randomUUID(),
        expectedVersion: changed.version,
      }),
    ).toThrow('目标分支已锁定');
    f.executions.start(f.runner.id, claimed!.id, {
      kind: 'STARTED',
      leaseToken: claimed!.lease.token,
      sessionId: 'multi-repair',
      taskSkillBinding: testSkillBinding('XBugRepaire'),
    });
    const validation = { name: '双工程回归', status: 'PASSED' as const, detail: '' };
    const unchangedScope = testTestingScope('a'.repeat(40), 'a'.repeat(40));
    unchangedScope.points[0]!.title = '后端权限仍然正确';
    unchangedScope.limitations = ['后端弱网流程尚未验证'];
    const completion = f.executions.complete(f.runner.id, claimed!.id, {
      leaseToken: claimed!.lease.token,
      sessionId: 'multi-repair',
      outcome: {
        kind: 'SUCCEEDED',
        result: {
          result: {
            outcome: 'COMPLETED',
            repositories: {
              'repo-1': {
                testingScope: testTestingScope(['a'.repeat(40)].at(-1)),
                outcome: 'COMPLETED',
                completionKind: 'CHANGES_COMMITTED',
                changes: ['修复交互'],
                validations: [validation],
                warnings: [],
                commits: ['a'.repeat(40)],
                manualOperations: [],
                handoff: testRepairHandoff(),
              },
              'repo-2': both
                ? {
                    testingScope: testTestingScope(['c'.repeat(40)].at(-1)),
                    outcome: 'COMPLETED',
                    completionKind: 'CHANGES_COMMITTED',
                    changes: ['修复后端'],
                    validations: [validation],
                    warnings: [],
                    commits: ['c'.repeat(40)],
                    manualOperations: [],
                    handoff: testRepairHandoff(),
                  }
                : {
                    testingScope: unchangedScope,
                    outcome: 'COMPLETED',
                    completionKind: 'TARGET_ALREADY_FIXED',
                    changes: [],
                    validations: [validation],
                    warnings: [],
                    commits: [],
                    manualOperations: [],
                  },
            },
          },
        },
      },
    });
    expect(completion.state).toBe('SUCCEEDED');
    expect(f.bugs.workspace(f.users.tester.id, created.id).bugs[0]?.stage).toBe(
      'WAITING_FOR_UPDATE',
    );
    const frozen = f.updates.freezeNow(f.users.developer.id, member.id, {
      mutationId: randomUUID(),
    });
    let [update] = await f.executions.claim(f.runner.id, 1, 0);
    expect(update!.id).toBe(frozen.executionId);
    expect(update!.workspaces.map(({ workspace }) => workspace?.isolation)).toEqual([
      'DETACHED_WORKTREE',
      'DETACHED_WORKTREE',
    ]);
    expect(update!.codexTurn).toMatchObject({
      kind: 'INITIAL',
      executionBrief: {
        deploymentOrder: both ? ['repo-2', 'repo-1'] : ['repo-1'],
        engineeringDeliveries: [
          { alias: 'repo-1', frozenCandidates: [{ commits: ['a'.repeat(40)] }] },
          {
            alias: 'repo-2',
            frozenCandidates: both ? [{ commits: ['c'.repeat(40)] }] : [],
          },
        ],
      },
    });
    expect(JSON.stringify(update!.codexTurn?.outputJsonSchema)).not.toContain(
      '"receipt"',
    );
    f.executions.start(f.runner.id, update!.id, {
      kind: 'STARTED',
      leaseToken: update!.lease.token,
      sessionId: 'multi-update',
      taskSkillBinding: testSkillBinding('XUpdate'),
    });
    if (both) {
      f.executions.complete(f.runner.id, update!.id, {
        leaseToken: update!.lease.token,
        sessionId: 'multi-update',
        outcome: {
          kind: 'SUCCEEDED',
          result: {
            result: {
              outcome: 'FAILED',
              failedStep: '前端部署',
              reason: '验收失败',
              completedActions: ['后端部署已确认'],
              validations: [validation],
              warnings: [],
              handoffUse: testHandoffUse(),
              pendingActions: ['核实后端版本后重试前端'],
              deliveries: {
                'repo-1': {
                  state: 'FAILED',
                  commit: 'b'.repeat(40),
                  evidence: '前端未通过验收',
                },
                'repo-2': {
                  state: 'DEPLOYED',
                  commit: 'd'.repeat(40),
                  evidence: '后端启动成功',
                  receipt: testDeploymentReceipt('d'.repeat(40), 'backend'),
                },
              },
            },
          },
        },
      });
      expect(f.bugs.workspace(f.users.tester.id, created.id).bugs[0]?.stage).toBe(
        'UPDATING',
      );
      const batch = f.updates.batchView(f.users.developer.id, frozen.batchId);
      expect(batch.state).toBe('FAILED');
      const original = update!.workspaces;
      f.updates.retryUpdate(f.users.developer.id, batch.id, {
        mutationId: randomUUID(),
        expectedVersion: batch.version,
      });
      [update] = await f.executions.claim(f.runner.id, 1, 0);
      expect(update!.workspaces).toEqual(original);
      expect(update!.codexTurn).toMatchObject({
        kind: 'CONTINUATION',
        taskId: 'multi-update',
      });
      f.executions.start(f.runner.id, update!.id, {
        kind: 'STARTED',
        leaseToken: update!.lease.token,
        sessionId: 'multi-update',
        taskSkillBinding: testSkillBinding('XUpdate'),
      });
    }
    expect(
      f.executions.complete(f.runner.id, update!.id, {
        leaseToken: update!.lease.token,
        sessionId: 'multi-update',
        outcome: {
          kind: 'SUCCEEDED',
          result: {
            result: {
              outcome: 'COMPLETED',
              completedActions: ['完成并验收部署'],
              testingScopes: [
                ...testUpdateTestingScopes([0], 'b'.repeat(40)),
                ...(both ? testUpdateTestingScopes([0], 'd'.repeat(40), 'repo-2') : []),
              ],
              validations: [validation],
              warnings: [],
              handoffUse: testHandoffUse(),
              deliveries: {
                'repo-1': {
                  state: 'DEPLOYED',
                  commit: 'b'.repeat(40),
                  pushVerified: true,
                  deploymentVerified: true,
                  receipt: testDeploymentReceipt('b'.repeat(40), 'test'),
                },
                'repo-2': both
                  ? {
                      state: 'DEPLOYED',
                      commit: 'd'.repeat(40),
                      pushVerified: true,
                      deploymentVerified: true,
                      receipt: testDeploymentReceipt('d'.repeat(40), 'backend'),
                    }
                  : { state: 'UNCHANGED' },
              },
            },
          },
        },
      }).state,
    ).toBe('SUCCEEDED');
    expect(f.bugs.workspace(f.users.tester.id, created.id).bugs[0]?.stage).toBe(
      'WAITING_FOR_VERIFICATION',
    );
    const beforeRework = f.bugs.workspace(f.users.tester.id, created.id).bugs[0]!;
    const snapshot = createSubmissionWorkflow(f.database, {
      now: f.clock.now,
    }).workspace.getWorkspace(f.users.tester.id, created.id);
    const scopes = testerChecklist(beforeRework, snapshot).scopes;
    if (!both) {
      expect(scopes.flatMap(({ points }) => points).map(({ title }) => title)).toContain(
        '后端权限仍然正确',
      );
      expect(scopes.flatMap(({ limitations }) => limitations)).toContain(
        '后端弱网流程尚未验证',
      );
      expect(JSON.stringify(snapshot)).not.toContain('headCommit');
    }
    f.lifecycle.verifyBug(f.users.tester.id, beforeRework.id, {
      mutationId: randomUUID(),
      expectedVersion: beforeRework.version,
      result: 'FAILED',
      feedback: '联调仍有问题',
      attachmentIds: [],
    });
    const [rework] = await f.executions.claim(f.runner.id, 1, 0);
    expect(rework!.codexTurn).toMatchObject({
      kind: 'CONTINUATION',
      taskId: 'multi-repair',
    });
    expect(rework!.workspaces[0]?.workspace).toMatchObject({
      rotateFrom: { key: claimed!.workspaces[0]!.workspace!.key, head: 'a'.repeat(40) },
    });
    expect(rework!.workspaces[0]?.workspace?.key).not.toBe(
      claimed!.workspaces[0]!.workspace!.key,
    );
  },
);

test('PersonAgent 可以关闭提测并释放环境，没有工作区时不创建清理任务', async () => {
  const f = await setup();
  f.lifecycle.closeSubmission(f.users.tester.id, f.submission.id, {
    mutationId: randomUUID(),
    expectedVersion: f.submission.version,
  });
  const members = f.submissions.getWorkspace(f.users.developer.id, f.submission.id)
    .submission.items;
  const submission = f.submissions.createSubmission(f.users.owner.id, f.project.id, {
    mutationId: randomUUID(),
    title: 'PersonAgent 关闭验收',
    requirementDescription: '关闭时查询修复与更新历史并释放环境',
    testerUserId: f.users.tester.id,
    mode: 'PERSON_AGENT',
    personAgent: { responsibleUserId: f.users.developer.id, runnerId: f.runner.id },
    items: members.map((member) => ({
      engineeringId: member.engineering.id,
      responsibleUserId: f.users.developer.id,
      bindingId: member.technical!.bindingId,
      targetBranch: member.targetBranch,
      environmentId: member.environment.id,
    })),
  });
  const closed = f.lifecycle.closeSubmission(f.users.tester.id, submission.id, {
    mutationId: randomUUID(),
    expectedVersion: submission.version,
  });
  expect(closed.cleanupExecutionIds).toEqual([]);
  expect(
    f.submissions.getWorkspace(f.users.tester.id, submission.id).submission.submission
      .status,
  ).toBe('CLOSED');
  expect(
    f.database.all(
      'SELECT submission_id FROM submission_environment_lock WHERE submission_id = ?',
      submission.id,
    ),
  ).toEqual([]);
});

test('20 工程的 PersonAgent 可领取修复，每个工程均有 Git 断言且文本断言不超协议上限', async () => {
  const f = await setup();
  f.lifecycle.closeSubmission(f.users.tester.id, f.submission.id, {
    mutationId: randomUUID(),
    expectedVersion: f.submission.version,
  });
  const items = f.submissions
    .getWorkspace(f.users.owner.id, f.submission.id)
    .submission.items.map((item) => ({
      engineeringId: item.engineering.id,
      environmentId: item.environment.id,
      targetBranch: item.targetBranch,
      responsibleUserId: f.users.developer.id,
      bindingId: f.database.get<{ binding_id: string }>(
        'SELECT binding_id FROM submission_item WHERE id = ?',
        item.id,
      )!.binding_id,
    }));
  for (let index = 2; index < 20; index += 1) {
    const source = engineeringScenario(f.database, f.users.owner.id, f.project.id, {
      name: `工程${index}`,
      type: 'BACKEND',
      identifier: `scope-${index}`,
      environment: '测试',
      key: 'test',
      repository: `https://example.com/scope-${index}.git`,
      developers: { developer: { userId: f.users.developer.id, runnerId: f.runner.id } },
    });
    items.push({
      engineeringId: source.source.id,
      environmentId: source.environment.id,
      targetBranch: 'main',
      responsibleUserId: f.users.developer.id,
      bindingId: source.bindings.developer.id,
    });
  }
  const submission = f.submissions.createSubmission(f.users.owner.id, f.project.id, {
    mutationId: randomUUID(),
    mode: 'PERSON_AGENT',
    personAgent: { responsibleUserId: f.users.developer.id, runnerId: f.runner.id },
    title: '20 工程范围',
    requirementDescription: '检查完整工程范围',
    testerUserId: f.users.tester.id,
    items,
  });
  f.bugs.createBug(f.users.tester.id, submission.id, {
    mutationId: randomUUID(),
    description: '跨工程范围检查',
    attachmentIds: [],
    startRepair: true,
  });
  const [claimed] = await f.executions.claim(f.runner.id, 1, 0);
  expect(claimed!.workspaces).toHaveLength(20);
  const assertions = claimed!.codexTurn!.resultAssertions!;
  expect(assertions.length).toBeLessThanOrEqual(50);
  expect(
    new Set(
      assertions
        .filter((assertion) => assertion.kind === 'GIT_COMMITS_CREATED')
        .map((assertion) => assertion.workspaceBindingId),
    ).size,
  ).toBe(20);
  expect(assertions).toContainEqual(
    expect.objectContaining({
      kind: 'JSON_STRING_PATTERN',
      resultPath: ['result', 'repositories'],
    }),
  );
});
