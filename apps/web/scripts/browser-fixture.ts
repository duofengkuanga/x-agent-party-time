import { createCooking } from '@/cooking/runtime/create-cooking';
import { deliveryProject } from '@/cooking/testing/project';
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

export async function seedBrowserFixture(
  home: string,
): Promise<BrowserFixture> {
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
      ],
      title: '浏览器架构验收提测',
      description: '覆盖路由、Action、附件和缺陷生命周期交互',
    });
    const { tester, developer } = users;
    const item = items[0]!;

    const { executions, bugs } = createCooking(db);

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
            outcome: 'COMPLETED',
            completionKind: 'CHANGES_COMMITTED',
            summary: `${title} 已修复`,
            changes: ['完成浏览器验收夹具修复'],
            validations: [{ name: '夹具验证', status: 'PASSED' }],
            warnings: [],
            commits: ['abcdef1'],
            manualOperations: [],
          },
        },
      });
      db.run('UPDATE cooking_bug SET stage = ? WHERE id = ?', [stage, bug.id]);
      return bug;
    };

    await completeRepair('待归档与重开缺陷', 'DONE');
    await completeRepair('待验证返修缺陷', 'WAITING_FOR_VERIFICATION');

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
