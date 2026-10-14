import { createCooking } from '@/cooking/runtime/create-cooking';
import { deliveryProject } from '@/cooking/testing/project';
import { engineeringScenario } from '@/cooking/testing/scenario';
import {
  completeRepairExecution,
  completeSuccessfulExecution,
} from '@/cooking/testing/execution';
import { openDatabase } from '@/platform/database';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export type BrowserFixture = {
  developerUsername: string;
  password: string;
  projectId: string;
  submissionId: string;
  username: string;
};

export async function seedBrowserFixture(home: string): Promise<BrowserFixture> {
  const db = openDatabase(join(home, 'server', 'server.sqlite'));
  try {
    const password = 'browser-test-password';
    const {
      users,
      project,
      submission,
      items,
      pairedRunner: paired,
    } = await deliveryProject(db, {
      name: '浏览器验收项目',
      prefix: 'browser',
      password,
      runnerName: '浏览器测试 Agent',
      people: {
        owner: ['browser-owner', '浏览器测试负责人', randomUUID()],
        tester: ['browser-tester', '浏览器测试执行人', randomUUID()],
        developer: ['browser-developer', '浏览器测试开发者', randomUUID()],
      },
      sources: [
        {
          name: '浏览器前端工程',
          type: 'FRONTEND',
          identifier: 'browser-web',
          environment: '浏览器测试环境',
          deployment: { kind: 'CI_CD' },
          repository: 'https://example.com/browser.git',
          branch: 'feature/browser-test',
        },
        {
          name: '浏览器后端工程',
          type: 'BACKEND',
          identifier: 'browser-api',
          environment: '浏览器后端环境',
          deployment: { kind: 'CI_CD' },
          repository: 'https://example.com/browser-api.git',
          branch: 'feature/browser-test',
        },
      ],
      title: '浏览器架构验收提测',
      description: '覆盖路由、Action、附件和缺陷生命周期交互',
    });
    const { tester, developer } = users;
    engineeringScenario(db, users.owner.id, project.id, {
      name: '浏览器追加工程',
      type: 'FRONTEND',
      identifier: 'browser-extra',
      environment: '追加测试环境',
      deployment: { kind: 'LOCAL_SCRIPT', command: 'pnpm run deploy:84' },
      repository: 'https://example.com/browser-extra.git',
      developers: { developer: { userId: developer.id, runnerId: paired.runner.id } },
    });
    const item = items[0]!;

    const { executions, bugs, lifecycle, repairs, updates } = createCooking(db);

    const createBug = (title: string) =>
      bugs.createBug(tester.id, submission.id, {
        mutationId: randomUUID(),
        submissionItemId: item.id,
        title,
        operationPath: '打开浏览器验收页面并执行目标操作',
        actualResult: `${title} 的实际结果`,
        expectedResult: `${title} 的预期结果`,
        actualResultAttachmentIds: [],
        expectedResultAttachmentIds: [],
      }).bug;

    createBug('待取消缺陷');
    createBug('待请求修复缺陷');
    for (const title of ['测试负责人删除缺陷', '开发负责人删除缺陷']) {
      bugs.createBug(tester.id, submission.id, {
        mutationId: randomUUID(),
        submissionItemId: null,
        title,
        actualResultAttachmentIds: [],
        expectedResultAttachmentIds: [],
      });
    }
    bugs.createBug(tester.id, submission.id, {
      mutationId: randomUUID(),
      submissionItemId: null,
      title: '待前后端分诊缺陷',
      expectedResult: '前端和后端共同完成',
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
    });

    for (const title of ['定位数据缺失缺陷', '待增加协作缺陷']) {
      const failedBug = createBug(title);
      bugs.requestRepair(tester.id, failedBug.id, {
        mutationId: randomUUID(),
        expectedVersion: failedBug.version,
      });
      const failedExecution = (await executions.claim(paired.runner.id, 1, 0))[0]!;
      executions.start(paired.runner.id, failedExecution.id, {
        kind: 'STARTED',
        leaseToken: failedExecution.lease.token,
        sessionId: `browser-failed-${failedBug.id}`,
        taskSkillBinding: fixtureSkillBinding('agent-party-time-repair-bug'),
      });
      executions.complete(paired.runner.id, failedExecution.id, {
        leaseToken: failedExecution.lease.token,
        sessionId: `browser-failed-${failedBug.id}`,
        outcome: {
          kind: 'SUCCEEDED',
          result: {
            result: {
              outcome: 'FAILED',
              failedStep: '修复',
              reason: '地块缺少定位数据，问题尚未解决。',
              completedActions: ['确认三条地块的边界为空'],
              pendingActions: ['核查边界数据并验证标签渲染'],
            },
          },
        },
      });
    }

    const completeRepair = async (
      title: string,
      stage: 'DONE' | 'WAITING_FOR_VERIFICATION',
    ) => {
      const bug = createBug(title);
      bugs.requestRepair(tester.id, bug.id, {
        mutationId: randomUUID(),
        expectedVersion: bug.version,
      });
      const claimed = (await executions.claim(paired.runner.id, 1, 0))[0]!;
      executions.start(paired.runner.id, claimed.id, {
        kind: 'STARTED',
        leaseToken: claimed.lease.token,
        sessionId: `browser-session-${bug.id}`,
        taskSkillBinding: fixtureSkillBinding('agent-party-time-repair-bug'),
      });
      executions.complete(paired.runner.id, claimed.id, {
        leaseToken: claimed.lease.token,
        sessionId: `browser-session-${bug.id}`,
        outcome: {
          kind: 'SUCCEEDED',
          result: {
            result: {
              outcome: 'COMPLETED',
              completionKind: 'TARGET_ALREADY_FIXED',
              changes: [],
              validations: [{ name: '夹具验证', status: 'PASSED', detail: '' }],
              warnings: [],
              commits: [],
              manualOperations: [],
            },
          },
        },
      });
      if (stage === 'DONE') {
        const current = bugs
          .workspace(tester.id, submission.id)
          .bugs.find(({ id }) => id === bug.id)!;
        lifecycle.verifyBug(tester.id, bug.id, {
          mutationId: randomUUID(),
          expectedVersion: current.version,
          result: 'PASSED',
          attachmentIds: [],
        });
      }
      return bug;
    };

    await completeRepair('待归档与重开缺陷', 'DONE');
    const reworkBug = await completeRepair('待验证返修缺陷', 'WAITING_FOR_VERIFICATION');
    lifecycle.verifyBug(tester.id, reworkBug.id, {
      mutationId: randomUUID(),
      expectedVersion: bugs
        .workspace(tester.id, submission.id)
        .bugs.find(({ id }) => id === reworkBug.id)!.version,
      result: 'FAILED',
      feedback: '上次反馈：刷新后内容仍然丢失',
      attachmentIds: [],
    });
    const rework = (await executions.claim(paired.runner.id, 1, 0))[0]!;
    const reworkSession = `browser-session-${reworkBug.id}`;
    executions.start(paired.runner.id, rework.id, {
      kind: 'STARTED',
      leaseToken: rework.lease.token,
      sessionId: reworkSession,
      taskSkillBinding: fixtureSkillBinding('agent-party-time-repair-bug'),
    });
    completeSuccessfulExecution(
      { executions, runner: paired.runner },
      {
        executionId: rework.id,
        leaseToken: rework.lease.token,
        sessionId: reworkSession,
      },
      {
        result: {
          outcome: 'COMPLETED',
          completionKind: 'TARGET_ALREADY_FIXED',
          changes: [],
          validations: [{ name: '夹具验证', status: 'PASSED', detail: '' }],
          warnings: [],
          commits: [],
          manualOperations: [],
        },
      },
    );
    await completeRepair('待验证通过缺陷', 'WAITING_FOR_VERIFICATION');

    // 完成后的返修入口和长时间线一起覆盖页签切换带动遮罩滚动的场景。
    const scrollBug = createBug('修复更新页签滚动回归');
    bugs.requestRepair(tester.id, scrollBug.id, {
      mutationId: randomUUID(),
      expectedVersion: scrollBug.version,
    });
    const scrollRepair = (await executions.claim(paired.runner.id, 1, 0))[0]!;
    executions.start(paired.runner.id, scrollRepair.id, {
      kind: 'STARTED',
      leaseToken: scrollRepair.lease.token,
      sessionId: `browser-scroll-repair-${scrollBug.id}`,
      taskSkillBinding: fixtureSkillBinding('agent-party-time-repair-bug'),
    });
    executions.complete(paired.runner.id, scrollRepair.id, {
      leaseToken: scrollRepair.lease.token,
      sessionId: `browser-scroll-repair-${scrollBug.id}`,
      outcome: {
        kind: 'SUCCEEDED',
        result: {
          result: {
            outcome: 'FAILED',
            failedStep: '验证',
            reason: '修复已完成，完整检查尚未通过。',
            completedActions: [
              '确认目标分支和工作区状态，核对工程配置及复现步骤。'.repeat(8),
              '完成界面修改，检查按钮尺寸、字段排版和不同主题下的交互状态。'.repeat(8),
            ],
            pendingActions: ['修复剩余检查项后再次执行验证。'],
          },
        },
      },
    });
    repairs.continueRepair(developer.id, scrollBug.id, {
      mutationId: randomUUID(),
      expectedVersion: bugs
        .workspace(tester.id, submission.id)
        .bugs.find((bug) => bug.id === scrollBug.id)!.version,
    });
    const nextScrollRepair = (await executions.claim(paired.runner.id, 1, 0))[0]!;
    completeRepairExecution(
      { executions, runner: paired.runner },
      nextScrollRepair.id,
      nextScrollRepair.lease.token,
      `browser-scroll-repair-${scrollBug.id}`,
      ['a'.repeat(40)],
    );
    const scrollBatch = updates.freezeNow(developer.id, item.id, {
      mutationId: randomUUID(),
    });
    const scrollUpdate = (await executions.claim(paired.runner.id, 1, 0))[0]!;
    executions.start(paired.runner.id, scrollUpdate.id, {
      kind: 'STARTED',
      leaseToken: scrollUpdate.lease.token,
      sessionId: `browser-scroll-update-${scrollBug.id}`,
      taskSkillBinding: fixtureSkillBinding('agent-party-time-integrate-update-batch'),
    });
    executions.complete(paired.runner.id, scrollUpdate.id, {
      leaseToken: scrollUpdate.lease.token,
      sessionId: `browser-scroll-update-${scrollBug.id}`,
      outcome: {
        kind: 'SUCCEEDED',
        result: {
          result: {
            handoffUse: {
              adopted: ['沿用修复阶段已确认的测试入口'],
              rechecked: [{ context: '构建参数', reason: '集成后的配置需要再次核实' }],
              validationCommands: [
                {
                  validationIndex: 0,
                  command: 'bun run check:delivery',
                  workingDirectory: '.',
                  reason: '一次入口覆盖测试与构建，未重复运行前置阶段',
                },
              ],
            },
            outcome: 'PUSHED',
            completedActions: ['集成修复提交并完成推送'],
            validations: [{ name: '构建检查', status: 'PASSED', detail: '' }],
            warnings: [],
          },
        },
      },
    });
    updates.reportExternalDeployment(developer.id, scrollBatch.batchId, {
      mutationId: randomUUID(),
      expectedVersion: updates.batchView(developer.id, scrollBatch.batchId).version,
      outcome: 'SUCCEEDED',
      attachmentIds: [],
    });
    lifecycle.verifyBug(tester.id, scrollBug.id, {
      mutationId: randomUUID(),
      expectedVersion: bugs
        .workspace(tester.id, submission.id)
        .bugs.find((bug) => bug.id === scrollBug.id)!.version,
      result: 'PASSED',
      attachmentIds: [],
    });

    const manualBug = createBug('等待人工确认缺陷');
    bugs.requestRepair(tester.id, manualBug.id, {
      mutationId: randomUUID(),
      expectedVersion: manualBug.version,
    });
    const manualExecution = (await executions.claim(paired.runner.id, 1, 0))[0]!;
    const manualSession = `browser-manual-${manualBug.id}`;
    executions.start(paired.runner.id, manualExecution.id, {
      kind: 'STARTED',
      leaseToken: manualExecution.lease.token,
      sessionId: manualSession,
      taskSkillBinding: fixtureSkillBinding('agent-party-time-repair-bug'),
    });
    const questions = ['是否确认移除区县大屏访问权限，并保留正常业务登录？'];
    executions.openInteraction(paired.runner.id, manualExecution.id, {
      leaseToken: manualExecution.lease.token,
      kind: 'USER_INPUT',
      method: 'xapt/manualHandoff',
      payload: { questions },
    });
    executions.complete(paired.runner.id, manualExecution.id, {
      leaseToken: manualExecution.lease.token,
      sessionId: manualSession,
      outcome: { kind: 'HANDED_OFF', questions },
    });

    const interactionBug = createBug('等待审批缺陷');
    bugs.requestRepair(tester.id, interactionBug.id, {
      mutationId: randomUUID(),
      expectedVersion: interactionBug.version,
    });
    const claimed = (await executions.claim(paired.runner.id, 1, 0))[0]!;
    executions.start(paired.runner.id, claimed.id, {
      kind: 'STARTED',
      leaseToken: claimed.lease.token,
      sessionId: `browser-interaction-${interactionBug.id}`,
      taskSkillBinding: fixtureSkillBinding('agent-party-time-repair-bug'),
    });
    executions.openInteraction(paired.runner.id, claimed.id, {
      leaseToken: claimed.lease.token,
      kind: 'APPROVAL',
      method: 'item/commandExecution/requestApproval',
      payload: {
        command: 'bun test',
        reason: '验证浏览器中的原生审批交互',
      },
    });

    // 两条缺陷共享一个更新会话，等待工程负责人确认整批部署。
    for (const [index, title] of ['批次更新缺陷甲', '批次更新缺陷乙'].entries()) {
      const member = bugs.createBug(tester.id, submission.id, {
        mutationId: randomUUID(),
        submissionItemId: items[1]!.id,
        title,
        expectedResult: `${title} 的预期结果`,
        actualResult: `${title} 的实际结果`,
        actualResultAttachmentIds: [],
        expectedResultAttachmentIds: [],
      }).bug;
      bugs.requestRepair(tester.id, member.id, {
        mutationId: randomUUID(),
        expectedVersion: member.version,
      });
      const repair = (await executions.claim(paired.runner.id, 1, 0))[0]!;
      completeRepairExecution(
        { executions, runner: paired.runner },
        repair.id,
        repair.lease.token,
        `browser-batch-repair-${index}`,
        [(index ? 'c' : 'b').repeat(40)],
      );
    }
    const sharedBatch = updates.freezeNow(developer.id, items[1]!.id, {
      mutationId: randomUUID(),
    });
    const sharedUpdate = (await executions.claim(paired.runner.id, 1, 0))[0]!;
    if (sharedUpdate.id !== sharedBatch.executionId)
      throw new Error('未领取到共享更新批次');
    executions.start(paired.runner.id, sharedUpdate.id, {
      kind: 'STARTED',
      leaseToken: sharedUpdate.lease.token,
      sessionId: 'browser-shared-update',
      taskSkillBinding: fixtureSkillBinding('agent-party-time-integrate-update-batch'),
    });
    completeSuccessfulExecution(
      { executions, runner: paired.runner },
      {
        executionId: sharedUpdate.id,
        leaseToken: sharedUpdate.lease.token,
        sessionId: 'browser-shared-update',
      },
      {
        result: {
          handoffUse: {
            adopted: ['沿用修复阶段已确认的测试入口'],
            rechecked: [{ context: '构建参数', reason: '集成后的配置需要再次核实' }],
            validationCommands: [
              {
                validationIndex: 0,
                command: 'bun run check:delivery',
                workingDirectory: '.',
                reason: '一次入口覆盖测试与构建，未重复运行前置阶段',
              },
            ],
          },
          outcome: 'PUSHED',
          completedActions: ['合入两条缺陷修复并推送目标分支'],
          validations: [{ name: '共享批次构建', status: 'PASSED', detail: '' }],
          warnings: [],
        },
      },
    );

    return {
      developerUsername: developer.username,
      password,
      projectId: project.id,
      submissionId: submission.id,
      username: tester.username,
    };
  } finally {
    db.close();
  }
}

function fixtureSkillBinding(skillName: string) {
  return {
    skillName,
    bundleHash: 'a'.repeat(64),
    sourceRevision: 'b'.repeat(40),
  };
}
