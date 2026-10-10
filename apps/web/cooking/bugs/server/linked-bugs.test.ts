import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createCooking } from '@/cooking/runtime/create-cooking';
import { deliveryProject } from '@/cooking/testing/project';
import { testDatabases } from '@/testing/database';
import { LocalFileStore } from '@/platform/files/local-file-store';
import { testSkillBinding } from '@/cooking/testing/execution';

const createDatabase = testDatabases();

async function setup(repairCreateId?: () => string) {
  const { database, directory } = await createDatabase();
  const project = await deliveryProject(database, {
    name: '关联缺陷项目',
    prefix: 'linked',
    title: '前后端提测',
    description: '验证人工工程流转',
    sources: ['FRONTEND', 'BACKEND'].map((type) => ({
      name: type === 'FRONTEND' ? '前端' : '后端',
      type: type as 'FRONTEND' | 'BACKEND',
      identifier: type.toLowerCase(),
      environment: `${type}测试环境`,
      deployment: { kind: 'CI_CD' as const },
      repository: `https://example.com/${type}.git`,
      branch: 'main',
    })),
  });
  return {
    ...project,
    ...createCooking(database, { ids: { repair: repairCreateId } }),
    files: new LocalFileStore(database, join(directory, 'files')),
  };
}

async function finishedBug(
  f: Awaited<ReturnType<typeof setup>>,
  itemIndex = 0,
  committed = false,
  attachments: string[] = [],
) {
  const source = f.bugs.createBug(f.users.tester.id, f.submission.id, {
    mutationId: randomUUID(),
    submissionItemId: f.items[itemIndex]!.id,
    title: '需要排查的问题',
    actualResultAttachmentIds: attachments,
    expectedResultAttachmentIds: [],
  }).bug;
  f.bugs.requestRepair(f.users.tester.id, source.id, {
    mutationId: randomUUID(),
    expectedVersion: source.version,
  });
  const execution = (await f.executions.claim(f.runner.id, 1, 0))[0]!;
  f.executions.start(f.runner.id, execution.id, {
    kind: 'STARTED',
    leaseToken: execution.lease.token,
    sessionId: `session-${source.id}`,
    taskSkillBinding: testSkillBinding('agent-party-time-repair-bug'),
  });
  f.executions.complete(f.runner.id, execution.id, {
    leaseToken: execution.lease.token,
    sessionId: `session-${source.id}`,
    outcome: {
      kind: 'SUCCEEDED',
      result: {
        result: committed
          ? {
              outcome: 'COMPLETED',
              completionKind: 'CHANGES_COMMITTED',
              changes: ['完成本工程修改'],
              validations: [{ name: '定向验证', status: 'PASSED', detail: '' }],
              warnings: [],
              commits: ['abcdef1'],
              manualOperations: [],
            }
          : {
              outcome: 'FAILED',
              failedStep: '修复',
              reason: '问题仍未解决',
              completedActions: ['复现问题'],
              pendingActions: ['核查数据'],
            },
      },
    },
  });
  return f.bugs
    .workspace(f.users.tester.id, f.submission.id)
    .bugs.find(({ id }) => id === source.id)!;
}

