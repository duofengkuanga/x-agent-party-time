import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createSubmissionWorkflow } from '@/server/runtime/createSubmissionWorkflow';
import { testDatabases } from '@/testing/database';
import {
  createSubmission,
  item,
  submissionFixture,
} from '@/server/submissions/submissionFixture';
import { workspaceReducer } from './workspaceState';

const setup = submissionFixture(testDatabases());

test('清空选中项后，上一张单的延迟响应不能恢复旧看板', async () => {
  const f = await setup();
  const submission = createSubmission(f, [
    item(f, 'front', 'developerA', 'frontA', 'main'),
  ]);
  const workflow = createSubmissionWorkflow(f.database);
  workflow.lifecycle.closeSubmission(f.users.tester.id, submission.id, {
    mutationId: randomUUID(),
    expectedVersion: submission.version,
  });
  const previous = workflow.workspace.getWorkspace(f.users.tester.id, submission.id);
  const empty = {
    snapshot: null,
    submissions: previous.submissions,
    syncState: 'connected' as const,
  };
  expect(workspaceReducer(empty, { type: 'REPLACE_SNAPSHOT', snapshot: previous })).toBe(
    empty,
  );
});

test('同一张单的过期响应不能覆盖较新的任务状态', async () => {
  const f = await setup();
  const submission = createSubmission(f, [
    item(f, 'front', 'developerA', 'frontA', 'main'),
  ]);
  const previous = createSubmissionWorkflow(f.database).workspace.getWorkspace(
    f.users.tester.id,
    submission.id,
  );
  const current = { ...previous, revision: previous.revision + 1 };
  const state = {
    snapshot: current,
    submissions: current.submissions,
    syncState: 'connected' as const,
  };
  expect(workspaceReducer(state, { type: 'REPLACE_SNAPSHOT', snapshot: previous })).toBe(
    state,
  );
  const next = { ...current, revision: current.revision + 1 };
  expect(
    workspaceReducer(state, { type: 'REPLACE_SNAPSHOT', snapshot: next }).snapshot,
  ).toBe(next);
});

test('切换提测单后，上一张单的刷新和保存结果不影响当前看板', async () => {
  const f = await setup();
  const submission = createSubmission(f, [
    item(f, 'front', 'developerA', 'frontA', 'main'),
  ]);
  const previous = createSubmissionWorkflow(f.database).workspace.getWorkspace(
    f.users.tester.id,
    submission.id,
  );
  const current = {
    ...previous,
    submission: {
      ...previous.submission,
      submission: { ...previous.submission.submission, id: randomUUID() },
    },
  };
  const state = {
    snapshot: current,
    submissions: current.submissions,
    syncState: 'connected' as const,
  };
  expect(workspaceReducer(state, { type: 'REPLACE_SNAPSHOT', snapshot: previous })).toBe(
    state,
  );
  expect(
    workspaceReducer(state, {
      type: 'UPDATE_SUBMISSION',
      submission: { ...previous.submission.submission, title: '上一张单的新名称' },
    }).snapshot,
  ).toBe(current);
});
