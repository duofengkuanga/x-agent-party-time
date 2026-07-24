import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ControlPlaneClientError,
  HttpControlPlaneAdapter,
} from '@agent-party-time/control-plane-client';
import type {
  SubmissionBug,
  SubmissionRepairTask,
  TestSubmissionDetail,
} from '@agent-party-time/shared';
import { startControlPlane, type ControlPlaneHandle } from './index.js';

const developerActor = {
  kind: 'user',
  userId: 'user-xujiequan',
  accountType: 'DEVELOPER',
} as const;
const testerActor = {
  kind: 'user',
  userId: 'user-tianguohui',
  accountType: 'TESTER',
} as const;

interface Fixture {
  home: string;
  handle: ControlPlaneHandle;
  developer: HttpControlPlaneAdapter;
  tester: HttpControlPlaneAdapter;
  system: HttpControlPlaneAdapter;
  projectId: string;
  runnerIds: [string, string];
  items: Array<{
    engineeringId: string;
    bindingId: string;
    environmentId: string;
    runnerId: string;
  }>;
  advance(ms: number): void;
}

describe('collaborative test submission workflow', () => {
  let fixture: Fixture | null = null;

  afterEach(async () => {
    await fixture?.handle.close();
    if (fixture?.home) await rm(fixture.home, { recursive: true, force: true });
    fixture = null;
  });

  test('creates submissions, shares test targets, and isolates tester technical data', async () => {
    fixture = await createFixture();
    const submission = await createSubmission(fixture);
    expect(submission.items).toHaveLength(2);
    expect(submission.items.map((item) => item.engineeringType).sort()).toEqual(
      ['BACKEND', 'FRONTEND'],
    );
    expect(submission.items[0]!.technical?.targetBranch).toBe('main');

    const testerList = await fixture.tester.collaborativeQuery({
      kind: 'submission.list',
      projectId: fixture.projectId,
      includeClosed: true,
    });
    expect(testerList.submissions).toHaveLength(1);
    const testerDetail = await fixture.tester.collaborativeQuery({
      kind: 'submission.get',
      submissionId: submission.id,
    });
    expect(
      testerDetail.submission?.items.every((item) => item.technical === null),
    ).toBe(true);
    expect(
      testerDetail.submission?.items.map((item) => item.testTarget),
    ).toEqual([
      {
        targetBranch: 'main',
        environment: { slug: 'test', displayName: '测试环境' },
      },
      {
        targetBranch: 'main',
        environment: { slug: 'test', displayName: '测试环境' },
      },
    ]);

    await expect(createSubmission(fixture, 'conflict')).rejects.toBeInstanceOf(
      ControlPlaneClientError,
    );
  });

  test('updates engineering environments that are referenced by an active submission', async () => {
    fixture = await createFixture();
    await createSubmission(fixture);
    const engineering = await fixture.developer.getEngineering(
      fixture.items[0]!.engineeringId,
    );

    const updated = await fixture.developer.updateEngineering(
      {
        engineeringId: engineering.id,
        slug: engineering.slug,
        displayName: engineering.displayName,
        type: engineering.type,
        repositoryUrl: engineering.repositoryUrl,
        ownerUserId: 'user-xujiequan',
        memberUserIds: [],
        environments: [
          ...engineering.environments.map((environment) => ({
            id: environment.id,
            slug: environment.slug,
            displayName: environment.displayName,
            deploymentType: environment.deploymentType,
            localScriptCommand: environment.localScriptCommand,
          })),
          {
            slug: 'develop',
            displayName: '开发环境',
            deploymentType: 'LOCAL_SCRIPT',
            localScriptCommand: 'bun run deploy:develop',
          },
        ],
      },
      crypto.randomUUID(),
    );

    expect(updated.environments).toHaveLength(2);
    expect(updated.environments.find((item) => item.slug === 'test')?.id).toBe(
      fixture.items[0]!.environmentId,
    );
    expect(
      updated.environments.find((item) => item.slug === 'develop'),
    ).toMatchObject({
      displayName: '开发环境',
      localScriptCommand: 'bun run deploy:develop',
    });
  });

  test('accepts bug intake and assignment while enforcing the six-state board', async () => {
    fixture = await createFixture();
    const submission = await createSubmission(fixture);
    const attachment = Buffer.from('screen');
    const created = await fixture.tester.collaborativeCommand({
      kind: 'bug.create',
      submissionId: submission.id,
      submissionItemId: null,
      title: '支付后状态错误',
      operationPath: '订单 → 支付',
      actualResult: '仍为待付款',
      expectedResult: '显示已付款',
      attachments: [
        {
          fileName: 'screen.txt',
          mediaType: 'text/plain',
          sizeBytes: attachment.byteLength,
          contentBase64: attachment.toString('base64'),
        },
      ],
    });
    expect(created.bug?.status).toBe('WAITING_FOR_REPAIR');
    await expect(
      fixture.tester.collaborativeCommand({
        kind: 'repair_task.enqueue',
        bugId: created.bug!.id,
        feedback: null,
        insertAtFront: false,
      }),
    ).rejects.toMatchObject({
      appError: { code: 'bug.transition_invalid' },
    });

    const triaged = await fixture.developer.collaborativeCommand({
      kind: 'bug.assign',
      bugId: created.bug!.id,
      engineeringType: 'FRONTEND',
      submissionItemId: submissionItem(fixture, submission, 0).id,
    });
    expect(triaged.bug?.submissionItemId).toBe(
      submissionItem(fixture, submission, 0).id,
    );
    const repairing = await fixture.tester.collaborativeCommand({
      kind: 'repair_task.enqueue',
      bugId: created.bug!.id,
      feedback: null,
      insertAtFront: false,
    });
    expect(repairing.bug?.status).toBe('REPAIRING');

    await expect(
      fixture.developer.collaborativeCommand({
        kind: 'submission.item.update',
        submissionItemId: submissionItem(fixture, submission, 0).id,
        responsibleDeveloperUserId: 'user-xujiequan',
        bindingId: fixture.items[0]!.bindingId,
        targetBranch: 'release',
        environmentId: fixture.items[0]!.environmentId,
      }),
    ).rejects.toMatchObject({
      appError: { code: 'store.constraint_conflict' },
    });

    const board = await fixture.tester.collaborativeQuery({
      kind: 'bug.board',
      submissionId: submission.id,
    });
    expect(board.bugs?.map((bug) => bug.status)).toEqual(['REPAIRING']);
    const attachmentResult = await fixture.tester.collaborativeQuery({
      kind: 'bug.attachment.get',
      attachmentId: created.bug!.attachments[0]!.id,
    });
    expect(attachmentResult.contentBase64).toBe(attachment.toString('base64'));
  });

  test('accepts a collaborative bug with only a title', async () => {
    fixture = await createFixture();
    const submission = await createSubmission(fixture);
    const result = await fixture.tester.collaborativeCommand({
      kind: 'bug.create',
      submissionId: submission.id,
      submissionItemId: null,
      title: '只有标题也可以登记',
    });
    expect(result.bug).toBeDefined();
    for (const field of [
      'operationPath',
      'actualResult',
      'expectedResult',
      'supplementalDescription',
    ] as const)
      expect(result.bug).not.toHaveProperty(field);
  });

  test('keeps an enqueued Bug repairing while claim only adds a lease', async () => {
    fixture = await createFixture();
    const submission = await createSubmission(fixture);
    const bug = await createBug(fixture, submission, 0, '准备阶段失败');
    await moveToRepair(fixture, bug.id);

    const claimed = await tryClaimRepair(fixture, 0);
    expect(claimed).not.toBeNull();
    expect(claimed?.startedAt).toBeNull();
    expect((await getBug(fixture, bug.id)).status).toBe('REPAIRING');
    expect((await getBug(fixture, bug.id)).repairActivity).toBe('PREPARING');

    const preparationFailed = await fixture.system.collaborativeCommand({
      kind: 'repair_task.fail_start',
      taskId: claimed!.id,
      runnerId: claimed!.runnerId,
      leaseToken: claimed!.leaseToken!,
      summary: 'Bug 协议解析失败',
    });
    expect(preparationFailed.bug?.status).toBe('WAITING_FOR_REPAIR');
    expect(preparationFailed.bug?.repairRecords).toEqual([
      expect.objectContaining({
        phase: 'STARTUP',
        outcome: 'FAILED',
        summary: 'Bug 协议解析失败',
      }),
    ]);
    const testerFailureView = await fixture.tester.collaborativeQuery({
      kind: 'bug.get',
      bugId: bug.id,
    });
    expect(testerFailureView.bug?.latestRepairFailed).toBe(true);
    expect(testerFailureView.bug?.repairRecords).toEqual([]);

    expect(await tryClaimRepair(fixture, 0)).toBeNull();
    await moveToRepair(fixture, bug.id);
    const retry = await tryClaimRepair(fixture, 0);
    expect(retry).not.toBeNull();
    expect((await getBug(fixture, bug.id)).status).toBe('REPAIRING');
    const started = await fixture.system.collaborativeCommand({
      kind: 'repair_task.start',
      taskId: retry!.id,
      runnerId: retry!.runnerId,
      leaseToken: retry!.leaseToken!,
    });
    expect(started.repairTask?.startedAt).not.toBeNull();
    expect((await getBug(fixture, bug.id)).status).toBe('REPAIRING');
    const executionFailed = await finishRepair(fixture, retry!, {
      sessionId: 'repair-session-after-start',
      outcome: 'INFRASTRUCTURE_ERROR',
      summary: 'Codex 请求过于频繁',
      candidateCommit: null,
    });
    expect(executionFailed.status).toBe('WAITING_FOR_REPAIR');
    expect(executionFailed.repairRecords.map((record) => record.phase)).toEqual(
      ['STARTUP', 'EXECUTION'],
    );
  });

  test('serializes each binding repair queue while supporting resume, leases, reassignment, and idempotent completion', async () => {
    fixture = await createFixture();
    const submission = await createSubmission(fixture);
    const first = await createBug(fixture, submission, 0, '前端金额错误');
    const second = await createBug(fixture, submission, 0, '前端按钮失效');
    const backend = await createBug(fixture, submission, 1, '后端状态未更新');
    await moveToRepair(fixture, first.id);
    await moveToRepair(fixture, second.id);
    await moveToRepair(fixture, backend.id);

    await fixture.developer.collaborativeCommand({
      kind: 'repair_queue.reorder',
      submissionItemId: submissionItem(fixture, submission, 0).id,
      bugIds: [second.id, first.id],
    });
    const firstClaim = await claimRepair(fixture, 0, 1_000);
    const backendClaim = await claimRepair(fixture, 1);
    expect(firstClaim.bugId).toBe(second.id);
    expect(backendClaim.bugId).toBe(backend.id);
    expect(await tryClaimRepair(fixture, 0)).toBeNull();

    await expect(
      fixture.tester.collaborativeCommand({
        kind: 'repair_task.withdraw',
        bugId: second.id,
      }),
    ).rejects.toMatchObject({
      appError: { code: 'bug.transition_invalid' },
    });
    await expect(
      fixture.developer.collaborativeCommand({
        kind: 'repair_queue.reorder',
        submissionItemId: submissionItem(fixture, submission, 0).id,
        bugIds: [second.id, first.id],
      }),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);

    const failed = await finishRepair(fixture, firstClaim, {
      sessionId: 'repair-session-1',
      outcome: 'FAILED',
      summary: '需要补充支付渠道信息',
      candidateCommit: null,
    });
    expect(failed.status).toBe('WAITING_FOR_REPAIR');
    await moveToRepair(fixture, second.id);
    await fixture.developer.collaborativeCommand({
      kind: 'repair_queue.reorder',
      submissionItemId: submissionItem(fixture, submission, 0).id,
      bugIds: [second.id, first.id],
    });
    const resumed = await claimRepair(fixture, 0, 1_000);
    expect(resumed.resumeSessionId).toBe('repair-session-1');

    fixture.advance(1_001);
    expect(await tryClaimRepair(fixture, 1)).toBeNull();
    const recovered = await claimRepair(fixture, 0, 1_000);
    expect(recovered.id).toBe(resumed.id);
    expect(recovered.leaseToken).not.toBe(resumed.leaseToken);
    const ready = await finishRepair(fixture, recovered, {
      sessionId: 'repair-session-1',
      outcome: 'READY',
      summary: '已修复',
      candidateCommit: 'abc123',
    });
    expect(ready.status).toBe('WAITING_FOR_UPDATE');
    const duplicate = await finishRepair(fixture, recovered, {
      sessionId: 'repair-session-1',
      outcome: 'READY',
      summary: '已修复',
      candidateCommit: 'abc123',
    });
    expect(duplicate.status).toBe('WAITING_FOR_UPDATE');

    await finishRepair(fixture, backendClaim, {
      sessionId: 'backend-session',
      outcome: 'FAILED',
      summary: '需改派工程',
      candidateCommit: null,
    });
    const reassigned = await fixture.developer.collaborativeCommand({
      kind: 'bug.assign',
      bugId: backend.id,
      engineeringType: 'FRONTEND',
      submissionItemId: submissionItem(fixture, submission, 0).id,
    });
    expect(reassigned.bug?.repairSessionId).toBeNull();
    await moveToRepair(fixture, backend.id);
    const reassignedQueue = await fixture.developer.collaborativeQuery({
      kind: 'repair_queue.get',
      submissionItemId: submissionItem(fixture, submission, 0).id,
    });
    expect(
      reassignedQueue.repairTasks?.every(
        (task) =>
          task.leaseToken === null &&
          task.leaseExpiresAt === null &&
          task.resumeSessionId === null &&
          task.failureSummary === null,
      ),
    ).toBe(true);
    expect(
      reassignedQueue.repairTasks?.find((task) => task.bugId === backend.id)
        ?.resumeSessionId,
    ).toBeNull();
  });

  test('freezes the waiting list after two quiet minutes and starts a new batch for later candidates', async () => {
    fixture = await createFixture();
    const submission = await createSubmission(fixture);
    const item = submissionItem(fixture, submission, 0);
    const first = await createBug(fixture, submission, 0, '首个候选');
    await moveToRepair(fixture, first.id);
    const firstRepair = await claimRepair(fixture, 0);
    expect(
      (
        await finishRepair(fixture, firstRepair, {
          sessionId: 'repair-first',
          outcome: 'READY',
          summary: '首个候选已提交',
          candidateCommit: 'local-commit-1',
        })
      ).status,
    ).toBe('WAITING_FOR_UPDATE');

    fixture.advance(119_999);
    expect(await tryClaimUpdate(fixture, 0)).toBeNull();
    fixture.advance(1);
    await fixture.system.heartbeatRunner(fixture.runnerIds[0]);
    const firstBatch = await claimUpdate(fixture, 0);
    expect(firstBatch.bugIds).toEqual([first.id]);
    expect(firstBatch.candidateCommits).toEqual(['local-commit-1']);
    expect((await getBug(fixture, first.id)).status).toBe('UPDATING');
    await fixture.system.collaborativeCommand({
      kind: 'update_task.finish',
      batchId: firstBatch.id,
      runnerId: fixture.runnerIds[0],
      leaseToken: firstBatch.leaseToken!,
      sessionId: 'update-first',
      outcome: 'COMPLETED',
      summary: '首批本地更新完成',
    });

    const second = await createBug(fixture, submission, 0, '第二候选');
    await moveToRepair(fixture, second.id);
    const secondRepair = await claimRepair(fixture, 0);
    await finishRepair(fixture, secondRepair, {
      sessionId: 'repair-second',
      outcome: 'READY',
      summary: '第二候选已提交',
      candidateCommit: 'local-commit-2',
    });
    fixture.advance(60_000);
    const third = await createBug(fixture, submission, 0, '第三候选');
    await moveToRepair(fixture, third.id);
    const thirdRepair = await claimRepair(fixture, 0);
    await finishRepair(fixture, thirdRepair, {
      sessionId: 'repair-third',
      outcome: 'READY',
      summary: '第三候选已提交',
      candidateCommit: 'local-commit-3',
    });

    fixture.advance(119_999);
    expect(await tryClaimUpdate(fixture, 0)).toBeNull();
    fixture.advance(1);
    await fixture.system.heartbeatRunner(fixture.runnerIds[0]);
    const secondBatch = await claimUpdate(fixture, 0);
    expect(secondBatch.id).not.toBe(firstBatch.id);
    expect(secondBatch.bugIds).toEqual([second.id, third.id]);
    expect(secondBatch.candidateCommits).toEqual([
      'local-commit-2',
      'local-commit-3',
    ]);

    const testerBatches = await fixture.tester.collaborativeQuery({
      kind: 'update_batches.list',
      submissionItemId: item.id,
    });
    expect(testerBatches.updateBatches?.[0]?.candidateCommits).toEqual([]);
    expect(testerBatches.updateBatches?.[0]?.sessionId).toBeNull();
  });

  test('responsible developer can freeze the current waiting list immediately', async () => {
    fixture = await createFixture();
    const submission = await createSubmission(fixture);
    const item = submissionItem(fixture, submission, 0);
    const candidate = await createBug(fixture, submission, 0, '立即更新候选');
    await moveToRepair(fixture, candidate.id);
    const repair = await claimRepair(fixture, 0);
    await finishRepair(fixture, repair, {
      sessionId: 'repair-immediate',
      outcome: 'READY',
      summary: '候选已提交',
      candidateCommit: 'immediate-commit',
    });

    await expect(
      fixture.tester.collaborativeCommand({
        kind: 'update.trigger',
        submissionItemId: item.id,
      }),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);
    const frozen = await fixture.developer.collaborativeCommand({
      kind: 'update.trigger',
      submissionItemId: item.id,
    });
    expect(frozen.updateBatch?.bugIds).toEqual([candidate.id]);
    expect(frozen.updateBatch?.immediateRequestedAt).not.toBeNull();
    expect((await claimUpdate(fixture, 0)).id).toBe(frozen.updateBatch!.id);
  });

  test('keeps failed update batches stopped until the responsible developer continues the original thread', async () => {
    fixture = await createFixture();
    const submission = await createSubmission(fixture);
    const item = submissionItem(fixture, submission, 0);
    const bug = await createBug(fixture, submission, 0, '原批次继续');
    await moveToRepair(fixture, bug.id);
    const repair = await claimRepair(fixture, 0);
    await finishRepair(fixture, repair, {
      sessionId: 'repair-before-failed-update',
      outcome: 'READY',
      summary: '候选已提交',
      candidateCommit: 'failed-update-commit',
    });
    const frozen = await fixture.developer.collaborativeCommand({
      kind: 'update.trigger',
      submissionItemId: item.id,
    });
    const running = await claimUpdate(fixture, 0);
    const failed = await fixture.system.collaborativeCommand({
      kind: 'update_task.finish',
      batchId: running.id,
      runnerId: fixture.runnerIds[0],
      leaseToken: running.leaseToken!,
      sessionId: 'update-thread-original',
      outcome: 'FAILED',
      summary: '集成验证失败，等待负责人继续',
    });
    expect(failed.updateBatch?.state).toBe('FAILED');
    expect(failed.updateBatch?.id).toBe(frozen.updateBatch?.id);
    expect(failed.updateBatch?.sessionId).toBe('update-thread-original');
    expect(await tryClaimUpdate(fixture, 0)).toBeNull();

    await expect(
      fixture.tester.collaborativeCommand({
        kind: 'update.continue',
        batchId: running.id,
        feedback: '继续处理',
      }),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);

    const continued = await fixture.developer.collaborativeCommand({
      kind: 'update.continue',
      batchId: running.id,
      feedback: '已确认，请在原 Thread 继续',
    });
    expect(continued.updateBatch?.state).toBe('QUEUED');
    expect(continued.updateBatch?.id).toBe(running.id);
    expect(continued.updateBatch?.sessionId).toBe('update-thread-original');
    expect(continued.updateBatch?.bugIds).toEqual([bug.id]);
    expect(continued.updateBatch?.candidateCommits).toEqual([
      'failed-update-commit',
    ]);

    const resumed = await claimUpdate(fixture, 0);
    expect(resumed.id).toBe(running.id);
    expect(resumed.sessionId).toBe('update-thread-original');
    expect(resumed.externalFailure).toBe('已确认，请在原 Thread 继续');
  });

  test('native Codex interactions are visible but only the responsible developer can resolve them', async () => {
    fixture = await createFixture();
    const submission = await createSubmission(fixture);
    const item = submissionItem(fixture, submission, 0);
    const first = await createBug(fixture, submission, 0, '等待权限的修复');
    const second = await createBug(fixture, submission, 0, '后续修复');
    await moveToRepair(fixture, first.id);
    await moveToRepair(fixture, second.id);
    const running = await claimRepair(fixture, 0);
    const opened = await fixture.system.collaborativeCommand({
      kind: 'interaction.open',
      executionKind: 'REPAIR',
      executionId: running.id,
      submissionItemId: item.id,
      bindingId: running.bindingId,
      interactionKind: 'PERMISSION',
      method: 'item/commandExecution/requestApproval',
      threadId: 'thread-repair',
      turnId: 'turn-repair',
      itemId: 'command-1',
      payload: { command: 'bun test' },
    });
    expect(opened.interaction?.state).toBe('PENDING');
    expect((await claimRepair(fixture, 0)).bugId).toBe(second.id);

    await expect(
      fixture.tester.collaborativeQuery({
        kind: 'interactions.list',
        submissionItemId: item.id,
        pendingOnly: true,
      }),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);
    const testerBug = await fixture.tester.collaborativeQuery({
      kind: 'bug.get',
      bugId: first.id,
    });
    expect(testerBug.bug?.repairActivity).toBe('WAITING_INTERACTION');
    expect(testerBug.bug?.repairRecords).toEqual([]);
    await expect(
      fixture.tester.collaborativeCommand({
        kind: 'interaction.resolve',
        interactionId: opened.interaction!.id,
        action: 'DECLINE',
      }),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);
    const before = (await getBug(fixture, first.id)).latestFeedback;
    const resolved = await fixture.developer.collaborativeCommand({
      kind: 'interaction.resolve',
      interactionId: opened.interaction!.id,
      action: 'ACCEPT_FOR_SESSION',
    });
    expect(resolved.interaction?.resolution).toEqual({
      action: 'ACCEPT_FOR_SESSION',
    });
    expect((await getBug(fixture, first.id)).latestFeedback).toBe(before);

    const pendingInput = await fixture.system.collaborativeCommand({
      kind: 'interaction.open',
      executionKind: 'REPAIR',
      executionId: running.id,
      submissionItemId: item.id,
      bindingId: running.bindingId,
      interactionKind: 'USER_INPUT',
      method: 'item/tool/requestUserInput',
      threadId: 'thread-repair',
      turnId: 'turn-repair',
      itemId: 'question-1',
      payload: {
        questions: [
          {
            id: 'answer',
            question: '请选择继续方式',
            options: [{ label: '继续', description: '继续原任务' }],
          },
        ],
      },
    });
    const invalidated = await fixture.system.collaborativeCommand({
      kind: 'interaction.invalidate',
      executionKind: 'REPAIR',
      executionId: running.id,
    });
    expect(invalidated.interaction?.id).toBe(pendingInput.interaction?.id);
    expect(invalidated.interaction?.state).toBe('INVALIDATED');
    const lateAnswer = await fixture.developer.collaborativeCommand({
      kind: 'interaction.resolve',
      interactionId: pendingInput.interaction!.id,
      action: 'ANSWER',
      answers: { answer: ['继续'] },
    });
    expect(lateAnswer.interaction?.state).toBe('INVALIDATED');
    expect(lateAnswer.interaction?.resolution).toBeNull();
  });

  test('recovers CI/CD update sessions from external failure and keeps tester details private', async () => {
    fixture = await createFixture();
    const submission = await createSubmission(fixture);
    const bug = await createBug(fixture, submission, 1, 'CI 状态异常');
    await moveToRepair(fixture, bug.id);
    const repair = await claimRepair(fixture, 1);
    await finishRepair(fixture, repair, {
      sessionId: 'repair-ci',
      outcome: 'READY',
      summary: '后端候选已提交',
      candidateCommit: 'ci-commit-1',
    });
    await fixture.developer.collaborativeCommand({
      kind: 'update.trigger',
      submissionItemId: submissionItem(fixture, submission, 1).id,
    });
    const update = await claimUpdate(fixture, 1);
    const waiting = await fixture.system.collaborativeCommand({
      kind: 'update_task.finish',
      batchId: update.id,
      runnerId: fixture.runnerIds[1],
      leaseToken: update.leaseToken!,
      sessionId: 'update-ci',
      outcome: 'PUSHED',
      summary: '已 Push，等待 CI/CD',
    });
    expect(waiting.updateBatch?.state).toBe('WAITING_EXTERNAL');

    await expect(
      fixture.tester.collaborativeCommand({
        kind: 'update.external_failure',
        batchId: update.id,
        feedback: '部署失败',
        attachments: [],
      }),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);
    const log = Buffer.from('pipeline failed');
    const failed = await fixture.developer.collaborativeCommand({
      kind: 'update.external_failure',
      batchId: update.id,
      feedback: '数据库迁移步骤失败',
      attachments: [
        {
          fileName: 'pipeline.log',
          mediaType: 'text/plain',
          sizeBytes: log.byteLength,
          contentBase64: log.toString('base64'),
        },
      ],
    });
    expect(failed.updateBatch?.state).toBe('QUEUED');
    const recovered = await claimUpdate(fixture, 1);
    expect(recovered.sessionId).toBe('update-ci');
    expect(recovered.externalFailure).toBe('数据库迁移步骤失败');
    expect(recovered.externalFailureAttachments[0]?.contentBase64).toBe(
      log.toString('base64'),
    );

    const testerView = await fixture.tester.collaborativeQuery({
      kind: 'update_batches.list',
      submissionItemId: submissionItem(fixture, submission, 1).id,
    });
    expect(testerView.updateBatches?.[0]?.externalFailure).toBeNull();
    expect(testerView.updateBatches?.[0]?.externalFailureAttachments).toEqual(
      [],
    );

    await fixture.system.collaborativeCommand({
      kind: 'update_task.finish',
      batchId: recovered.id,
      runnerId: fixture.runnerIds[1],
      leaseToken: recovered.leaseToken!,
      sessionId: 'update-ci',
      outcome: 'PUSHED',
      summary: '修复后重新 Push',
    });
    const confirmed = await fixture.developer.collaborativeCommand({
      kind: 'update.external_confirm',
      batchId: recovered.id,
    });
    expect(confirmed.updateBatch?.state).toBe('COMPLETED');
    expect((await getBug(fixture, bug.id)).status).toBe(
      'WAITING_FOR_VERIFICATION',
    );
    expect(
      (
        await fixture.developer.collaborativeCommand({
          kind: 'update.external_confirm',
          batchId: recovered.id,
        })
      ).updateBatch?.state,
    ).toBe('COMPLETED');
    expect(
      (
        await fixture.system.collaborativeCommand({
          kind: 'update_task.finish',
          batchId: recovered.id,
          runnerId: fixture.runnerIds[1],
          leaseToken: recovered.leaseToken!,
          sessionId: 'update-ci',
          outcome: 'PUSHED',
          summary: '迟到结果',
        })
      ).updateBatch?.state,
    ).toBe('COMPLETED');
  });

  test('requires tester verification before closing, releases environments, and retries cleanup without reopening', async () => {
    fixture = await createFixture();
    const submission = await createSubmission(fixture);
    const bug = await createBug(fixture, submission, 0, '验证闭环');
    await moveToRepair(fixture, bug.id);
    const repair = await claimRepair(fixture, 0);
    await finishRepair(fixture, repair, {
      sessionId: 'repair-close',
      outcome: 'READY',
      summary: '修复完成',
      candidateCommit: 'close-commit',
    });
    await fixture.developer.collaborativeCommand({
      kind: 'update.trigger',
      submissionItemId: submissionItem(fixture, submission, 0).id,
    });
    const update = await claimUpdate(fixture, 0);
    await fixture.system.collaborativeCommand({
      kind: 'update_task.finish',
      batchId: update.id,
      runnerId: fixture.runnerIds[0],
      leaseToken: update.leaseToken!,
      sessionId: 'update-close',
      outcome: 'COMPLETED',
      summary: '更新完成',
    });

    await expect(
      fixture.tester.collaborativeCommand({
        kind: 'repair_task.withdraw',
        bugId: bug.id,
      }),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);
    await expect(
      fixture.developer.collaborativeCommand({
        kind: 'bug.move',
        bugId: bug.id,
        targetStatus: 'DONE',
      }),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);
    await fixture.tester.collaborativeCommand({
      kind: 'bug.move',
      bugId: bug.id,
      targetStatus: 'DONE',
    });
    await expect(
      fixture.developer.collaborativeCommand({
        kind: 'submission.close',
        submissionId: submission.id,
      }),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);

    const closed = await fixture.tester.collaborativeCommand({
      kind: 'submission.close',
      submissionId: submission.id,
    });
    expect(closed.submission?.status).toBe('CLOSED');
    const replacement = await createSubmission(fixture, 'replacement');
    expect(replacement.status).toBe('ACTIVE');

    const cleanup = await claimCleanup(fixture, 0, 1_000);
    const failed = await fixture.system.collaborativeCommand({
      kind: 'cleanup_task.finish',
      taskId: cleanup.id,
      runnerId: fixture.runnerIds[0],
      leaseToken: cleanup.leaseToken!,
      success: false,
      summary: '临时目录占用，稍后重试',
    });
    expect(failed.cleanupTask?.state).toBe('FAILED');
    expect(
      (
        await fixture.tester.collaborativeQuery({
          kind: 'submission.get',
          submissionId: submission.id,
        })
      ).submission?.status,
    ).toBe('CLOSED');

    const retried = await claimCleanup(fixture, 0, 1_000);
    expect(retried.id).toBe(cleanup.id);
    expect(retried.retryCount).toBe(1);
    const completed = await fixture.system.collaborativeCommand({
      kind: 'cleanup_task.finish',
      taskId: retried.id,
      runnerId: fixture.runnerIds[0],
      leaseToken: retried.leaseToken!,
      success: true,
      summary: '系统临时资源已清理',
    });
    expect(completed.cleanupTask?.state).toBe('COMPLETED');
    expect(
      (
        await fixture.system.collaborativeCommand({
          kind: 'cleanup_task.finish',
          taskId: retried.id,
          runnerId: fixture.runnerIds[0],
          leaseToken: retried.leaseToken!,
          success: true,
          summary: '重复完成',
        })
      ).cleanupTask?.state,
    ).toBe('COMPLETED');
  });
});