describe('前后端关联 Bug', () => {
  test('协作目标完成后不唤醒原单，人工同步原会话后分别验收', async () => {
    const f = await setup();
    const source = await finishedBug(f);
    const added = f.bugs.routeBug(f.users.tester.id, source.id, {
      mutationId: randomUUID(),
      expectedVersion: source.version,
      targetSubmissionItemId: f.items[1]!.id,
      kind: 'COLLABORATE',
    });
    const sourceBefore = f.repairs.repairView(f.users.developer.id, source.id)!;
    const target = (await f.executions.claim(f.runner.id, 1, 0))[0]!;
    const fixed = {
      result: {
        outcome: 'COMPLETED',
        completionKind: 'TARGET_ALREADY_FIXED',
        changes: [],
        validations: [{ name: '复测原始现象', status: 'PASSED', detail: '标签正常显示' }],
        warnings: [],
        commits: [],
        manualOperations: [],
      },
    };
    f.executions.start(f.runner.id, target.id, {
      kind: 'STARTED',
      leaseToken: target.lease.token,
      sessionId: 'collaboration-target',
      taskSkillBinding: testSkillBinding('agent-party-time-repair-bug'),
    });
    f.executions.complete(f.runner.id, target.id, {
      leaseToken: target.lease.token,
      sessionId: 'collaboration-target',
      outcome: { kind: 'SUCCEEDED', result: fixed },
    });
    const targetBeforeVerify = f.bugs
      .workspace(f.users.tester.id, f.submission.id)
      .bugs.find(({ id }) => id === added.createdBug.id)!;
    expect(targetBeforeVerify.stage).toBe('WAITING_FOR_VERIFICATION');
    f.lifecycle.verifyBug(f.users.tester.id, targetBeforeVerify.id, {
      mutationId: randomUUID(),
      expectedVersion: targetBeforeVerify.version,
      result: 'PASSED',
      attachmentIds: [],
    });
    expect(await f.executions.claim(f.runner.id, 1, 0)).toEqual([]);
    expect(f.repairs.repairView(f.users.developer.id, source.id)?.timeline).toEqual(
      sourceBefore.timeline,
    );
    const original = f.bugs
      .workspace(f.users.tester.id, f.submission.id)
      .bugs.find(({ id }) => id === source.id)!;
    expect(original.stage).toBe('REPAIRING');
    expect(original.availableActions).not.toContain('COLLABORATE');
    const sync = f.repairs.synchronizeSession(f.users.developer.id, source.id, {
      mutationId: randomUUID(),
      expectedVersion: original.version,
    });
    const claimed = (await f.executions.claim(f.runner.id, 1, 0))[0]!;
    expect(claimed.id).toBe(sync.executionId);
    expect(claimed.codexTurn?.kind).toBe('READ_SESSION');
    f.executions.start(f.runner.id, claimed.id, {
      kind: 'STARTED',
      leaseToken: claimed.lease.token,
      sessionId: `session-${source.id}`,
      taskSkillBinding: null,
    });
    f.executions.complete(f.runner.id, claimed.id, {
      leaseToken: claimed.lease.token,
      sessionId: `session-${source.id}`,
      outcome: {
        kind: 'SUCCEEDED',
        result: { turnId: 'manual-after-collaboration', result: fixed },
      },
    });
    const ready = f.bugs
      .workspace(f.users.tester.id, f.submission.id)
      .bugs.find(({ id }) => id === source.id)!;
    expect(ready.stage).toBe('WAITING_FOR_VERIFICATION');
    f.lifecycle.verifyBug(f.users.tester.id, source.id, {
      mutationId: randomUUID(),
      expectedVersion: ready.version,
      result: 'PASSED',
      attachmentIds: [],
    });
    expect(
      f.bugs.workspace(f.users.tester.id, f.submission.id).bugs.map(({ stage }) => stage),
    ).toEqual(['DONE', 'DONE']);
    const attempts = f.repairs
      .repairView(f.users.developer.id, source.id)!
      .timeline.filter((node) => node.kind === 'REPAIR_ATTEMPT');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.result?.outcome).toBe('FAILED');
    expect(attempts[1]?.result?.outcome).toBe('COMPLETED');
  });

  test.each(['TRANSFER', 'COLLABORATE'] as const)(
    '负责人%s承接测试附件，直接删除原单后目标仍可读取',
    async (kind) => {
      const f = await setup();
      const file = await f.files.put({
        bytes: new TextEncoder().encode('测试现场证据'),
        originalName: '现场.txt',
        mediaType: 'text/plain',
        uploadedByUserId: f.users.tester.id,
      });
      const source = await finishedBug(f, 0, false, [file.id]);
      const routed = f.bugs.routeBug(f.users.developer.id, source.id, {
        mutationId: randomUUID(),
        expectedVersion: source.version,
        targetSubmissionItemId: f.items[1]!.id,
        kind,
      });
      f.bugs.deleteBugs({ bugIds: [source.id] });
      const [remaining] = f.bugs.workspace(f.users.tester.id, f.submission.id).bugs;
      expect(remaining?.id).toBe(routed.createdBug.id);
      expect(remaining?.report.actualResultAttachments.map(({ id }) => id)).toEqual([
        file.id,
      ]);
      expect(remaining?.relatedBugs[0]?.stageLabel).toBe('已删除');
      f.bugs.requireAttachmentAccess(f.users.tester.id, file.id);
      f.bugs.requireAttachmentAccess(f.users.developer.id, file.id);
      expect(new TextDecoder().decode((await f.files.read(file.id)).bytes)).toBe(
        '测试现场证据',
      );
      const [execution] = await f.executions.claim(f.runner.id, 1, 0);
      expect(execution?.attachments.map(({ id }) => id)).toEqual([file.id]);
      expect(JSON.stringify(execution?.codexTurn)).toContain('核查数据');
    },
  );
  test.each([0, 1])(
    '增加另一端协作保留原单和待交付提交，双方不再开放流转（方向 %s）',
    async (sourceIndex) => {
      const f = await setup();
      const source = await finishedBug(f, sourceIndex, true);
      const before = f.repairs.repairView(f.users.developer.id, source.id)!;
      expect(source.availableActions).not.toContain('TRANSFER');
      expect(source.availableActions).toContain('COLLABORATE');
      const added = f.bugs.routeBug(f.users.tester.id, source.id, {
        mutationId: randomUUID(),
        expectedVersion: source.version,
        targetSubmissionItemId: f.items[1 - sourceIndex]!.id,
        kind: 'COLLABORATE',
      });
      expect(added.bug.stage).toBe('WAITING_FOR_UPDATE');
      expect(added.bug.transferredAt).toBeNull();
      expect(
        f.repairs.repairView(f.users.developer.id, source.id)?.pendingCommits,
      ).toEqual(before.pendingCommits);
      expect(f.repairs.repairView(f.users.developer.id, source.id)?.timeline).toEqual(
        before.timeline,
      );
      const current = f.bugs.workspace(f.users.tester.id, f.submission.id).bugs;
      for (const bug of current) {
        expect(bug.collaborationLocked).toBe(true);
        expect(bug.availableActions).not.toContain('TRANSFER');
        expect(bug.availableActions).not.toContain('COLLABORATE');
      }
      expect(() =>
        f.bugs.routeBug(f.users.tester.id, source.id, {
          mutationId: randomUUID(),
          expectedVersion: added.bug.version,
          targetSubmissionItemId: f.items[1 - sourceIndex]!.id,
          kind: 'COLLABORATE',
        }),
      ).toThrow('前后端关联单');
    },
  );

  test('越权、运行中、等待交互、错误工程和旧版本不能触发流转', async () => {
    const f = await setup();
    const source = f.bugs.createBug(f.users.tester.id, f.submission.id, {
      mutationId: randomUUID(),
      submissionItemId: f.items[0]!.id,
      title: '待排查',
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
    }).bug;
    const input = {
      mutationId: randomUUID(),
      expectedVersion: source.version,
      targetSubmissionItemId: f.items[1]!.id,
      kind: 'TRANSFER' as const,
    };
    expect(() => f.bugs.routeBug(f.users.owner.id, source.id, input)).toThrow(
      '只有测试负责人',
    );
    expect(() => f.bugs.routeBug(f.users.tester.id, source.id, input)).toThrow(
      '先完成一次',
    );
    const requested = f.bugs.requestRepair(f.users.tester.id, source.id, {
      mutationId: randomUUID(),
      expectedVersion: source.version,
    }).bug;
    expect(() =>
      f.bugs.routeBug(f.users.tester.id, source.id, {
        ...input,
        expectedVersion: requested.version,
      }),
    ).toThrow('等待当前');
    const execution = (await f.executions.claim(f.runner.id, 1, 0))[0]!;
    f.executions.start(f.runner.id, execution.id, {
      kind: 'STARTED',
      leaseToken: execution.lease.token,
      sessionId: 'waiting-session',
      taskSkillBinding: testSkillBinding('agent-party-time-repair-bug'),
    });
    f.executions.openInteraction(f.runner.id, execution.id, {
      leaseToken: execution.lease.token,
      kind: 'USER_INPUT',
      method: 'item/tool/requestUserInput',
      payload: {
        questions: [
          {
            id: 'q',
            header: '信息',
            question: '提供复现步骤',
            options: [{ label: '继续', description: '继续' }],
          },
        ],
      },
    });
    const waiting = f.bugs.workspace(f.users.tester.id, f.submission.id).bugs[0]!;
    expect(() =>
      f.bugs.routeBug(f.users.tester.id, source.id, {
        ...input,
        expectedVersion: waiting.version,
      }),
    ).toThrow('等待当前');
    expect(f.bugs.workspace(f.users.tester.id, f.submission.id).bugs).toHaveLength(1);
  });

  test('入队失败整笔回滚，原单可重试且没有半套目标单', async () => {
    let fail = false;
    const f = await setup(() => {
      if (fail) throw new Error('模拟队列故障');
      return randomUUID();
    });
    const source = await finishedBug(f);
    const input = {
      mutationId: randomUUID(),
      expectedVersion: source.version,
      targetSubmissionItemId: f.items[1]!.id,
      kind: 'TRANSFER' as const,
    };
    const before = f.bugs.workspace(f.users.tester.id, f.submission.id);
    fail = true;
    expect(() => f.bugs.routeBug(f.users.developer.id, source.id, input)).toThrow(
      '模拟队列故障',
    );
    expect(f.bugs.workspace(f.users.tester.id, f.submission.id)).toEqual(before);
    fail = false;
    const routed = f.bugs.routeBug(f.users.developer.id, source.id, input);
    expect(routed.createdBug.stage).toBe('REPAIRING');
    expect(() =>
      f.bugs.routeBug(f.users.developer.id, source.id, {
        ...input,
        mutationId: randomUUID(),
      }),
    ).toThrow('缺陷已更新');
  });

  test('双工程登记拒绝同端、跨提测、越权和已绑定附件且不留下半套单', async () => {
    const f = await setup();
    const input = {
      mutationId: randomUUID(),
      submissionItemIds: [f.items[0]!.id, f.items[0]!.id],
      title: '不能拆单',
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
    };
    expect(() =>
      f.bugs.createLinkedBugs(f.users.tester.id, f.submission.id, input),
    ).toThrow();
    expect(() =>
      f.bugs.createLinkedBugs(f.users.tester.id, f.submission.id, {
        ...input,
        submissionItemIds: [f.items[0]!.id, randomUUID()],
      }),
    ).toThrow('当前提测单');
    expect(() =>
      f.bugs.createLinkedBugs(f.users.developer.id, f.submission.id, {
        ...input,
        submissionItemIds: f.items.map(({ id }) => id),
      }),
    ).toThrow('只有测试负责人');
    expect(f.bugs.workspace(f.users.tester.id, f.submission.id).bugs).toEqual([]);
  });
  test('转交关闭不能通过普通恢复重新打开', async () => {
    const f = await setup();
    const source = await finishedBug(f, 1);
    const moved = f.bugs.routeBug(f.users.tester.id, source.id, {
      mutationId: randomUUID(),
      expectedVersion: source.version,
      targetSubmissionItemId: f.items[0]!.id,
      kind: 'TRANSFER',
    });
    expect(() =>
      f.lifecycle.restoreBug(f.users.tester.id, source.id, {
        mutationId: randomUUID(),
        expectedVersion: moved.bug.version,
      }),
    ).toThrow('转交');
  });
  test('人工转交关闭原单，新单携带报告与排查结果自动排队，重放不重复', async () => {
    const f = await setup();
    const source = f.bugs.createBug(f.users.tester.id, f.submission.id, {
      mutationId: randomUUID(),
      submissionItemId: f.items[0]!.id,
      title: '地块缺少标签',
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
    }).bug;
    f.bugs.requestRepair(f.users.tester.id, source.id, {
      mutationId: randomUUID(),
      expectedVersion: source.version,
    });
    const execution = (await f.executions.claim(f.runner.id, 1, 0))[0]!;
    f.executions.start(f.runner.id, execution.id, {
      kind: 'STARTED',
      leaseToken: execution.lease.token,
      sessionId: 'source-session',
      taskSkillBinding: testSkillBinding('agent-party-time-repair-bug'),
    });
    f.executions.complete(f.runner.id, execution.id, {
      leaseToken: execution.lease.token,
      sessionId: 'source-session',
      outcome: {
        kind: 'SUCCEEDED',
        result: {
          result: {
            outcome: 'FAILED',
            failedStep: '修复',
            reason: '缺少边界数据',
            completedActions: ['检查了定位字段'],
            pendingActions: ['核查数据来源'],
          },
        },
      },
    });
    const before = f.workspace
      .getWorkspace(f.users.tester.id, f.submission.id)
      .bugs.find(({ id }) => id === source.id)!;
    expect(before.availableActions).toContain('TRANSFER');
    const input = {
      mutationId: randomUUID(),
      expectedVersion: before.version,
      targetSubmissionItemId: f.items[1]!.id,
      kind: 'TRANSFER' as const,
    };
    const moved = f.bugs.routeBug(f.users.developer.id, source.id, input);
    expect(f.bugs.routeBug(f.users.developer.id, source.id, input)).toEqual(moved);
    const snapshot = f.workspace.getWorkspace(f.users.tester.id, f.submission.id);
    expect(snapshot.bugs).toHaveLength(2);
    const original = snapshot.bugs.find(({ id }) => id === source.id)!;
    const target = snapshot.bugs.find(({ id }) => id !== source.id)!;
    expect(original.stage).toBe('CANCELLED');
    expect(original.transferredAt).not.toBeNull();
    expect(original.presentation.stageLabel).toBe('已关闭（转交）');
    expect(original.availableActions).not.toContain('RESTORE');
    expect(target.stage).toBe('REPAIRING');
    expect(target.assignment?.submissionItemId).toBe(f.items[1]!.id);
    expect(target.relatedBugs[0]!.handoffText).toContain('缺少边界数据');
    const [queued] = await f.executions.claim(f.runner.id, 1, 0);
    expect(queued?.bindingId).toBe(f.sources[1]!.binding.id);
    expect(JSON.stringify(queued?.codexTurn)).toContain('核查数据来源');
  });
  test('一次登记两单、附件可读、独立待修复且重放不重复', async () => {
    const f = await setup();
    const file = await f.files.put({
      bytes: new TextEncoder().encode('定位证据'),
      originalName: '定位.txt',
      mediaType: 'text/plain',
      uploadedByUserId: f.users.tester.id,
    });
    const input = {
      mutationId: randomUUID(),
      submissionItemIds: f.items.map(({ id }) => id),
      title: '地图标签不显示',
      actualResult: '没有标签',
      expectedResult: '显示标签',
      actualResultAttachmentIds: [file.id],
      expectedResultAttachmentIds: [],
    };
    const created = f.bugs.createLinkedBugs(f.users.tester.id, f.submission.id, input);
    expect(created.bugs).toHaveLength(2);
    expect(f.bugs.createLinkedBugs(f.users.tester.id, f.submission.id, input)).toEqual(
      created,
    );
    const view = f.workspace.getWorkspace(f.users.tester.id, f.submission.id);
    expect(view.bugs).toHaveLength(2);
    expect(view.bugs.map((bug) => bug.assignment?.engineeringType).sort()).toEqual([
      'BACKEND',
      'FRONTEND',
    ]);
    for (const bug of view.bugs) {
      expect(bug.stage).toBe('WAITING_FOR_REPAIR');
      expect(bug.report.actualResultAttachments.map(({ id }) => id)).toEqual([file.id]);
      expect(bug.relatedBugs).toHaveLength(1);
      expect(bug.relatedBugs[0]?.id).not.toBe(bug.id);
      expect(bug.collaborationLocked).toBe(true);
      expect(bug.availableActions).not.toContain('TRANSFER');
      expect(bug.availableActions).not.toContain('COLLABORATE');
      f.bugs.requireAttachmentAccess(f.users.tester.id, file.id);
      expect(
        view.repairByBug[bug.id]?.timeline.filter(
          ({ kind }) => kind === 'REPAIR_ATTEMPT',
        ),
      ).toHaveLength(0);
    }
  });

  test('共享附件可在各单独立编辑和删除，不能被无关报告占用', async () => {
    const f = await setup();
    const file = await f.files.put({
      bytes: new TextEncoder().encode('证据'),
      originalName: '证据.txt',
      mediaType: 'text/plain',
      uploadedByUserId: f.users.tester.id,
    });
    const report = {
      title: '接口与界面',
      actualResultAttachmentIds: [file.id],
      expectedResultAttachmentIds: [],
    };
    const { bugs } = f.bugs.createLinkedBugs(f.users.tester.id, f.submission.id, {
      ...report,
      mutationId: randomUUID(),
      submissionItemIds: f.items.map(({ id }) => id),
    });
    const first = bugs[0]!;
    f.bugs.updateReport(f.users.tester.id, first.id, {
      ...report,
      title: '单独编辑',
      submissionItemId: first.submissionItemId,
      mutationId: randomUUID(),
      expectedVersion: first.version,
    });
    const removed = f.bugs.updateReport(f.users.tester.id, first.id, {
      ...report,
      actualResultAttachmentIds: [],
      submissionItemId: first.submissionItemId,
      mutationId: randomUUID(),
      expectedVersion: first.version + 1,
    });
    expect(removed.unboundAttachmentIds).toEqual([]);
    expect(() =>
      f.bugs.createBug(f.users.tester.id, f.submission.id, {
        ...report,
        mutationId: randomUUID(),
        submissionItemId: first.submissionItemId,
      }),
    ).toThrow('附件不存在');
    f.bugs.deleteBugs({ bugIds: [first.id] });
    const remaining = f.bugs.workspace(f.users.tester.id, f.submission.id).bugs;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.report.title).toBe('接口与界面');
    expect(remaining[0]!.report.actualResultAttachments[0]!.id).toBe(file.id);
    expect(remaining[0]!.collaborationLocked).toBe(true);
    expect(remaining[0]!.relatedBugs[0]!.stageLabel).toBe('已删除');
    expect(new TextDecoder().decode((await f.files.read(file.id)).bytes)).toBe('证据');
  });
});
