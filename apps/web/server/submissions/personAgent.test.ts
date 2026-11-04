import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { testSkillBinding } from '@/testing/submissions/execution';
import { testHandoffUse, testRepairHandoff } from '@/testing/submissions/handoff';
import { testDatabases } from '@/testing/database';
import { lifecycleFixture } from './lifecycle/lifecycleFixture';

function receipt(commit: string, command: string) {
  return {
    source: 'CODEX_COMMAND',
    commit,
    commandSha256: createHash('sha256').update(command).digest('hex'),
    artifactSha256: 'e'.repeat(64),
  };
}

const setup = lifecycleFixture(testDatabases());

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
    const report = f.bugs.createBug(f.users.tester.id, created.id, {
      mutationId: randomUUID(),
      title: '两端交互结果异常',
      startRepair: true,
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
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
                  receipt: receipt('d'.repeat(40), 'bun run deploy:backend'),
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
              validations: [validation],
              warnings: [],
              handoffUse: testHandoffUse(),
              deliveries: {
                'repo-1': {
                  state: 'DEPLOYED',
                  commit: 'b'.repeat(40),
                  pushVerified: true,
                  deploymentVerified: true,
                  receipt: receipt('b'.repeat(40), 'bun run deploy:test'),
                },
                'repo-2': both
                  ? {
                      state: 'DEPLOYED',
                      commit: 'd'.repeat(40),
                      pushVerified: true,
                      deploymentVerified: true,
                      receipt: receipt('d'.repeat(40), 'bun run deploy:backend'),
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