async function createFixture(): Promise<Fixture> {
  let nowMs = Date.parse('2026-07-22T00:00:00.000Z');
  const home = await mkdtemp(join(tmpdir(), 'apt-collaborative-'));
  const handle = await startControlPlane({
    homeDirectory: home,
    port: 0,
    runnerOfflineAfterMs: 60_000,
    collaborativeAutomaticUpdateDelayMs: 120_000,
    now: () => new Date(nowMs),
  });
  const developer = new HttpControlPlaneAdapter({
    baseUrl: handle.address(),
    actor: developerActor,
  });
  const tester = new HttpControlPlaneAdapter({
    baseUrl: handle.address(),
    actor: testerActor,
  });
  const system = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
  const project = await developer.createProject(
    {
      slug: `collab-${crypto.randomUUID().slice(0, 8)}`,
      title: '协作提测',
    },
    crypto.randomUUID(),
  );
  const runnerIds = [crypto.randomUUID(), crypto.randomUUID()] as [
    string,
    string,
  ];
  await system.registerRunner({
    runnerId: runnerIds[0],
    name: 'Frontend Runner',
  });
  await system.registerRunner({
    runnerId: runnerIds[1],
    name: 'Backend Runner',
  });
  const engineeringInputs = [
    {
      slug: 'web',
      displayName: 'Web',
      type: 'FRONTEND' as const,
      deploymentType: 'LOCAL_SCRIPT' as const,
    },
    {
      slug: 'api',
      displayName: 'API',
      type: 'BACKEND' as const,
      deploymentType: 'CI_CD' as const,
    },
  ];
  const items: Fixture['items'] = [];
  for (const [index, input] of engineeringInputs.entries()) {
    const engineering = await developer.createEngineering(
      {
        projectId: project.id,
        slug: input.slug,
        displayName: input.displayName,
        type: input.type,
        repositoryUrl: `https://git.example.com/${input.slug}.git`,
        ownerUserId: 'user-xujiequan',
        memberUserIds: [],
        environments: [
          {
            slug: 'test',
            displayName: '测试环境',
            deploymentType: input.deploymentType,
            localScriptCommand:
              input.deploymentType === 'LOCAL_SCRIPT'
                ? 'bun run deploy:test'
                : null,
          },
        ],
      },
      crypto.randomUUID(),
    );
    const ticket = await developer.createEngineeringBindingTicket(
      engineering.id,
    );
    const binding = await system.claimEngineeringBinding({
      ticket: ticket.ticket,
      runnerId: runnerIds[index]!,
      runnerName: index === 0 ? 'Frontend Runner' : 'Backend Runner',
    });
    items.push({
      engineeringId: engineering.id,
      bindingId: binding.id,
      environmentId: engineering.environments[0]!.id,
      runnerId: runnerIds[index]!,
    });
  }
  return {
    home,
    handle,
    developer,
    tester,
    system,
    projectId: project.id,
    runnerIds,
    items,
    advance(ms) {
      nowMs += ms;
    },
  };
}

