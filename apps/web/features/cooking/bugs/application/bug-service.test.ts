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
import { RepairService } from '@/features/cooking/repair/application/repair-service';
import { ZodError } from 'zod';
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
  test('只有 Tester 可创建，空白可选字段不保存且附件按实际与预期结果分组', async () => {
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
          actualResultAttachmentIds: Array.from({ length: 6 }, () =>
            randomUUID(),
          ),
          expectedResultAttachmentIds: [],
        },
      ),
    ).toThrow();
    const file = await fixture.files.put({
      bytes: new TextEncoder().encode('复现记录'),
      originalName: '复现.txt',
      mediaType: 'text/plain',
      uploadedByUserId: fixture.users.tester.id,
    });
    const expectedFile = await fixture.files.put({
      bytes: new TextEncoder().encode('预期界面'),
      originalName: '预期.txt',
      mediaType: 'text/plain',
      uploadedByUserId: fixture.users.tester.id,
    });
    expect(() =>
      fixture.service.createBug(
        fixture.users.tester.id,
        fixture.submission.id,
        {
          mutationId: randomUUID(),
          submissionItemId: null,
          title: '附件不能跨结果重复使用',
          actualResultAttachmentIds: [file.id],
          expectedResultAttachmentIds: [file.id],
        },
      ),
    ).toThrow(ZodError);
    expect(() =>
      fixture.service.createBug(
        fixture.users.tester.id,
        fixture.submission.id,
        {
          mutationId: randomUUID(),
          submissionItemId: null,
          title: '同一结果不能重复添加附件',
          actualResultAttachmentIds: [file.id, file.id],
          expectedResultAttachmentIds: [],
        },
      ),
    ).toThrow(ZodError);
    const result = createBug(fixture, fixture.users.tester.id, {
      title: '  结算按钮无响应  ',
      operationPath: '   ',
      actualResultAttachmentIds: [file.id],
      expectedResultAttachmentIds: [expectedFile.id],
    });
    expect(result.bug).toMatchObject({
      shortId: 1,
      submissionItemId: null,
      stage: 'WAITING_FOR_REPAIR',
      report: {
        title: '结算按钮无响应',
        actualResultAttachmentIds: [file.id],
        expectedResultAttachmentIds: [expectedFile.id],
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
        .bugs[0]?.report.actualResultAttachments[0],
    ).toMatchObject({ id: file.id, originalName: '复现.txt' });
    expect(
      fixture.service.workspace(fixture.users.tester.id, fixture.submission.id)
        .bugs[0]?.report.expectedResultAttachments[0],
    ).toMatchObject({ id: expectedFile.id, originalName: '预期.txt' });
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
        actualResultAttachmentIds: [],
        expectedResultAttachmentIds: [],
      },
    );
    expect(updated.unboundAttachmentIds).toEqual([file.id, expectedFile.id]);
    expect(
      await fixture.files.deleteUnbound(file.id, fixture.users.tester.id),
    ).toBe(true);
    expect(
      await fixture.files.deleteUnbound(
        expectedFile.id,
        fixture.users.tester.id,
      ),
    ).toBe(true);
  });

  test('分诊后仅测试负责人可开始修复且报告永久锁定', async () => {
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
      fixture.users.tester.id,
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
    expect(() =>
      fixture.service.updateReport(fixture.users.tester.id, repairing.id, {
        mutationId: randomUUID(),
        expectedVersion: repairing.version,
        submissionItemId: fixture.items.front,
        title: '不能覆盖',
        actualResultAttachmentIds: [],
        expectedResultAttachmentIds: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    expect(
      fixture.service.workspace(fixture.users.tester.id, fixture.submission.id),
    ).not.toHaveProperty('repairQueue');
  });

  test('不同工程直接提交自动修复且不再暴露全局队列或人工顺序', async () => {
    const fixture = await setup();
    const first = createAssignedBug(fixture, '前端问题', fixture.items.front);
    const second = createAssignedBug(fixture, '后端问题', fixture.items.back);
    const firstQueued = fixture.service.requestRepair(
      fixture.users.tester.id,
      first.id,
      mutation(first.version),
    ).bug;
    fixture.service.requestRepair(
      fixture.users.tester.id,
      second.id,
      mutation(second.version),
    );
    const workspace = fixture.service.workspace(
      fixture.users.developerA.id,
      fixture.submission.id,
    );
    expect(workspace).not.toHaveProperty('repairQueue');
    expect(workspace.bugs.map(({ id, stage }) => ({ id, stage }))).toEqual([
      { id: first.id, stage: 'REPAIRING' },
      { id: second.id, stage: 'REPAIRING' },
    ]);
    expect(JSON.stringify(workspace)).not.toMatch(
      /queuePosition|REORDER|全局修复队列/u,
    );
    expect(firstQueued.reportLockedAt).not.toBeNull();
  });

  test('Workspace 返回服务端动作并隐藏 Binding，锁定后不再提供通用反馈', async () => {
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
    const developerView = fixture.service.workspace(
      fixture.users.developerA.id,
      fixture.submission.id,
    );
    expect(developerView.bugs[0]?.availableActions).toEqual([]);
    expect(JSON.stringify(developerView)).not.toMatch(
      /binding|runner|repository|branch|commit|prompt|feedback/iu,
    );
    expect(repairing.version).toBe(bug.version + 1);
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
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
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

  test('deleteBugs 校验缺陷存在与参数互斥', async () => {
    const fixture = await setup();
    expect(() => fixture.service.deleteBugs({})).toThrow(ZodError);
    expect(() => fixture.service.deleteBugs({ bugIds: [] })).toThrow(ZodError);
    expect(() =>
      fixture.service.deleteBugs({
        bugIds: [randomUUID()],
        all: true,
      }),
    ).toThrow(ZodError);
    expect(() =>
      fixture.service.deleteBugs({ bugIds: [randomUUID()] }),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  test('deleteBugs 删除无执行的普通缺陷并推进提测版本', async () => {
    const fixture = await setup();
    const first = createBug(fixture, fixture.users.tester.id, {
      title: '待删除缺陷一',
    });
    const second = createBug(fixture, fixture.users.tester.id, {
      title: '待删除缺陷二',
    });
    const revisionBefore = fixture.service.workspace(
      fixture.users.tester.id,
      fixture.submission.id,
    ).bugs.length;
    expect(revisionBefore).toBe(2);

    const result = fixture.service.deleteBugs({
      bugIds: [first.bug.id, second.bug.id],
    });
    expect(result.deletedBugIds).toEqual([first.bug.id, second.bug.id]);
    expect(result.deletedExecutionIds).toEqual([]);
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) count FROM cooking_bug WHERE id = ?',
        )
        .get(first.bug.id)?.count,
    ).toBe(0);
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) count FROM cooking_mutation
           WHERE resource_type = 'BUG' AND resource_id = ?`,
        )
        .get(first.bug.id)?.count,
    ).toBe(0);
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) count FROM cooking_audit_event
           WHERE target_type = 'BUG' AND target_id = ?`,
        )
        .get(second.bug.id)?.count,
    ).toBe(0);
    expect(fixture.events.at(-1)).toEqual({
      submissionId: fixture.submission.id,
      revision: 4,
    });
  });

  test('deleteBugs 存在非终态执行且未 force 时拒绝删除', async () => {
    const fixture = await setup();
    const bug = createAssignedBug(fixture, '进行中缺陷', fixture.items.front);
    new RepairService(fixture.database).createInitialExecution(bug.id);
    expect(() => fixture.service.deleteBugs({ bugIds: [bug.id] })).toThrow(
      expect.objectContaining({ code: 'RESOURCE_CONFLICT' }),
    );
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) count FROM cooking_bug WHERE id = ?',
        )
        .get(bug.id)?.count,
    ).toBe(1);
  });

  test('deleteBugs --force 删除链式修复执行与关联上下文', async () => {
    const fixture = await setup();
    const bug = createAssignedBug(fixture, '链式修复缺陷', fixture.items.front);
    const repairs = new RepairService(fixture.database);
    const first = repairs.createInitialExecution(bug.id);
    fixture.database
      .prepare(
        `UPDATE platform_execution
         SET state = 'FAILED', finished_at = ? WHERE id = ?`,
      )
      .run('2026-07-27T03:30:00.000Z', first);
    const second = repairs.createInitialExecution(bug.id);
    fixture.database
      .prepare(
        `UPDATE platform_execution
         SET state = 'SUCCEEDED', finished_at = ? WHERE id = ?`,
      )
      .run('2026-07-27T04:00:00.000Z', second);
    const previous = fixture.database
      .query<{ previous_execution_id: string | null }, [string]>(
        'SELECT previous_execution_id FROM platform_execution WHERE id = ?',
      )
      .get(second)?.previous_execution_id;
    expect(previous).toBe(first);

    const result = fixture.service.deleteBugs({
      bugIds: [bug.id],
      force: true,
    });
    expect(new Set(result.deletedExecutionIds)).toEqual(
      new Set([first, second]),
    );
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) count FROM platform_execution WHERE id = ?',
        )
        .get(first)?.count,
    ).toBe(0);
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) count FROM cooking_repair_attempt WHERE bug_id = ?',
        )
        .get(bug.id)?.count,
    ).toBe(0);
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) count FROM cooking_bug_repair_context WHERE bug_id = ?',
        )
        .get(bug.id)?.count,
    ).toBe(0);
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) count FROM cooking_bug WHERE id = ?',
        )
        .get(bug.id)?.count,
    ).toBe(0);
  });

  test('deleteBugs --all --force 清理空的统一更新批次与活动执行', async () => {
    const fixture = await setup();
    const bug = createAssignedBug(fixture, '批次内缺陷', fixture.items.front);
    const repairs = new RepairService(fixture.database);
    const executionId = repairs.createInitialExecution(bug.id);
    fixture.database
      .prepare(
        `UPDATE platform_execution
         SET state = 'SUCCEEDED', finished_at = ? WHERE id = ?`,
      )
      .run('2026-07-27T04:00:00.000Z', executionId);
    const now = '2026-07-27T04:00:00.000Z';
    const batchId = randomUUID();
    fixture.database
      .prepare(
        `INSERT INTO cooking_update_batch(
           id, submission_id, submission_item_id, state, version,
           active_execution_id, session_id, deployment_json, frozen_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'RUNNING', 1, ?, NULL, '{}', ?, ?, ?)`,
      )
      .run(
        batchId,
        fixture.submission.id,
        fixture.items.front,
        executionId,
        now,
        now,
        now,
      );
    fixture.database
      .prepare(
        `INSERT INTO cooking_update_batch_entry(
           batch_id, bug_id, position, commits_json
         ) VALUES (?, ?, 0, '[]')`,
      )
      .run(batchId, bug.id);
    fixture.database
      .prepare(
        `INSERT INTO cooking_update_attempt(
           id, batch_id, execution_id, attempt, outcome_json, created_at, finished_at
         ) VALUES (?, ?, ?, 1, NULL, ?, NULL)`,
      )
      .run(randomUUID(), batchId, executionId, now);

    const result = fixture.service.deleteBugs({ all: true, force: true });
    expect(result.deletedExecutionIds).toEqual([executionId]);
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) count FROM cooking_update_batch_entry WHERE bug_id = ?`,
        )
        .get(bug.id)?.count,
    ).toBe(0);
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) count FROM cooking_update_attempt WHERE execution_id = ?`,
        )
        .get(executionId)?.count,
    ).toBe(0);
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) count FROM cooking_update_batch WHERE id = ?',
        )
        .get(batchId)?.count,
    ).toBe(0);
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) count FROM platform_execution WHERE id = ?',
        )
        .get(executionId)?.count,
    ).toBe(0);
  });

  test('deleteBugs --all 删除全部缺陷', async () => {
    const fixture = await setup();
    createBug(fixture, fixture.users.tester.id, { title: '全部清理一' });
    createBug(fixture, fixture.users.tester.id, { title: '全部清理二' });
    const result = fixture.service.deleteBugs({ all: true });
    expect(result.deletedBugIds).toHaveLength(2);
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) count FROM cooking_bug WHERE submission_id = ?',
        )
        .get(fixture.submission.id)?.count,
    ).toBe(0);
  });
});

function createBug(
  fixture: Awaited<ReturnType<typeof setup>>,
  actorUserId: string,
  values: {
    title: string;
    operationPath?: string;
    actualResultAttachmentIds?: string[];
    expectedResultAttachmentIds?: string[];
  },
) {
  return fixture.service.createBug(actorUserId, fixture.submission.id, {
    mutationId: randomUUID(),
    submissionItemId: null,
    title: values.title,
    operationPath: values.operationPath,
    actualResultAttachmentIds: values.actualResultAttachmentIds ?? [],
    expectedResultAttachmentIds: values.expectedResultAttachmentIds ?? [],
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
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
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
