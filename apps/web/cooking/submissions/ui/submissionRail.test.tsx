import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createCooking } from '@/cooking/runtime/createCooking';
import type { CookingWorkspaceSnapshot } from '../workspace';
import { testDatabases } from '@/testing/database';
import {
  createSubmission,
  item,
  submissionFixture,
} from '../server/submissionFixture';
import { SubmissionRail } from './submissionRail';

const setup = submissionFixture(testDatabases());

function renderRail(snapshot: CookingWorkspaceSnapshot, updating = false) {
  const noop = () => {};
  return renderToStaticMarkup(
    <SubmissionRail
      collapsed={false}
      detailOpen
      includeClosed={false}
      onBackToList={noop}
      onCloseSubmission={noop}
      onCreate={noop}
      onIncludeClosedChange={noop}
      onOpenDetails={noop}
      onRefresh={noop}
      onResolveCleanupInteraction={noop}
      onRetryCleanup={noop}
      onSelect={noop}
      onToggleCollapsed={noop}
      updateDetails={noop}
      selectedId={snapshot.submission.submission.id}
      snapshot={snapshot}
      submissions={snapshot.submissions}
      syncState="connected"
      updating={updating}
    />,
  );
}

test('即使没有未完成缺陷，服务端未提供 CLOSE 时关闭按钮仍禁用并说明条件', async () => {
  const f = await setup();
  const submission = createSubmission(f, [
    item(f, 'front', 'developerA', 'frontA', 'main'),
    item(f, 'back', 'developerB', 'backB', 'main'),
  ]);
  const snapshot = createCooking(f.database).workspace.getWorkspace(
    f.users.tester.id,
    submission.id,
  );
  expect(snapshot.bugs).toHaveLength(0);
  snapshot.submission.availableActions =
    snapshot.submission.availableActions.filter((action) => action !== 'CLOSE');
  const html = renderRail(snapshot);
  const button = html.match(/<button([^>]*)>关闭提测单<\/button>/u);
  expect(button).not.toBeNull();
  expect(button![1]).toContain('disabled');
  expect(html).toContain('修复与更新结束后可关闭');
});

test('服务端允许关闭时按钮可用，提交过程中禁用', async () => {
  const f = await setup();
  const submission = createSubmission(f, [
    item(f, 'front', 'developerA', 'frontA', 'main'),
    item(f, 'back', 'developerB', 'backB', 'main'),
  ]);
  const snapshot = createCooking(f.database).workspace.getWorkspace(
    f.users.tester.id,
    submission.id,
  );
  expect(snapshot.submission.availableActions).toContain('CLOSE');
  const ready = renderRail(snapshot).match(
    /<button([^>]*)>关闭提测单<\/button>/u,
  );
  const pending = renderRail(snapshot, true).match(
    /<button([^>]*)>关闭提测单<\/button>/u,
  );
  expect(ready).not.toBeNull();
  expect(ready![1]).not.toContain('disabled');
  expect(pending).not.toBeNull();
  expect(pending![1]).toContain('disabled');
});
