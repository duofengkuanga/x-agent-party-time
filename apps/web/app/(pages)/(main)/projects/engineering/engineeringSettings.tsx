import { randomUUID } from 'node:crypto';
import type { ReactNode } from 'react';
import Link from 'next/link';
import type { RunnerStatus } from '@agent-party-time/runner-contract';
import type {
  BindingRequest,
  EngineeringWorkspace,
} from '@/contracts/projects/engineering';
import { PlatformError } from '@/server/platform/errors/index';
import {
  bindingRequestService,
  bindingService,
} from '@/server/runtime/services';
import {
  createEngineeringBindingAction,
  updateEnvironmentAction,
} from '@/app/actions/projects/engineering';
import { EngineeringFields } from './settingsFields';
import { AutoSaveForm } from '../components/autoSaveForm';
import { EnvironmentSelect } from './environmentSelect';
import { EnvironmentDeleteControl } from './environmentDeleteControl';
import { AutoRefresh } from '@/app/(pages)/(main)/components/autoRefresh';
import { SaveButton } from '../components/saveButton';

export function EngineeringEnvironmentManagement({
  workspace,
}: {
  workspace: EngineeringWorkspace;
}) {
  const { id: engineeringId, projectId } = workspace.engineering;
  return (
    <EnvironmentSelect
      engineeringId={engineeringId}
      environments={workspace.environments.map((environment) => ({
        ...environment,
        editor: (
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
              <input
                name="environmentId"
                type="hidden"
                value={environment.id}
              />
              <label className="environment-direct-name">
                <span>环境名称</span>
                <input
                  aria-label="环境名称"
                  defaultValue={environment.name}
                  maxLength={120}
                  name="name"
                  required
                />
              </label>
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
        ),
      }))}
    />
  );
}

export function EngineeringDetail({
  workspace,
  userId,
  runners,
  bindingRequestId,
  membersEditor,
  environmentsEditor,
}: {
  workspace: EngineeringWorkspace;
  userId: string;
  runners: RunnerStatus[];
  bindingRequestId?: string;
  membersEditor?: ReactNode;
  environmentsEditor?: ReactNode;
}) {
  const { id: engineeringId, projectId } = workspace.engineering;
  const canBind =
    !workspace.engineering.archivedAt &&
    workspace.members.some(({ user }) => user.id === userId) &&
    !bindingService()
      .listBindings(userId, engineeringId)
      .some(({ binding }) => binding.userId === userId);
  let bindingRequest: BindingRequest | null = null;
  if (canBind && bindingRequestId) {
    try {
      const request = bindingRequestService().getRequest(
        userId,
        bindingRequestId,
      );
      if (request.engineeringId === engineeringId) bindingRequest = request;
    } catch (error) {
      if (!(error instanceof PlatformError && error.code === 'NOT_FOUND'))
        throw error;
    }
  }
  const awaitingBinding =
    bindingRequest?.state === 'PENDING' ||
    bindingRequest?.state === 'PROCESSING';

  return (
    <article
      className="engineering-detail project-engineering"
      id={`engineering-${engineeringId}`}
      aria-label={workspace.engineering.name}
    >
      <header className="project-engineering__heading">
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

      {canBind ? (
        <section
          className="engineering-binding-strip"
          aria-label={`${workspace.engineering.name}本机 Agent 绑定`}
        >
          <div className="collaboration-section-title">
            <h5>绑定本机 Agent</h5>
          </div>
          {bindingRequest && bindingRequest.state !== 'SUCCEEDED' ? (
            <div
              className="engineering-binding-request"
              data-state={bindingRequest.state}
              role="status"
            >
              <AutoRefresh active={awaitingBinding} />
              <strong>
                {
                  {
                    PENDING: '等待 Agent 响应',
                    PROCESSING: '等待选择仓库',
                    FAILED: '工程绑定未完成',
                    CANCELLED: '工程绑定已取消',
                  }[bindingRequest.state]
                }
              </strong>
              <p>
                {bindingRequest.errorMessage ??
                  (awaitingBinding
                    ? '请在本机 Agent 提示后选择要绑定的 Git 仓库。'
                    : '如需继续，请重新发起工程绑定。')}
              </p>
            </div>
          ) : null}
          {awaitingBinding ? null : runners.length ? (
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
                <SaveButton pendingLabel="正在发起绑定…">
                  绑定本机 Agent
                </SaveButton>
              </form>
            </div>
          ) : (
            <div className="collab-form__blocked">
              <div>
                <strong>需要先连接本机 Agent</strong>
                <p>连接完成后再为当前工程建立绑定。</p>
              </div>
              <Link href="/agents">我的 Agent</Link>
            </div>
          )}
        </section>
      ) : null}

      <div className="project-engineering__body">
        <section
          className="engineering-detail__environments"
          aria-label={`${workspace.engineering.name}测试环境`}
        >
          {environmentsEditor ?? (
            <EnvironmentSelect environments={workspace.environments} />
          )}
        </section>
      </div>
    </article>
  );
}
