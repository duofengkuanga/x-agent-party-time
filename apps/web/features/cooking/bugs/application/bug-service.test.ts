import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import { LocalFileStore } from '@/server/files/local-file-store';
import { RunnerService } from '@/server/runner/service';
import { BindingService } from '@/features/cooking/bindings/application/binding-service';
import { EngineeringService } from '@/features/cooking/engineering/application/engineering-service';
import { ProjectService } from '@/features/cooking/projects/application/project-service';
import { SubmissionService } from '@/features/cooking/submissions/application/submission-service';
import { BugService } from './bug-service';

const directories: string[] = [];
const databases: AppDatabase[] = [];

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-time-bugs-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
  const auth = new AuthService(database);
  const users = {
    owner: await auth.seedUser(user('bug-owner', '项目所有者')),
    tester: await auth.seedUser(user('bug-tester', '测试负责人')),
    developerA: await auth.seedUser(user('bug-dev-a', '开发甲')),
    developerB: await auth.seedUser(user('bug-dev-b', '开发乙')),
    member: await auth.seedUser(user('bug-member', '普通成员')),
    outsider: await auth.seedUser(user('bug-outsider', '项目外用户')),
  };
  const projects = new ProjectService(database);
  const project = projects.createProject(users.owner.id, {
    mutationId: randomUUID(),
    name: '缺陷协作项目',
  }).project;
  for (const invited of [
    users.tester,
    users.developerA,
    users.developerB,
    users.member,
  ]) {
    const invitation = projects.inviteUser(users.owner.id, project.id, {
      mutationId: randomUUID(),
      username: invited.username,
    });
    projects.respondToInvitation(invited.id, invitation.id, {
      mutationId: randomUUID(),
      expectedVersion: invitation.version,
      decision: 'ACCEPT',
    });
  }
  const engineering = new EngineeringService(database);
  const front = engineering.createEngineering(users.owner.id, project.id, {
    mutationId: randomUUID(),
    name: '前端工程',
    type: 'FRONTEND',
    identifier: 'web',
  });
  const back = engineering.createEngineering(users.owner.id, project.id, {
    mutationId: randomUUID(),
    name: '后端工程',
    type: 'BACKEND',
    identifier: 'api',
  });
  engineering.addMember(users.owner.id, front.id, users.developerA.id, {
    mutationId: randomUUID(),
  });
  engineering.addMember(users.owner.id, back.id, users.developerB.id, {
    mutationId: randomUUID(),
  });
  const frontEnvironment = engineering.createEnvironment(
    users.owner.id,
    front.id,
    {
      mutationId: randomUUID(),
      name: '前端测试环境',
      deployment: { kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' },
    },
  );
  const backEnvironment = engineering.createEnvironment(
    users.owner.id,
    back.id,
    {
      mutationId: randomUUID(),
      name: '后端测试环境',
      deployment: { kind: 'CI_CD' },
    },
  );
  const runners = new RunnerService(database);
  const runnerA = runners.pair(
    runners.issuePairingCode(users.developerA.id).code,
    '开发甲 Runner',
  );
  const runnerB = runners.pair(
    runners.issuePairingCode(users.developerB.id).code,
    '开发乙 Runner',
  );
  const bindings = new BindingService(database);
  const frontBinding = bindings.createBinding(
    users.developerA.id,
    front.id,
    runnerA.runner.id,
    randomUUID(),
  );
  const backBinding = bindings.createBinding(
    users.developerB.id,
    back.id,
    runnerB.runner.id,
    randomUUID(),
  );
  bindings.confirmRepository(
    runnerA.runner.id,
    frontBinding.id,
    'https://example.com/front.git',
  );
  bindings.confirmRepository(
    runnerB.runner.id,
    backBinding.id,
    'https://example.com/back.git',
  );
  const submission = new SubmissionService(database).createSubmission(
    users.owner.id,
    project.id,
    {
      mutationId: randomUUID(),
      title: '双工程提测',
      requirementDescription: '验证全局缺陷队列',
      testerUserId: users.tester.id,
      items: [
        {
          engineeringId: front.id,
          responsibleUserId: users.developerA.id,
          bindingId: frontBinding.id,
          targetBranch: 'feature/front',
          environmentId: frontEnvironment.id,
        },
        {
          engineeringId: back.id,
          responsibleUserId: users.developerB.id,
          bindingId: backBinding.id,
          targetBranch: 'feature/back',
          environmentId: backEnvironment.id,
        },
      ],
    },
  );
  const items = database
    .prepare(
      `SELECT id, engineering_id FROM cooking_submission_item
       WHERE submission_id = ? ORDER BY position`,
    )
    .all(submission.id) as Array<{ id: string; engineering_id: string }>;
  const events: Array<{ submissionId: string; revision: number }> = [];
  const service = new BugService(
    database,
    () => new Date('2026-07-27T03:00:00.000Z'),
    undefined,
    (submissionId, revision) => events.push({ submissionId, revision }),
  );
  return {
    database,
    directory,
    events,
    files: new LocalFileStore(database, join(directory, 'files')),
    items: { front: items[0]!.id, back: items[1]!.id },
    project,
    service,
    submission,
    users,
  };
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('BugService', () => {
  test('只有 Tester 可创建，空白可选字段不保存且附件绑定到报告', async () => {
    const fixture = await setup();
    expect(() =>
      createBug(fixture, fixture.users.member.id, {
        title: '普通成员不能创建',
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(() =>
      fixture.service.createBug(
        fixture.users.tester.id,
        fixture.submission.id,
        {
          mutationId: randomUUID(),
          submissionItemId: null,
          title: '附件过多',
          attachmentIds: Array.from({ length: 6 }, () => randomUUID()),
        },
      ),
    ).toThrow();
    const file = await fixture.files.put({
      bytes: new TextEncoder().encode('复现记录'),
      originalName: '复现.txt',
      mediaType: 'text/plain',
      uploadedByUserId: fixture.users.tester.id,
    });
    const result = createBug(fixture, fixture.users.tester.id, {
      title: '  结算按钮无响应  ',
      operationPath: '   ',
      attachmentIds: [file.id],
    });
    expect(result.bug).toMatchObject({
      shortId: 1,
      submissionItemId: null,
      stage: 'WAITING_FOR_REPAIR',
      report: {
        title: '结算按钮无响应',
        attachmentIds: [file.id],
      },
      version: 1,
    });
    expect(result.bug.report).not.toHaveProperty('operationPath');
    expect(() =>
      fixture.service.requestRepair(
        fixture.users.tester.id,
        result.bug.id,
        mutation(result.bug.version),
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(result.revision).toBe(2);
    expect(fixture.events).toEqual([
      { submissionId: fixture.submission.id, revision: 2 },
    ]);
    expect(
      fixture.service.workspace(fixture.users.tester.id, fixture.submission.id)
        .bugs[0]?.report.attachments[0],
    ).toMatchObject({ id: file.id, originalName: '复现.txt' });
    expect(() =>
      fixture.service.requireAttachmentAccess(fixture.users.member.id, file.id),
    ).not.toThrow();
    expect(() =>
      fixture.service.requireAttachmentAccess(
        fixture.users.outsider.id,
        file.id,
      ),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    const updated = fixture.service.updateReport(
      fixture.users.tester.id,
      result.bug.id,
      {
        mutationId: randomUUID(),
        expectedVersion: result.bug.version,
        submissionItemId: null,
        title: result.bug.report.title,
        attachmentIds: [],
      },
    );
    expect(updated.unboundAttachmentIds).toEqual([file.id]);
    expect(
      await fixture.files.deleteUnbound(file.id, fixture.users.tester.id),
    ).toBe(true);
  });

  test('分诊、首次修复锁定与撤回保持报告永久锁定', async () => {
    const fixture = await setup();
    const created = createBug(fixture, fixture.users.tester.id, {
      title: '待分诊缺陷',
    }).bug;
    const assigned = fixture.service.assignBug(
      fixture.users.developerB.id,
      created.id,
      {
        mutationId: randomUUID(),
        expectedVersion: 1,
        submissionItemId: fixture.items.front,
      },
    ).bug;
    expect(assigned.submissionItemId).toBe(fixture.items.front);
    const assignedView = fixture.service
      .workspace(fixture.users.developerA.id, fixture.submission.id)
      .bugs.find(({ id }) => id === assigned.id);
    expect(assignedView?.assignment).toMatchObject({
      engineeringName: '前端工程',
      engineeringType: 'FRONTEND',
      engineeringIdentifier: 'web',
    });
    expect(assignedView?.presentation.assignmentLabel).toBe('前端工程（web）');
    expect(
      fixture.database
        .query<{ name: string }, []>('PRAGMA table_info(cooking_bug)')
        .all()
        .map(({ name }) => name)
        .filter((name) => name.startsWith('engineering_')),
    ).toEqual([]);
    expect(() =>
      fixture.service.requestRepair(fixture.users.developerB.id, assigned.id, {
        mutationId: randomUUID(),
        expectedVersion: assigned.version,
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const repairing = fixture.service.requestRepair(
      fixture.users.developerA.id,
      assigned.id,
      {
        mutationId: randomUUID(),
        expectedVersion: assigned.version,
      },
    ).bug;
    expect(repairing).toMatchObject({
      stage: 'REPAIRING',
      version: 3,
      reportLockedAt: '2026-07-27T03:00:00.000Z',
    });
    const withdrawn = fixture.service.withdrawRepair(
      fixture.users.tester.id,
      repairing.id,
      {
        mutationId: randomUUID(),
        expectedVersion: repairing.version,
      },
    ).bug;
    expect(withdrawn).toMatchObject({
      stage: 'WAITING_FOR_REPAIR',
      version: 4,
      reportLockedAt: '2026-07-27T03:00:00.000Z',
    });
    expect(() =>
      fixture.service.updateReport(fixture.users.tester.id, withdrawn.id, {
        mutationId: randomUUID(),
        expectedVersion: withdrawn.version,
        submissionItemId: fixture.items.front,
        title: '不能覆盖',
        attachmentIds: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    expect(
      fixture.service.workspace(fixture.users.tester.id, fixture.submission.id)
        .repairQueue.entries,
    ).toEqual([]);
  });

  test('全局队列跨工程插队、重排并用 Queue Version 阻止并发覆盖', async () => {
    const fixture = await setup();
    const first = createAssignedBug(fixture, '前端问题', fixture.items.front);
    const second = createAssignedBug(fixture, '后端问题', fixture.items.back);
    const firstQueued = fixture.service.requestRepair(
      fixture.users.tester.id,
      first.id,
      mutation(first.version),
    ).bug;
    fixture.service.requestRepair(
      fixture.users.developerB.id,
      second.id,
      mutation(second.version),
    );
    const queue = fixture.service.workspace(
      fixture.users.developerA.id,
      fixture.submission.id,
    ).repairQueue;
    expect(queue.entries.map(({ bugId }) => bugId)).toEqual([
      second.id,
      first.id,
    ]);
    expect(queue.availableActions).toEqual(['REORDER']);
    expect(
      fixture.service.workspace(fixture.users.member.id, fixture.submission.id)
        .repairQueue.availableActions,
    ).toEqual([]);
    expect(() =>
      fixture.service.reorderQueue(
        fixture.users.member.id,
        fixture.submission.id,
        {
          mutationId: randomUUID(),
          expectedVersion: queue.version,
          bugIds: [first.id, second.id],
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const reordered = fixture.service.reorderQueue(
      fixture.users.developerA.id,
      fixture.submission.id,
      {
        mutationId: randomUUID(),
        expectedVersion: queue.version,
        bugIds: [first.id, second.id],
      },
    );
    expect(reordered.version).toBe(queue.version + 1);
    expect(() =>
      fixture.service.reorderQueue(
        fixture.users.developerB.id,
        fixture.submission.id,
        {
          mutationId: randomUUID(),
          expectedVersion: queue.version,
          bugIds: [second.id, first.id],
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
    expect(
      fixture.service
        .workspace(fixture.users.tester.id, fixture.submission.id)
        .repairQueue.entries.map(({ bugId }) => bugId),
    ).toEqual([first.id, second.id]);
    expect(firstQueued.reportLockedAt).not.toBeNull();
  });

  test('Workspace 返回服务端动作并隐藏 Binding，锁定后反馈只追加', async () => {
    const fixture = await setup();
    const bug = createAssignedBug(fixture, '反馈缺陷', fixture.items.front);
    const waitingView = fixture.service.workspace(
      fixture.users.tester.id,
      fixture.submission.id,
    ).bugs[0]!;
    expect(waitingView.availableActions).toEqual([
      'EDIT_REPORT',
      'ASSIGN',
      'REQUEST_REPAIR',
      'CANCEL',
    ]);
    const repairing = fixture.service.requestRepair(
      fixture.users.tester.id,
      bug.id,
      mutation(bug.version),
    ).bug;
    const feedback = fixture.service.addFeedback(
      fixture.users.developerA.id,
      bug.id,
      {
        mutationId: randomUUID(),
        expectedVersion: repairing.version,
        content: '已补充边界条件',
        attachmentIds: [],
      },
    ).bug;
    const developerView = fixture.service.workspace(
      fixture.users.developerA.id,
      fixture.submission.id,
    );
    expect(developerView.bugs[0]?.feedback).toHaveLength(1);
    expect(developerView.bugs[0]?.availableActions).toEqual([
      'ADD_FEEDBACK',
      'WITHDRAW_REPAIR',
    ]);
    expect(JSON.stringify(developerView)).not.toMatch(
      /binding|runner|repository|branch|commit|prompt/iu,
    );
    expect(feedback.version).toBe(repairing.version + 1);
    expect(() =>
      fixture.service.workspace(
        fixture.users.outsider.id,
        fixture.submission.id,
      ),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  test('重复 Mutation 不重复写 Audit、Revision 或实时失效通知', async () => {
    const fixture = await setup();
    const mutationId = randomUUID();
    const input = {
      mutationId,
      submissionItemId: null,
      title: '幂等登记',
      attachmentIds: [],
    };
    const first = fixture.service.createBug(
      fixture.users.tester.id,
      fixture.submission.id,
      input,
    );
    const replay = fixture.service.createBug(
      fixture.users.tester.id,
      fixture.submission.id,
      input,
    );
    expect(replay).toEqual(first);
    expect(fixture.events).toEqual([
      { submissionId: fixture.submission.id, revision: first.revision },
    ]);
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) count FROM cooking_audit_event
           WHERE target_id = ? AND action = 'BUG_CREATED'`,
        )
        .get(first.bug.id)?.count,
    ).toBe(1);
    expect(
      fixture.service.workspace(fixture.users.tester.id, fixture.submission.id)
        .bugs,
    ).toHaveLength(1);
  });
});

function createBug(
  fixture: Awaited<ReturnType<typeof setup>>,
  actorUserId: string,
  values: {
    title: string;
    operationPath?: string;
    attachmentIds?: string[];
  },
) {
  return fixture.service.createBug(actorUserId, fixture.submission.id, {
    mutationId: randomUUID(),
    submissionItemId: null,
    title: values.title,
    operationPath: values.operationPath,
    attachmentIds: values.attachmentIds ?? [],
  });
}

function createAssignedBug(
  fixture: Awaited<ReturnType<typeof setup>>,
  title: string,
  submissionItemId: string,
) {
  return fixture.service.createBug(
    fixture.users.tester.id,
    fixture.submission.id,
    {
      mutationId: randomUUID(),
      submissionItemId,
      title,
      attachmentIds: [],
    },
  ).bug;
}

function mutation(expectedVersion: number) {
  return { mutationId: randomUUID(), expectedVersion };
}

function user(id: string, displayName: string) {
  return {
    id,
    username: id,
    displayName,
    password: 'password',
  };
}
