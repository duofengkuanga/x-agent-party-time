import { randomUUID } from 'node:crypto';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { PlatformError } from '@/server/platform/errors/index';
import type { RunnerStatus } from '@agent-party-time/runner-contract';
import type { EngineeringWorkspace } from '@/contracts/projects/engineering';
import {
  bindingRequestService,
  bindingService,
} from '@/server/runtime/services';
import {
  createEngineeringBindingAction,
  updateEngineeringAction,
  updateEnvironmentAction,
} from '@/app/actions/projects/engineering';
import { DeploymentFields } from '@/app/(pages)/(main)/projects/engineering/deploymentFields';
import { BindingDeleteForm } from './bindingDeleteForm';
import { AutoRefresh } from '@/app/(pages)/(main)/components/autoRefresh';
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
      <label className="engineering-identity-form__name">
        <input
          aria-label="工程名称"
          defaultValue={engineering.name}
          maxLength={120}
          name="name"
          required
        />
      </label>
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
  bindingRequestId,
  workspace,
  runners,
  informationEditor,
  membersEditor,
  environmentsEditor,
  userId,
}: {
  bindingRequestId?: string;
  workspace: EngineeringWorkspace;
  runners: RunnerStatus[];
  informationEditor?: ReactNode;
  membersEditor?: ReactNode;
  environmentsEditor?: ReactNode;
  userId: string;
}) {
  const { id: engineeringId, projectId } = workspace.engineering;
  let bindingRequest: ReturnType<
    ReturnType<typeof bindingRequestService>['getRequest']
  > | null = null;
  if (bindingRequestId) {
    try {
      bindingRequest = bindingRequestService().getRequest(
        userId,
        bindingRequestId,
      );
    } catch (error) {
      if (!(error instanceof PlatformError && error.code === 'NOT_FOUND'))
        throw error;
    }
  }
  const bindings = bindingService().listBindings(userId, engineeringId);
  const assigned = new Set(workspace.members.map(({ user }) => user.id));
  const currentBinding = bindings.find(({ user }) => user.id === userId);
  const repositoryLabel =
    workspace.engineering.repositoryState === 'CONFIRMED'
      ? workspace.engineering.repositoryUrl
      : '等待首次本机 Agent 绑定确认仓库';

  return (
    <article
      className="engineering-detail project-engineering"
      id={`engineering-${engineeringId}`}
      aria-label={workspace.engineering.name}
    >
      <header className="project-engineering__heading">
        {informationEditor || (
          <div>
            <span className="project-engineering__type">
              {workspace.engineering.type === 'FRONTEND' ? '前端' : '后端'}
            </span>
            <h4>{workspace.engineering.name}</h4>
            <small>{workspace.engineering.identifier}</small>
            {workspace.engineering.archivedAt ? <span>已归档</span> : null}
          </div>
        )}
      </header>

      <section
        className="engineering-detail__bindings engineering-binding-strip"
        aria-label={`${workspace.engineering.name}本机 Agent 绑定`}
      >
        <div className="collaboration-section-title">
          <h5>
            本机 Agent 绑定 <small>{bindings.length}</small>
          </h5>
        </div>
        {bindings.length ? (
          <ul>
            {bindings.map(({ binding, runner, user }) => (
              <li key={binding.id}>
                <span>
                  <strong>{runner.name}</strong>
                  <small>{user.displayName}</small>
                </span>
                <em>
                  {runner.revokedAt
                    ? '已撤销'
                    : runner.lastSeenAt
                      ? '已绑定'
                      : '未连接'}
                </em>
                {binding.userId === userId ? (
                  <BindingDeleteForm
                    bindingId={binding.id}
                    engineeringId={engineeringId}
                    mutationId={randomUUID()}
                    projectId={projectId}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="collaboration-empty">还没有开发人员绑定本机 Agent。</p>
        )}
        {bindingRequest && bindingRequest.state !== 'SUCCEEDED' ? (
          <div
            className="engineering-binding-request"
            data-state={bindingRequest.state}
          >
            <AutoRefresh
              active={['PENDING', 'PROCESSING'].includes(bindingRequest.state)}
            />
            <strong>{bindingRequestLabel(bindingRequest.state)}</strong>
            <p>
              {bindingRequest.errorMessage ??
                bindingRequestMessage(bindingRequest.state)}
            </p>
          </div>
        ) : null}
        {workspace.engineering.archivedAt ||
        currentBinding ? null : bindingRequest &&
          ['PENDING', 'PROCESSING'].includes(
            bindingRequest.state,
          ) ? null : assigned.has(userId) && runners.length ? (
          <div className="engineering-binding-disclosure">
            <form
              action={createEngineeringBindingAction}
              className="engineering-binding-form"
            >
              <EngineeringFields
                engineeringId={engineeringId}
                projectId={projectId}
              />
              <label>
                <span>选择本机 Agent</span>
                <select name="runnerId" required>
                  {runners.map(({ runner }) => (
                    <option key={runner.id} value={runner.id}>
                      {runner.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit">绑定本机 Agent</button>
            </form>
          </div>
        ) : assigned.has(userId) ? (
          <div className="collab-form__blocked">
            <div>
              <strong>需要先连接本机 Agent</strong>
              <p>连接完成后再为当前工程建立绑定。</p>
            </div>
            <Link href="/agents">我的 Agent</Link>
          </div>
        ) : (
          <div className="collab-form__blocked">
            <div>
              <strong>你还不是工程成员</strong>
              <p>由项目负责人把你加入工程后，才能创建本机 Agent 绑定。</p>
            </div>
          </div>
        )}
      </section>

      <dl className="engineering-context">
        <div>
          <dt>仓库地址</dt>
          <dd>{repositoryLabel}</dd>
        </div>
        <div>
          <dt>工程成员</dt>
          <dd>
            {membersEditor || (
              <span>
                {workspace.members.length
                  ? workspace.members
                      .map(({ user }) => user.displayName)
                      .join('、')
                  : '暂未配置工程成员'}
              </span>
            )}
          </dd>
        </div>
      </dl>

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

function bindingRequestLabel(
  state: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
): string {
  return {
    PENDING: '等待 Agent 响应',
    PROCESSING: '等待选择仓库',
    SUCCEEDED: '工程绑定已完成',
    FAILED: '工程绑定未完成',
    CANCELLED: '工程绑定已取消',
  }[state];
}

function bindingRequestMessage(
  state: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
): string {
  return {
    PENDING: '等待本机 Agent 领取请求。',
    PROCESSING: '请在本机选择要绑定的 Git 仓库。',
    SUCCEEDED: '工程绑定已完成。',
    FAILED: '请根据提示重新发起工程绑定。',
    CANCELLED: '如需继续，请重新发起工程绑定。',
  }[state];
}
