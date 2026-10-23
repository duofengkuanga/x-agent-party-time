import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSubmissionWorkflow } from '@/server/runtime/createSubmissionWorkflow';
import { testDatabases } from '@/testing/database';
import {
  createSubmission,
  item,
  submissionFixture,
} from '../../../../../server/submissions/submissionFixture';
import { SubmissionRail } from './submissionRail';

const sourcePath = join(import.meta.dir, 'submissionDetails.tsx');
const setup = submissionFixture(testDatabases());

describe('提测信息编辑', () => {
  test('零缺陷负责人通过输入框和统一保存按钮修改目标分支', async () => {
    const source = await readFile(sourcePath, 'utf8');

    expect(source).toContain("item.availableActions.includes('EDIT_TARGET_BRANCH')");
    expect(source).toContain('className="collab-table-input"');
    expect(source).toContain('targetBranches,');
    expect(source).toContain('保存提测信息');
    expect(source).not.toContain('onBlur=');
  });
});

test('关闭按钮遵循服务端可用操作，并在提交过程中禁用', async () => {
  const f = await setup();
  const submission = createSubmission(f, [
    item(f, 'front', 'developerA', 'frontA', 'main'),
    item(f, 'back', 'developerB', 'backB', 'main'),
  ]);
  const snapshot = createSubmissionWorkflow(f.database).workspace.getWorkspace(
    f.users.tester.id,
    submission.id,
  );
  const noop = () => {};
  expect(snapshot.bugs).toHaveLength(0);
  expect(snapshot.submission.availableActions).toContain('CLOSE');
  for (const { allowed, updating } of [
    { allowed: true, updating: false },
    { allowed: true, updating: true },
    { allowed: false, updating: false },
  ]) {
    snapshot.submission.availableActions = allowed ? ['CLOSE'] : [];
    const html = renderToStaticMarkup(
      createElement(SubmissionRail, {
        collapsed: false,
        detailOpen: true,
        includeClosed: false,
        onBackToList: noop,
        onCloseSubmission: noop,
        onCreate: noop,
        onIncludeClosedChange: noop,
        onOpenDetails: noop,
        onRefresh: noop,
        onResolveCleanupInteraction: noop,
        onRetryCleanup: noop,
        onSelect: noop,
        onToggleCollapsed: noop,
        updateDetails: noop,
        selectedId: submission.id,
        snapshot,
        submissions: snapshot.submissions,
        syncState: 'connected',
        updating,
      }),
    );
    const button = html.match(/<button([^>]*)>关闭提测单<\/button>/u);
    expect(button).not.toBeNull();
    expect(button![1]!.includes('disabled')).toBe(!allowed || updating);
    if (!allowed) expect(html).toContain('修复与更新结束后可关闭');
  }
});