async function createSubmission(fixture: Fixture, suffix = 'primary') {
  const result = await fixture.developer.collaborativeCommand({
    kind: 'submission.create',
    projectId: fixture.projectId,
    title: `支付功能提测-${suffix}`,
    requirementDescription: '覆盖前后端支付闭环',
    testerUserId: 'user-tianguohui',
    items: fixture.items.map((item) => ({
      engineeringId: item.engineeringId,
      responsibleDeveloperUserId: 'user-xujiequan',
      bindingId: item.bindingId,
      targetBranch: 'main',
      environmentId: item.environmentId,
    })),
  });
  return result.submission!;
}

function submissionItem(
  fixture: Fixture,
  submission: TestSubmissionDetail,
  itemIndex: number,
) {
  const engineeringId = fixture.items[itemIndex]!.engineeringId;
  const item = submission.items.find(
    (candidate) => candidate.engineeringId === engineeringId,
  );
  if (!item) throw new Error(`提测单缺少工程 ${engineeringId}`);
  return item;
}

async function createBug(
  fixture: Fixture,
  submission: TestSubmissionDetail,
  itemIndex: number,
  title: string,
): Promise<SubmissionBug> {
  const result = await fixture.tester.collaborativeCommand({
    kind: 'bug.create',
    submissionId: submission.id,
    submissionItemId: submissionItem(fixture, submission, itemIndex).id,
    title,
    operationPath: '订单 → 支付',
    actualResult: '实际结果不符合预期',
    expectedResult: '符合需求描述',
    attachments: [],
  });
  return result.bug!;
}

