'use client';

import { createClientId } from '@/cooking/shared/ui/client-id';
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
}: {
  draft: ItemDraft;
  index: number;
  onChange: (next: ItemDraft) => void;
  onRemove: (() => void) | null;
  project: CatalogProject;
  selectedEngineeringIds: string[];
  testerUserId: string;
}) {
  const engineering =
    project.engineerings.find(({ id }) => id === draft.engineeringId) ??
    project.engineerings[0]!;
  const responsibleMembers = engineering.members.filter(
    ({ id }) => id !== testerUserId,
  );
  const bindings = engineering.bindings.filter(
    ({ userId }) => userId === draft.responsibleUserId,
  );
  return (
    <article className="collab-create-item">
      <header>
        <div>
          <b>{String(index + 1).padStart(2, '0')}</b>
          <h3>提测工程</h3>
        </div>
        {onRemove ? (
          <button onClick={onRemove} type="button">
            移除
          </button>
        ) : null}
      </header>
      <div className="collab-form__grid collab-form__grid--four">
        <label>
          <span>工程</span>
          <select
            onChange={(event) =>
              onChange(
                normalizeItemDraft(
                  project,
                  draft,
                  testerUserId,
                  event.target.value,
                ),
              )
            }
            value={draft.engineeringId}
          >
            {project.engineerings.map((candidate) => (
              <option
                disabled={
                  !engineeringIsReady(candidate, testerUserId) ||
                  (candidate.id !== draft.engineeringId &&
                    selectedEngineeringIds.includes(candidate.id))
                }
                key={candidate.id}
                value={candidate.id}
              >
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>开发负责人</span>
          <select
            onChange={(event) => {
              const responsibleUserId = event.target.value;
              const bindingId =
                engineering.bindings.find(
                  (binding) => binding.userId === responsibleUserId,
                )?.id ?? '';
              onChange({ ...draft, responsibleUserId, bindingId });
            }}
            required
            value={draft.responsibleUserId}
          >
            {responsibleMembers.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Agent 绑定</span>
          <select
            onChange={(event) =>
              onChange({ ...draft, bindingId: event.target.value })
            }
            required
            value={draft.bindingId}
          >
            {bindings.map((binding) => (
              <option key={binding.id} value={binding.id}>
                {binding.runnerName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>目标分支</span>
          <input
            maxLength={240}
            onChange={(event) =>
              onChange({ ...draft, targetBranch: event.target.value })
            }
            required
            value={draft.targetBranch}
          />
        </label>
        <label>
          <span>测试环境</span>
          <select
            onChange={(event) =>
              onChange({ ...draft, environmentId: event.target.value })
            }
            required
            value={draft.environmentId}
          >
            {engineering.environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </article>
  );
}

export function createItemDraft(
  project: CatalogProject,
  testerUserId: string,
  selectedEngineeringIds: string[],
): ItemDraft | null {
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
    targetBranch: 'main',
    environmentId: engineering.environments[0]!.id,
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
    responsibleUserId: responsible?.id ?? '',
    bindingId:
      engineering.bindings.find((binding) => binding.userId === responsible?.id)
        ?.id ?? '',
    environmentId: engineering.environments.some(
      (environment) => environment.id === current.environmentId,
    )
      ? current.environmentId
      : (engineering.environments[0]?.id ?? ''),
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

function boundResponsibleMembers(
  engineering: CatalogEngineering,
  testerUserId: string,
) {
  const bound = new Set(engineering.bindings.map(({ userId }) => userId));
  return engineering.members.filter(
    ({ id }) => id !== testerUserId && bound.has(id),
  );
}
