import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AuthService } from '@/server/auth/service';
import { openDatabase } from '@/server/database';
import { ExecutionService } from '@/server/execution/service';
import { RunnerService } from '@/server/runner/service';
import { BindingService } from '@/features/cooking/bindings/application/binding-service';
import { BugService } from '@/features/cooking/bugs/application/bug-service';
import { EngineeringService } from '@/features/cooking/engineering/application/engineering-service';
import { cookingExecutionProjection } from '@/features/cooking/execution/application/execution-projection';
import { ProjectService } from '@/features/cooking/projects/application/project-service';
import { RepairService } from '@/features/cooking/repair/application/repair-service';
import { SubmissionService } from '@/features/cooking/submissions/application/submission-service';

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
    const auth = new AuthService(db);
    const owner = await auth.seedUser({
      id: randomUUID(),
      username: 'browser-owner',
      displayName: '浏览器测试负责人',
      password,
    });
    const tester = await auth.seedUser({
      id: randomUUID(),
      username: 'browser-tester',
      displayName: '浏览器测试执行人',
      password,
    });
    const developer = await auth.seedUser({
      id: randomUUID(),
      username: 'browser-developer',
      displayName: '浏览器测试开发者',
      password,
    });

    const projects = new ProjectService(db);
    const project = projects.createProject(owner.id, {
      mutationId: randomUUID(),
      name: '浏览器验收项目',
    }).project;
    for (const invited of [tester, developer]) {
      const invitation = projects.inviteUser(owner.id, project.id, {
        mutationId: randomUUID(),
        username: invited.username,
      });
      projects.respondToInvitation(invited.id, invitation.id, {
        mutationId: randomUUID(),
        expectedVersion: invitation.version,
        decision: 'ACCEPT',
      });
    }

    const engineering = new EngineeringService(db);
    const source = engineering.createEngineering(owner.id, project.id, {
      mutationId: randomUUID(),
      name: '浏览器前端工程',
      type: 'FRONTEND',
      identifier: 'browser-web',
    });
    engineering.addMember(owner.id, source.id, developer.id, {
      mutationId: randomUUID(),
    });
    const environment = engineering.createEnvironment(owner.id, source.id, {
      mutationId: randomUUID(),
      name: '浏览器测试环境',
      deployment: { kind: 'CI_CD' },
    });

    const runners = new RunnerService(db);
    const paired = runners.pair(
      runners.issuePairingCode(developer.id).code,
      '浏览器测试 Agent',
    );
    const bindings = new BindingService(db);
    const binding = bindings.createBinding(
      developer.id,
      source.id,
      paired.runner.id,
      randomUUID(),
    );
    bindings.confirmRepository(
      paired.runner.id,
      binding.id,
      'https://example.com/browser.git',
    );

    const submission = new SubmissionService(db).createSubmission(
      owner.id,
      project.id,
      {
        mutationId: randomUUID(),
        title: '浏览器架构验收提测',
        requirementDescription: '覆盖路由、Action、附件和缺陷生命周期交互',
        testerUserId: tester.id,
        items: [
          {
            engineeringId: source.id,
            responsibleUserId: developer.id,
            bindingId: binding.id,
            targetBranch: 'feature/browser-test',
            environmentId: environment.id,
          },
        ],
      },
    );
    const item = db
      .prepare('SELECT id FROM cooking_submission_item WHERE submission_id = ?')
      .get(submission.id) as { id: string };

    const repairs = new RepairService(db, new ExecutionService(db));
    const executions = new ExecutionService(
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      cookingExecutionProjection(db, {
        BUG_REPAIR: repairs,
        UPDATE_BATCH: { projectExecution: () => {} },
        CLEANUP: { projectExecution: () => {} },
      }),
    );
    const bugs = new BugService(db, undefined, undefined, undefined, {
      requested: (bugId) => repairs.createInitialExecution(bugId),
    });

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
            summary: `${title} 已修复`,
            changes: ['完成浏览器验收夹具修复'],
            validations: [{ name: '夹具验证', status: 'PASSED' }],
            warnings: [],
            commits: ['abcdef1'],
          },
        },
      });
      db.prepare('UPDATE cooking_bug SET stage = ? WHERE id = ?').run(
        stage,
        bug.id,
      );
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
