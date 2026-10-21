'use client';

import { createClientId } from '@/cooking/shared/ui/clientId';
import { FormChoice } from '@/cooking/shared/ui/formChoice';
import type { SubmissionCreationCatalog } from '../contract';

type CatalogProject = SubmissionCreationCatalog[number];
type CatalogEngineering = CatalogProject['engineerings'][number];

export type ItemDraft = {
  key: string;
  engineeringId: string;
  responsibleUserId: string;
  bindingId: string;
  targetBranch: string;
  environmentId: string;
};

export function ItemEditor({
  draft,
  index,
  onChange,
  onRemove,
  project,
  selectedEngineeringIds,
  testerUserId,
  showHeading = true,
}: {
  draft: ItemDraft;
  index: number;
  onChange: (next: ItemDraft) => void;
  onRemove: (() => void) | null;
  project: CatalogProject;
  selectedEngineeringIds: string[];
  testerUserId: string;
  showHeading?: boolean;
}) {
  const engineering = project.engineerings.find(
    ({ id }) => id === draft.engineeringId,
  );
  if (!engineering) return <p role="alert">工程配置已变化，请重新选择工程。</p>;
  const responsibleMembers = boundResponsibleMembers(engineering, testerUserId);
  const environment = engineering.environments.find(
    ({ id }) => id === draft.environmentId,
  );
  const choices = project.engineerings.filter(
    (candidate) =>
      engineeringIsReady(candidate, testerUserId) &&
      (candidate.id === draft.engineeringId ||
        !selectedEngineeringIds.includes(candidate.id)),
  );
  return (
    <article className="collab-create-item">
      {showHeading ? (
        <header>
          <div className="collab-create-item__heading">
            <b>{String(index + 1).padStart(2, '0')}</b>
            <h3>提测工程</h3>
          </div>
          {onRemove ? (
            <button onClick={onRemove} type="button">
              移除
            </button>
          ) : null}
        </header>
      ) : null}
      <div className="collab-create-item__identity">
        <FormChoice
          label="工程"
          value={draft.engineeringId}
          options={choices.map((candidate) => ({
            value: candidate.id,
            label: candidate.name,
          }))}
          onChange={(id) =>
            onChange(normalizeItemDraft(project, draft, testerUserId, id))
          }
        />
        <FormChoice
          label="开发负责人"
          value={draft.responsibleUserId}
          options={responsibleMembers.map((member) => ({
            value: member.id,
            label: member.displayName,
          }))}
          onChange={(responsibleUserId) =>
            onChange({
              ...draft,
              responsibleUserId,
              bindingId: engineering.bindings.find(
                (candidate) => candidate.userId === responsibleUserId,
              )!.id,
            })
          }
        />
      </div>
      <div className="collab-create-item__delivery">
        <label>
          <span>目标分支</span>
          <input
            aria-label="目标分支"
            maxLength={240}
            required
            value={draft.targetBranch}
            placeholder="填写本次提测的目标分支"
            onChange={(event) =>
              onChange({ ...draft, targetBranch: event.target.value })
            }
          />
          <small className="collab-create-item__branch-hint">
            {engineering.targetBranchSuggestion
              ? `最近提测「${engineering.targetBranchSuggestion.submissionTitle}」使用 ${engineering.targetBranchSuggestion.value}`
              : '该工程首次提测，请填写目标分支。'}
          </small>
        </label>
        <FormChoice
          label="测试环境"
          value={draft.environmentId}
          options={engineering.environments.map((candidate) => ({
            value: candidate.id,
            label: `${candidate.name}（${candidate.conflict ? '使用中' : '空闲'}）`,
          }))}
          onChange={(environmentId) => onChange({ ...draft, environmentId })}
        />
      </div>
      {environment?.conflict ? (
        <aside className="collab-create-item__notice" role="status">
          <strong>
            {environment.conflict.blockedReason ? '环境暂不可用' : '环境使用中'}
          </strong>
          <div>
            <p>
              {environment.name} 正由「{environment.conflict.submissionTitle}
              」使用，测试负责人：{environment.conflict.testerName}。
            </p>
            <p>
              {environment.conflict.blockedReason ??
                '使用此环境需要确认切换，原提测项将暂停更新和验证。'}
            </p>
          </div>
        </aside>
      ) : null}
    </article>
  );
}

