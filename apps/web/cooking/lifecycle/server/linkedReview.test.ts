import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { mutation } from '@/cooking/testing/project';
import { testDatabases } from '@/testing/database';
import {
  completeNextRepair,
  completeUpdate,
  currentBug,
  latestBatch,
  lifecycleFixture,
} from './lifecycleFixture';

const setup = lifecycleFixture(testDatabases());

async function linkedReady() {
  const fixture = await setup();
  const created = fixture.bugs.createLinkedBugs(
    fixture.users.tester.id,
    fixture.submission.id,
    {
      mutationId: randomUUID(),
      submissionItemIds: [fixture.items[0]!.id, fixture.items[1]!.id],
      title: '前后端共同缺陷',
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
      startRepair: true,
    },
  );
  await completeNextRepair(fixture, 'linked-front', [
    '1111111111111111111111111111111111111111',
  ]);
  await completeNextRepair(fixture, 'linked-back', [
    '2222222222222222222222222222222222222222',
  ]);
  await completeUpdate(fixture, fixture.items[0]!.id, {
    outcome: 'COMPLETED',
    summary: '前端已部署',
  });
  return { fixture, bugs: created.bugs };
}

async function finishBackend(fixture: Awaited<ReturnType<typeof setup>>) {
  const batch = await completeUpdate(fixture, fixture.items[1]!.id, {
    outcome: 'PUSHED',
    summary: '后端已推送',
  });
  fixture.updates.reportExternalDeployment(fixture.users.developer.id, batch.id, {
    ...mutation(latestBatch(fixture.database, fixture.items[1]!.id).version),
    outcome: 'SUCCEEDED',
    summary: '后端已部署',
    attachmentIds: [],
  });
}

function versions(fixture: Awaited<ReturnType<typeof setup>>, ids: string[]) {
  return ids.map((id) => currentBug(fixture.database, id).version);
}

