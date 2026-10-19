import { createClientId } from '@/cooking/shared/ui/client-id';
import type { SubmissionCreationCatalog } from '../contract';
import {
  availableTesterMembers,
  createItemDraft,
  normalizeItemDraft,
  engineeringIsReady,
  type ItemDraft,
} from './item-editor';

export type SubmissionContext = { projectId: string; testerUserId: string } | null;
export type SubmissionDraft = {
  mutationId: string;
  projectId: string;
  testerUserId: string;
  title: string;
  requirementDescription: string;
  items: ItemDraft[];
};

export function submissionPreparationHint(
  project: SubmissionCreationCatalog[number] | null,
) {
  if (!project?.engineerings.length) return '请先完成工程配置和仓库绑定。';
  if (project.engineerings.every(({ environments }) => !environments.length))
    return '请先为工程配置测试环境。';
  if (project.engineerings.every(({ bindings }) => !bindings.length))
    return '请先为开发负责人绑定可用 Agent。';
  if (!availableTesterMembers(project).length)
    return '测试负责人和开发负责人需要由不同成员担任，请补充项目成员与工程绑定。';
  return '工程配置已变化，请重新选择工程，或前往项目检查成员、Agent 和环境。';
}

export function preferredTester(
  project: SubmissionCreationCatalog[number],
  currentUserId: string,
  context: SubmissionContext,
) {
  const members = availableTesterMembers(project);
  return (
    members.find(
      ({ id }) => project.projectId === context?.projectId && id === context.testerUserId,
    )?.id ??
    members.find(({ id }) => id === currentUserId)?.id ??
    members[0]?.id ??
    ''
  );
}

export function createSubmissionDraft(
  catalog: SubmissionCreationCatalog,
  currentUserId: string,
  context: SubmissionContext,
  saved: SubmissionDraft | null,
): SubmissionDraft {
  const project =
    catalog.find(({ projectId }) => projectId === saved?.projectId) ??
    catalog.find(({ projectId }) => projectId === context?.projectId) ??
    catalog.find((candidate) => availableTesterMembers(candidate).length > 0) ??
    catalog[0];
  const testerUserId = project
    ? (availableTesterMembers(project).find(({ id }) => id === saved?.testerUserId)?.id ??
      preferredTester(project, currentUserId, context))
    : '';
  const used = new Set<string>();
  const items = project
    ? (saved?.items ?? [])
        .filter((item) => {
          const engineering = project.engineerings.find(
            ({ id }) => id === item.engineeringId,
          );
          if (
            !engineering ||
            used.has(engineering.id) ||
            !engineeringIsReady(engineering, testerUserId)
          )
            return false;
          used.add(engineering.id);
          return true;
        })
        .map((item) =>
          normalizeItemDraft(project, item, testerUserId, item.engineeringId),
        )
    : [];
  if (project && !items.length) {
    const first = createItemDraft(project, testerUserId, []);
    if (first) items.push(first);
  }
  return {
    mutationId: saved?.mutationId ?? createClientId(),
    projectId: project?.projectId ?? '',
    testerUserId,
    title: saved?.title ?? '',
    requirementDescription: saved?.requirementDescription ?? '',
    items,
  };
}
