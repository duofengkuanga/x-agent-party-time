import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { testDatabases } from '@/testing/database';
import { bugFixture } from '../server/bug-fixture';
import { LinkedReviewCard } from './bug-card';
import {
  linkedReviewBlockedReason,
  linkedReviewPairFor,
} from './linked-review-model';

const setup = bugFixture(testDatabases());

test('测试视角在双方就绪后只显示一组通过和还有问题，未就绪时说明另一端进度', async () => {
  const fixture = await setup();
  const created = fixture.service.createLinkedBugs(
    fixture.users.tester.id,
    fixture.submission.id,
    {
      mutationId: randomUUID(),
      submissionItemIds: [fixture.items.front, fixture.items.back],
      title: '共同问题',
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
    },
  );
  const [front, back] = created.bugs;
  fixture.database.run(
    "UPDATE cooking_bug SET stage = 'WAITING_FOR_VERIFICATION' WHERE id = ?",
    front!.id,
  );
  fixture.database.run(
    "UPDATE cooking_bug SET stage = 'REPAIRING' WHERE id = ?",
    back!.id,
  );
  let bugs = fixture.service.workspace(
    fixture.users.tester.id,
    fixture.submission.id,
  ).bugs;
  let pair = linkedReviewPairFor(bugs[0]!, bugs)!;
  expect(pair.ready).toBe(false);
  expect(linkedReviewBlockedReason(bugs[0]!, pair)).toContain(
    '后端缺陷仍在修复中',
  );

  fixture.database.run(
    "UPDATE cooking_bug SET stage = 'DONE' WHERE id = ?",
    back!.id,
  );
  bugs = fixture.service.workspace(
    fixture.users.tester.id,
    fixture.submission.id,
  ).bugs;
  pair = linkedReviewPairFor(bugs[0]!, bugs)!;
  expect(pair.ready).toBe(true);
  expect(pair.column).toBe('WAITING_FOR_VERIFICATION');
  const html = renderToStaticMarkup(
    <LinkedReviewCard
      frontend={pair.frontend}
      backend={pair.backend}
      onArchive={() => {}}
      onOpen={() => {}}
      onIssue={() => {}}
      onVerifyPass={() => {}}
      pending={false}
    />,
  );
  expect(html).toContain('前端');
  expect(html).toContain('后端');
  expect(html.match(/>通过</g)).toHaveLength(1);
  expect(html.match(/>还有问题</g)).toHaveLength(1);
  expect(html).not.toContain('统一验收');

  fixture.database.run(
    "UPDATE cooking_bug SET stage = 'DONE' WHERE id = ?",
    front!.id,
  );
  bugs = fixture.service.workspace(
    fixture.users.tester.id,
    fixture.submission.id,
  ).bugs;
  pair = linkedReviewPairFor(bugs[0]!, bugs)!;
  expect(pair.column).toBe('DONE');
  const completed = renderToStaticMarkup(
    <LinkedReviewCard
      frontend={pair.frontend}
      backend={pair.backend}
      onArchive={() => {}}
      onOpen={() => {}}
      onIssue={() => {}}
      onVerifyPass={() => {}}
      pending={false}
    />,
  );
  expect(completed).toContain('重新打开');
  expect(completed).toContain('归档');
  expect(completed).not.toContain('>通过<');
});