describe('前后端关联缺陷统一验收', () => {
  test('另一端尚未待验证时，单单验证被阻止；就绪后一次操作逐单通过且可重试', async () => {
    const { fixture, bugs } = await linkedReady();
    const [front, back] = bugs;
    expect(currentBug(fixture.database, front!.id).stage).toBe(
      'WAITING_FOR_VERIFICATION',
    );
    expect(currentBug(fixture.database, back!.id).stage).toBe('WAITING_FOR_UPDATE');
    expect(() =>
      fixture.lifecycle.verifyBug(fixture.users.tester.id, front!.id, {
        ...mutation(currentBug(fixture.database, front!.id).version),
        result: 'PASSED',
        attachmentIds: [],
      }),
    ).toThrow('关联的后端缺陷仍在待更新');
    expect(
      fixture.lifecycle.workspace(fixture.users.tester.id, fixture.submission.id)
        .verificationsByBug[front!.id],
    ).toEqual([]);

    await finishBackend(fixture);
    const [expectedVersion, relatedExpectedVersion] = versions(fixture, [
      front!.id,
      back!.id,
    ]);
    const input = {
      mutationId: randomUUID(),
      expectedVersion: expectedVersion!,
      relatedExpectedVersion: relatedExpectedVersion!,
      decision: 'PASSED' as const,
      attachmentIds: [],
    };
    const result = fixture.lifecycle.reviewLinkedBugs(
      fixture.users.tester.id,
      front!.id,
      input,
    );
    expect(
      fixture.lifecycle.reviewLinkedBugs(fixture.users.tester.id, front!.id, input),
    ).toEqual(result);
    expect(result.changedBugIds).toEqual([front!.id, back!.id]);
    expect(
      [front!.id, back!.id].map((id) => currentBug(fixture.database, id).stage),
    ).toEqual(['DONE', 'DONE']);
    const records = fixture.lifecycle.workspace(
      fixture.users.tester.id,
      fixture.submission.id,
    ).verificationsByBug;
    expect(records[front!.id]?.map(({ result }) => result)).toEqual(['PASSED']);
    expect(records[back!.id]?.map(({ result }) => result)).toEqual(['PASSED']);
  });

  test.each(['FRONTEND', 'BACKEND', 'BOTH'] as const)(
    '选择 %s 返修时只改变选中工程的 Bug',
    async (ownership) => {
      const { fixture, bugs } = await linkedReady();
      await finishBackend(fixture);
      const [front, back] = bugs;
      const [expectedVersion, relatedExpectedVersion] = versions(fixture, [
        front!.id,
        back!.id,
      ]);
      const result = fixture.lifecycle.reviewLinkedBugs(
        fixture.users.tester.id,
        front!.id,
        {
          mutationId: randomUUID(),
          expectedVersion: expectedVersion!,
          relatedExpectedVersion: relatedExpectedVersion!,
          decision: 'ISSUE',
          ownership,
          feedback: '联调后仍出现错误',
          attachmentIds: [],
        },
      );
      const changed = ownership === 'BOTH' ? 2 : 1;
      expect(result.changedBugIds).toHaveLength(changed);
      expect(result.executionIds).toHaveLength(changed);
      expect(currentBug(fixture.database, front!.id).stage).toBe(
        ownership === 'BACKEND' ? 'WAITING_FOR_VERIFICATION' : 'REPAIRING',
      );
      expect(currentBug(fixture.database, back!.id).stage).toBe(
        ownership === 'FRONTEND' ? 'WAITING_FOR_VERIFICATION' : 'REPAIRING',
      );
      const records = fixture.lifecycle.workspace(
        fixture.users.tester.id,
        fixture.submission.id,
      ).verificationsByBug;
      expect(records[front!.id]).toHaveLength(ownership === 'BACKEND' ? 0 : 1);
      expect(records[back!.id]).toHaveLength(ownership === 'FRONTEND' ? 0 : 1);
    },
  );

  test('一端已完成时，未选中的待验证单保持原状；另一端未就绪后不能单独重开', async () => {
    const { fixture, bugs } = await linkedReady();
    await finishBackend(fixture);
    const [front, back] = bugs;
    fixture.lifecycle.verifyBug(fixture.users.tester.id, front!.id, {
      ...mutation(currentBug(fixture.database, front!.id).version),
      result: 'PASSED',
      attachmentIds: [],
    });
    const [expectedVersion, relatedExpectedVersion] = versions(fixture, [
      front!.id,
      back!.id,
    ]);
    fixture.lifecycle.reviewLinkedBugs(fixture.users.tester.id, front!.id, {
      mutationId: randomUUID(),
      expectedVersion: expectedVersion!,
      relatedExpectedVersion: relatedExpectedVersion!,
      decision: 'ISSUE',
      ownership: 'FRONTEND',
      feedback: '前端回归失败',
      attachmentIds: [],
    });
    expect(currentBug(fixture.database, front!.id).stage).toBe('REPAIRING');
    expect(currentBug(fixture.database, back!.id).stage).toBe('WAITING_FOR_VERIFICATION');
    expect(() =>
      fixture.lifecycle.verifyBug(fixture.users.tester.id, back!.id, {
        ...mutation(currentBug(fixture.database, back!.id).version),
        result: 'PASSED',
        attachmentIds: [],
      }),
    ).toThrow('关联的前端缺陷仍在修复中');
  });

  test('已完成加待验证只通过待验证单；两端已完成后可重新选择双端重开', async () => {
    const { fixture, bugs } = await linkedReady();
    await finishBackend(fixture);
    const [front, back] = bugs;
    fixture.lifecycle.verifyBug(fixture.users.tester.id, front!.id, {
      ...mutation(currentBug(fixture.database, front!.id).version),
      result: 'PASSED',
      attachmentIds: [],
    });
    let [expectedVersion, relatedExpectedVersion] = versions(fixture, [
      front!.id,
      back!.id,
    ]);
    const passed = fixture.lifecycle.reviewLinkedBugs(
      fixture.users.tester.id,
      front!.id,
      {
        mutationId: randomUUID(),
        expectedVersion: expectedVersion!,
        relatedExpectedVersion: relatedExpectedVersion!,
        decision: 'PASSED',
        attachmentIds: [],
      },
    );
    expect(passed.changedBugIds).toEqual([back!.id]);
    const records = fixture.lifecycle.workspace(
      fixture.users.tester.id,
      fixture.submission.id,
    ).verificationsByBug;
    expect(records[front!.id]).toHaveLength(1);
    expect(records[back!.id]).toHaveLength(1);
    [expectedVersion, relatedExpectedVersion] = versions(fixture, [front!.id, back!.id]);
    const reopened = fixture.lifecycle.reviewLinkedBugs(
      fixture.users.tester.id,
      front!.id,
      {
        mutationId: randomUUID(),
        expectedVersion: expectedVersion!,
        relatedExpectedVersion: relatedExpectedVersion!,
        decision: 'ISSUE',
        ownership: 'BOTH',
        feedback: '完整回归时又出现',
        attachmentIds: [],
      },
    );
    expect(reopened.executionIds).toHaveLength(2);
    expect(
      [front!.id, back!.id].map((id) => currentBug(fixture.database, id).stage),
    ).toEqual(['REPAIRING', 'REPAIRING']);
    const reopens = fixture.lifecycle.workspace(
      fixture.users.tester.id,
      fixture.submission.id,
    ).reopensByBug;
    expect(reopens[front!.id]).toHaveLength(1);
    expect(reopens[back!.id]).toHaveLength(1);
  });

  test('关联操作第二张单写入失败时，第一张单及验证记录一同回滚', async () => {
    const { fixture, bugs } = await linkedReady();
    await finishBackend(fixture);
    const [front, back] = bugs;
    const [expectedVersion, relatedExpectedVersion] = versions(fixture, [
      front!.id,
      back!.id,
    ]);
    fixture.database.exec(
      `CREATE TRIGGER reject_linked_review BEFORE INSERT ON cooking_verification_record
       WHEN NEW.bug_id = '${back!.id}' BEGIN SELECT RAISE(ABORT, '模拟第二张单失败'); END`,
    );
    expect(() =>
      fixture.lifecycle.reviewLinkedBugs(fixture.users.tester.id, front!.id, {
        mutationId: randomUUID(),
        expectedVersion: expectedVersion!,
        relatedExpectedVersion: relatedExpectedVersion!,
        decision: 'PASSED',
        attachmentIds: [],
      }),
    ).toThrow('模拟第二张单失败');
    expect(
      [front!.id, back!.id].map((id) => currentBug(fixture.database, id).stage),
    ).toEqual(['WAITING_FOR_VERIFICATION', 'WAITING_FOR_VERIFICATION']);
    expect(fixture.database.all('SELECT id FROM cooking_verification_record')).toEqual(
      [],
    );
  });

  test('两端完成后统一归档和撤销归档，仍分别记录版本与审计', async () => {
    const { fixture, bugs } = await linkedReady();
    await finishBackend(fixture);
    const [front, back] = bugs;
    let [expectedVersion, relatedExpectedVersion] = versions(fixture, [
      front!.id,
      back!.id,
    ]);
    fixture.lifecycle.reviewLinkedBugs(fixture.users.tester.id, front!.id, {
      mutationId: randomUUID(),
      expectedVersion: expectedVersion!,
      relatedExpectedVersion: relatedExpectedVersion!,
      decision: 'PASSED',
      attachmentIds: [],
    });
    [expectedVersion, relatedExpectedVersion] = versions(fixture, [front!.id, back!.id]);
    const archiveInput = {
      mutationId: randomUUID(),
      expectedVersion: expectedVersion!,
      relatedExpectedVersion: relatedExpectedVersion!,
    };
    const archived = fixture.lifecycle.archiveLinkedBugs(
      fixture.users.tester.id,
      front!.id,
      archiveInput,
    );
    expect(
      fixture.lifecycle.archiveLinkedBugs(
        fixture.users.tester.id,
        front!.id,
        archiveInput,
      ),
    ).toEqual(archived);
    expect(archived.bugVersions).toEqual([
      expectedVersion! + 1,
      relatedExpectedVersion! + 1,
    ]);
    expect(
      [front!.id, back!.id].map((id) => currentBug(fixture.database, id).archived_at),
    ).toEqual(['2026-07-27T12:00:00.000Z', '2026-07-27T12:00:00.000Z']);
    fixture.lifecycle.unarchiveLinkedBugs(fixture.users.tester.id, front!.id, {
      mutationId: randomUUID(),
      expectedVersion: archived.bugVersions[0]!,
      relatedExpectedVersion: archived.bugVersions[1]!,
    });
    expect(
      [front!.id, back!.id].map((id) => currentBug(fixture.database, id).archived_at),
    ).toEqual([null, null]);
    const audits = fixture.database.all<{ action: string }>(
      "SELECT action FROM cooking_audit_event WHERE action IN ('BUG_ARCHIVED', 'BUG_UNARCHIVED')",
    );
    expect(audits.map(({ action }) => action).sort()).toEqual([
      'BUG_ARCHIVED',
      'BUG_ARCHIVED',
      'BUG_UNARCHIVED',
      'BUG_UNARCHIVED',
    ]);
  });

  test('另一端已归档时，单单验证提示先移出归档', async () => {
    const { fixture, bugs } = await linkedReady();
    await finishBackend(fixture);
    const [front, back] = bugs;
    fixture.lifecycle.verifyBug(fixture.users.tester.id, back!.id, {
      ...mutation(currentBug(fixture.database, back!.id).version),
      result: 'PASSED',
      attachmentIds: [],
    });
    fixture.lifecycle.archiveBug(fixture.users.tester.id, back!.id, {
      ...mutation(currentBug(fixture.database, back!.id).version),
    });
    expect(() =>
      fixture.lifecycle.verifyBug(fixture.users.tester.id, front!.id, {
        ...mutation(currentBug(fixture.database, front!.id).version),
        result: 'PASSED',
        attachmentIds: [],
      }),
    ).toThrow('关联的后端缺陷已归档，请先移出归档');
  });
});
