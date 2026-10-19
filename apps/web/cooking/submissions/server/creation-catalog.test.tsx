import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { testDatabases } from '@/testing/database';
import { lifecycleFixture } from '@/cooking/lifecycle/server/lifecycle-fixture';
import { readSubmissionCreationCatalog } from './creation-catalog';
import { createSubmissionDraft } from '../ui/submission-draft';
import {
  ItemEditor,
  availableTesterMembers,
  boundResponsibleMembers,
  createItemDraft,
  normalizeItemDraft,
  itemDraftIsValid,
} from '../ui/item-editor';
import { SubmissionComposer } from '../ui/submission-composer';

const setup = lifecycleFixture(testDatabases());

test('创建配置只向项目成员开放，提供真实分支依据与当前环境占用', async () => {
  const f = await setup();
  const free = f.engineering.createEnvironment(
    f.users.owner.id,
    f.localEngineering.id,
    {
      mutationId: randomUUID(),
      name: '空闲环境',
      deployment: { kind: 'CI_CD' },
    },
  );
  f.submissions.updateSubmission(f.users.developer.id, f.submission.id, {
    mutationId: randomUUID(),
    expectedVersion: f.submission.version,
    title: f.submission.title,
    requirementDescription: f.submission.requirementDescription,
    targetBranches: [
      { submissionItemId: f.items[0]!.id, targetBranch: 'feature/checkout' },
    ],
  });
  const catalog = readSubmissionCreationCatalog(f.database, f.users.tester.id);
  const project = catalog[0]!;
  const engineering = project.engineerings.find(
    ({ id }) => id === f.localEngineering.id,
  )!;
  expect(engineering.targetBranchSuggestion).toEqual({
    value: 'feature/checkout',
    submissionTitle: f.submission.title,
  });
  expect(
    engineering.environments.find(({ id }) => id === f.localEnvironment.id)
      ?.conflict?.submissionId,
  ).toBe(f.submission.id);
  expect(
    engineering.environments.find(({ id }) => id === free.id)?.conflict,
  ).toBeNull();
  const draft = createItemDraft(
    { ...project, engineerings: [engineering] },
    f.users.tester.id,
    [],
  )!;
  expect(draft.targetBranch).toBe('feature/checkout');
  expect(draft.environmentId).toBe(free.id);
  expect(itemDraftIsValid(project, draft, f.users.tester.id)).toBe(true);
  expect(readSubmissionCreationCatalog(f.database, randomUUID())).toEqual([]);
});

test('人员选项排除无绑定成员和不能与当前工程组合的测试负责人', async () => {
  const f = await setup();
  f.engineering.addMember(
    f.users.owner.id,
    f.localEngineering.id,
    f.users.owner.id,
    { mutationId: randomUUID() },
  );
  const project = readSubmissionCreationCatalog(
    f.database,
    f.users.owner.id,
  )[0]!;
  const engineering = project.engineerings.find(
    ({ id }) => id === f.localEngineering.id,
  )!;
  expect(
    boundResponsibleMembers(engineering, f.users.tester.id).map(({ id }) => id),
  ).toEqual([f.users.developer.id]);
  expect(
    availableTesterMembers(project, [engineering.id]).map(({ id }) => id),
  ).not.toContain(f.users.developer.id);
  const draft = createItemDraft(
    { ...project, engineerings: [engineering] },
    f.users.tester.id,
    [],
  )!;
  expect(
    itemDraftIsValid(
      project,
      { ...draft, responsibleUserId: f.users.owner.id },
      f.users.tester.id,
    ),
  ).toBe(false);
  const html = renderToStaticMarkup(
    <ItemEditor
      draft={draft}
      index={0}
      onChange={() => {}}
      onRemove={null}
      project={{ ...project, engineerings: [engineering] }}
      selectedEngineeringIds={[engineering.id]}
      testerUserId={f.users.tester.id}
    />,
  );
  expect(html).not.toContain('<select');
  expect(html).not.toContain('aria-label="Agent"');
  const composer = renderToStaticMarkup(
    <SubmissionComposer
      catalog={[{ ...project, engineerings: [engineering] }]}
      currentUser={f.users.tester}
      context={{
        projectId: project.projectId,
        testerUserId: f.users.tester.id,
      }}
      savedDraft={null}
      onDraftChange={() => {}}
      onDiscard={() => {}}
      onClose={() => {}}
      onCreated={() => {}}
    />,
  );
  expect(composer).not.toContain('collab-add-engineering');
  const singleMember = { ...project, members: [f.users.developer] };
  const blocked = createSubmissionDraft(
    [singleMember],
    f.users.developer.id,
    null,
    null,
  );
  expect(blocked.testerUserId).toBe('');
  expect(blocked.items).toEqual([]);
  expect(itemDraftIsValid(singleMember, draft, '')).toBe(false);
});

test('恢复提测草稿沿用当前上下文并校验人员，切换工程使用该工程的分支依据', async () => {
  const f = await setup();
  const catalog = readSubmissionCreationCatalog(f.database, f.users.owner.id);
  const context = { projectId: f.project.id, testerUserId: f.users.tester.id };
  const orderedCatalog = [
    {
      ...catalog[0]!,
      projectId: randomUUID(),
      projectName: '其他项目',
      engineerings: [],
    },
    ...catalog,
  ];
  const draft = createSubmissionDraft(
    orderedCatalog,
    f.users.owner.id,
    context,
    null,
  );
  expect(draft.projectId).toBe(f.project.id);
  expect(
    createSubmissionDraft(orderedCatalog, f.users.tester.id, null, null)
      .projectId,
  ).toBe(f.project.id);
  expect(draft.testerUserId).toBe(f.users.tester.id);
  const saved = {
    ...draft,
    title: '待恢复提测',
    requirementDescription: '保留验收说明',
    items: draft.items.map((item) => ({
      ...item,
      targetBranch: 'feature/unsaved',
    })),
  };
  const restored = createSubmissionDraft(
    catalog,
    f.users.owner.id,
    context,
    saved,
  );
  expect(restored.title).toBe(saved.title);
  expect(restored.items[0]?.targetBranch).toBe('feature/unsaved');
  expect(restored.mutationId).toBe(saved.mutationId);
  const engineering = {
    ...catalog[0]!.engineerings[1]!,
    targetBranchSuggestion: null,
  };
  const project = {
    ...catalog[0]!,
    engineerings: [catalog[0]!.engineerings[0]!, engineering],
  };
  const changed = normalizeItemDraft(
    project,
    saved.items[0]!,
    draft.testerUserId,
    engineering.id,
  );
  expect(changed.targetBranch).toBe('');
  expect(itemDraftIsValid(project, changed, draft.testerUserId)).toBe(false);
});