async function moveToRepair(
  fixture: Fixture,
  bugId: string,
  insertAtFront = false,
) {
  await fixture.tester.collaborativeCommand({
    kind: 'repair_task.enqueue',
    bugId,
    feedback: null,
    insertAtFront,
  });
}

async function tryClaimRepair(fixture: Fixture, itemIndex: number) {
  const result = await fixture.system.collaborativeCommand({
    kind: 'repair_task.claim',
    runnerId: fixture.runnerIds[itemIndex],
    leaseDurationMs: 60_000,
  });
  return result.repairTask ?? null;
}

async function claimRepair(
  fixture: Fixture,
  itemIndex: number,
  leaseDurationMs = 60_000,
): Promise<SubmissionRepairTask> {
  const result = await fixture.system.collaborativeCommand({
    kind: 'repair_task.claim',
    runnerId: fixture.runnerIds[itemIndex],
    leaseDurationMs,
  });
  expect(result.repairTask).not.toBeNull();
  const task = result.repairTask!;
  await fixture.system.collaborativeCommand({
    kind: 'repair_task.start',
    taskId: task.id,
    runnerId: task.runnerId,
    leaseToken: task.leaseToken!,
  });
  return task;
}

async function finishRepair(
  fixture: Fixture,
  task: SubmissionRepairTask,
  result: {
    sessionId: string | null;
    outcome:
      'READY' | 'NEEDS_INPUT' | 'BLOCKED' | 'FAILED' | 'INFRASTRUCTURE_ERROR';
    summary: string;
    candidateCommit: string | null;
  },
): Promise<SubmissionBug> {
  const response = await fixture.system.collaborativeCommand({
    kind: 'repair_task.finish',
    taskId: task.id,
    runnerId: task.runnerId,
    leaseToken: task.leaseToken!,
    ...result,
  });
  return response.bug!;
}

async function tryClaimUpdate(fixture: Fixture, itemIndex: number) {
  const result = await fixture.system.collaborativeCommand({
    kind: 'update_task.claim',
    runnerId: fixture.runnerIds[itemIndex],
    leaseDurationMs: 60_000,
  });
  return result.updateBatch ?? null;
}

async function claimUpdate(fixture: Fixture, itemIndex: number) {
  const batch = await tryClaimUpdate(fixture, itemIndex);
  expect(batch).not.toBeNull();
  return batch!;
}

async function claimCleanup(
  fixture: Fixture,
  itemIndex: number,
  leaseDurationMs = 60_000,
) {
  const result = await fixture.system.collaborativeCommand({
    kind: 'cleanup_task.claim',
    runnerId: fixture.runnerIds[itemIndex],
    leaseDurationMs,
  });
  expect(result.cleanupTask).not.toBeNull();
  return result.cleanupTask!;
}

async function getBug(fixture: Fixture, bugId: string) {
  const result = await fixture.developer.collaborativeQuery({
    kind: 'bug.get',
    bugId,
  });
  return result.bug!;
}