export function createItemDraft(
  project: CatalogProject,
  testerUserId: string,
  selectedEngineeringIds: string[],
): ItemDraft | null {
  if (!project.members.some(({ id }) => id === testerUserId)) return null;
  const engineering = project.engineerings.find(
    (candidate) =>
      !selectedEngineeringIds.includes(candidate.id) &&
      engineeringIsReady(candidate, testerUserId),
  );
  if (!engineering) return null;
  const responsible = boundResponsibleMembers(engineering, testerUserId)[0]!;
  return {
    key: createClientId(),
    engineeringId: engineering.id,
    responsibleUserId: responsible.id,
    bindingId: engineering.bindings.find(
      (binding) => binding.userId === responsible.id,
    )!.id,
    targetBranch: engineering.targetBranchSuggestion?.value ?? '',
    environmentId: defaultEnvironmentId(engineering),
  };
}

export function normalizeItemDraft(
  project: CatalogProject,
  current: ItemDraft,
  testerUserId: string,
  engineeringId: string,
): ItemDraft {
  const engineering = project.engineerings.find(
    (candidate) => candidate.id === engineeringId,
  )!;
  const members = boundResponsibleMembers(engineering, testerUserId);
  const responsible =
    members.find((member) => member.id === current.responsibleUserId) ??
    members[0];
  return {
    ...current,
    engineeringId,
    targetBranch:
      engineeringId === current.engineeringId
        ? current.targetBranch
        : (engineering.targetBranchSuggestion?.value ?? ''),
    responsibleUserId: responsible?.id ?? '',
    bindingId:
      engineering.bindings.find((binding) => binding.userId === responsible?.id)
        ?.id ?? '',
    environmentId: engineering.environments.some(
      (environment) => environment.id === current.environmentId,
    )
      ? current.environmentId
      : defaultEnvironmentId(engineering),
  };
}

export function engineeringIsReady(
  engineering: CatalogEngineering,
  testerUserId: string,
): boolean {
  return (
    engineering.environments.length > 0 &&
    boundResponsibleMembers(engineering, testerUserId).length > 0
  );
}

export function boundResponsibleMembers(
  engineering: CatalogEngineering,
  testerUserId: string,
) {
  const bound = new Set(engineering.bindings.map(({ userId }) => userId));
  return engineering.members.filter(
    ({ id }) => id !== testerUserId && bound.has(id),
  );
}

function defaultEnvironmentId(engineering: CatalogEngineering): string {
  return (
    engineering.environments.find((environment) => !environment.conflict)?.id ??
    engineering.environments.find(
      (environment) => !environment.conflict?.blockedReason,
    )?.id ??
    engineering.environments[0]?.id ??
    ''
  );
}

export function availableTesterMembers(
  project: CatalogProject,
  engineeringIds: string[] = [],
) {
  const selected = project.engineerings.filter(({ id }) =>
    engineeringIds.includes(id),
  );
  return project.members.filter((member) =>
    selected.length
      ? selected.every((engineering) =>
          engineeringIsReady(engineering, member.id),
        )
      : project.engineerings.some((engineering) =>
          engineeringIsReady(engineering, member.id),
        ),
  );
}

export function itemDraftIsValid(
  project: CatalogProject,
  draft: ItemDraft,
  testerUserId: string,
) {
  const engineering = project.engineerings.find(
    ({ id }) => id === draft.engineeringId,
  );
  return Boolean(
    project.members.some(({ id }) => id === testerUserId) &&
    engineering &&
    draft.targetBranch.trim() &&
    boundResponsibleMembers(engineering, testerUserId).some(
      ({ id }) => id === draft.responsibleUserId,
    ) &&
    engineering.bindings.some(
      ({ id, userId }) =>
        id === draft.bindingId && userId === draft.responsibleUserId,
    ) &&
    engineering.environments.some(
      ({ id, conflict }) =>
        id === draft.environmentId && !conflict?.blockedReason,
    ),
  );
}
