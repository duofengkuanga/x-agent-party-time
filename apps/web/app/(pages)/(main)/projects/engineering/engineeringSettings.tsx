import { randomUUID } from 'node:crypto';
import type { ReactNode } from 'react';
import type { EngineeringWorkspace } from '@/contracts/projects/engineering';
import {
  updateEngineeringAction,
  updateEnvironmentAction,
} from '@/app/actions/projects/engineering';
import { DeploymentFields } from '@/app/(pages)/(main)/projects/engineering/deploymentFields';
import { EngineeringFields } from './settingsFields';
import { AutoSaveForm } from '../components/autoSaveForm';
import { NewEnvironmentRow } from './newEnvironmentRow';
import { EnvironmentDeleteControl } from './environmentDeleteControl';

export function EngineeringEnvironmentManagement({
  workspace,
}: {
  workspace: EngineeringWorkspace;
}) {
  const { id: engineeringId, projectId } = workspace.engineering;
  return (
    <div className="environment-direct-list">
      {workspace.environments.map((environment) => (
        <div
          aria-label={environment.name}
          className="environment-direct-row"
          key={environment.id}
          role="group"
        >
          <AutoSaveForm
            className="environment-direct-form"
            save={updateEnvironmentAction}
            version={environment.version}
          >
            <EngineeringFields
              engineeringId={engineeringId}
              projectId={projectId}
            />
            <input name="environmentId" type="hidden" value={environment.id} />
            <label className="environment-direct-name">
              <input
                aria-label="环境名称"
                defaultValue={environment.name}
                maxLength={120}
                name="name"
                required
              />
            </label>
            <DeploymentFields
              compact
              deployment={environment.deployment}
              scriptCommand={environment.scriptCommand}
            />
          </AutoSaveForm>
          <EnvironmentDeleteControl
            engineeringId={engineeringId}
            environmentId={environment.id}
            environmentName={environment.name}
            expectedVersion={environment.version}
            mutationId={randomUUID()}
            projectId={projectId}
          />
        </div>
      ))}
      <NewEnvironmentRow engineeringId={engineeringId} />
    </div>
  );
}

export function EngineeringInformationManagement({
  workspace,
  identifierLocked,
}: {
  workspace: EngineeringWorkspace;
  identifierLocked: boolean;
}) {
  const { engineering } = workspace;
  const { id: engineeringId, projectId } = engineering;
  return (
    <AutoSaveForm
      className="engineering-identity-form"
      save={updateEngineeringAction}
      version={engineering.version}
    >
      <EngineeringFields engineeringId={engineeringId} projectId={projectId} />
      <input name="name" type="hidden" value={engineering.name} />
      <div className="engineering-type-choice">
        <span className="engineering-field-label">归属</span>
        <div aria-label="工程归属" role="radiogroup">
          {(
            [
              { value: 'FRONTEND', label: '前端' },
              { value: 'BACKEND', label: '后端' },
            ] as const
          ).map((option) => (
            <label key={option.value}>
              <input
                defaultChecked={engineering.type === option.value}
                name="type"
                type="radio"
                value={option.value}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </div>
      {identifierLocked ? (
        <div className="engineering-identifier-readonly">
          <span className="engineering-field-label">
            稳定标识{' '}
            <span className="engineering-readonly-badge">已用于提测</span>
          </span>
          <output
            aria-label="稳定标识，已用于提测，不可修改"
            title="已用于提测，不可修改"
          >
            {engineering.identifier}
          </output>
          <input
            name="identifier"
            type="hidden"
            value={engineering.identifier}
          />
        </div>
      ) : (
        <label className="engineering-identity-form__identifier">
          <span>稳定标识</span>
          <input
            defaultValue={engineering.identifier}
            maxLength={40}
            name="identifier"
            pattern="[a-z\p{Script=Han}][a-z0-9\p{Script=Han}]*(?:-[a-z0-9\p{Script=Han}]+)*"
            required
          />
        </label>
      )}
    </AutoSaveForm>
  );
}

export function EngineeringDetail({
  workspace,
  informationEditor,
  membersEditor,
  environmentsEditor,
}: {
  workspace: EngineeringWorkspace;
  informationEditor?: ReactNode;
  membersEditor?: ReactNode;
  environmentsEditor?: ReactNode;
}) {
  const { id: engineeringId } = workspace.engineering;

  return (
    <article
      className="engineering-detail project-engineering"
      id={`engineering-${engineeringId}`}
      aria-label={workspace.engineering.name}
    >
      <header className="project-engineering__heading">
        {informationEditor || (
          <div className="engineering-identity-summary">
            <div>
              <span className="engineering-field-label">归属</span>
              <span className="engineering-heading-value">
                {workspace.engineering.type === 'FRONTEND' ? '前端' : '后端'}
              </span>
            </div>
            <div>
              <span className="engineering-field-label">稳定标识</span>
              <span className="engineering-heading-value">
                {workspace.engineering.identifier}
              </span>
            </div>
          </div>
        )}
        <div className="engineering-heading-members">
          <span className="engineering-field-label">工程成员</span>
          {membersEditor || (
            <span className="engineering-heading-value">
              {workspace.members.length
                ? workspace.members
                    .map(({ user }) => user.displayName)
                    .join('、')
                : '暂未配置工程成员'}
            </span>
          )}
        </div>
      </header>

      <div className="project-engineering__body">
        <section
          className="engineering-detail__environments"
          aria-label={`${workspace.engineering.name}测试环境`}
        >
          {environmentsEditor ? (
            environmentsEditor
          ) : (
            <>
              {workspace.environments.length ? (
                <div className="environment-card-grid">
                  {workspace.environments.map((environment) => (
                    <article
                      className="environment-view-card"
                      key={environment.id}
                    >
                      <div>
                        <h5>{environment.name}</h5>
                        <small>
                          {deploymentLabel(environment.deployment.kind)}
                        </small>
                        {'command' in environment.deployment ? (
                          <details>
                            <summary>部署命令</summary>
                            <code>{environment.deployment.command}</code>
                          </details>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="collaboration-empty">还没有测试环境。</p>
              )}
            </>
          )}
        </section>
      </div>
    </article>
  );
}
function deploymentLabel(kind: 'LOCAL_SCRIPT' | 'CI_CD'): string {
  return kind === 'LOCAL_SCRIPT' ? '本地脚本' : '持续集成';
}
