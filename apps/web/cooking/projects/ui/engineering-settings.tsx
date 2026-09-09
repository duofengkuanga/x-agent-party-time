import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { PlatformError } from '@/platform/errors';
import { runnerService } from '@/platform/runner/server';
import {
  bindingRequestService,
  bindingService,
  engineeringService,
} from '@/cooking/runtime/services';
import { createEngineeringBindingAction } from '@/cooking/bindings/server/actions';
import {
  archiveEngineeringAction,
  createEnvironmentAction,
  deleteEnvironmentAction,
  updateEngineeringAction,
  updateEnvironmentAction,
} from '@/cooking/engineering/server/actions';
import { DeploymentFields } from '@/cooking/engineering/ui/deployment-fields';
import { EngineeringCreateEnvironments } from './engineering-create-environments';
import { BindingDeleteForm } from './binding-delete-form';
import { BindingRequestRefresh } from './binding-request-refresh';
import { EngineeringTaskHeading, EngineeringFields } from './settings-fields';
import {
  deploymentLabel,
  bindingRequestLabel,
  bindingRequestMessage,
} from './settings-links';

export function EngineeringEnvironmentManagement({
  engineeringId,
  projectId,
  userId,
}: {
  engineeringId: string;
  projectId: string;
  userId: string;
}) {
  const workspace = engineeringService().getWorkspace(userId, engineeringId);

  return (
    <div className="engineering-task engineering-task--environments">
      <EngineeringTaskHeading
        label="环境管理"
        name={workspace.engineering.name}
        projectId={projectId}
      />

      <section className="engineering-task__section">
        <div className="engineering-task__section-title">
          <strong>测试环境</strong>
          <small>{workspace.environments.length} 个</small>
        </div>
        <div className="engineering-environment-list">
          {workspace.environments.map((environment) => (
            <details
              className="engineering-environment-row"
              key={environment.id}
            >
              <summary>
                <span>
                  <strong>{environment.name}</strong>
                  <small>{deploymentLabel(environment.deployment.kind)}</small>
                </span>
                <small>编辑</small>
              </summary>
              <form action={updateEnvironmentAction}>
                <EngineeringFields
                  engineeringId={engineeringId}
                  projectId={projectId}
                />
                <input
                  name="environmentId"
                  type="hidden"
                  value={environment.id}
                />
                <input
                  name="expectedVersion"
                  type="hidden"
                  value={environment.version}
                />
                <label>
                  <span>环境名称</span>
                  <input defaultValue={environment.name} name="name" required />
                </label>
                <DeploymentFields deployment={environment.deployment} />
                <div className="engineering-task__form-actions">
                  <button
                    className="engineering-task__danger"
                    formAction={deleteEnvironmentAction}
                    type="submit"
                  >
                    删除环境
                  </button>
                  <button type="submit">保存环境</button>
                </div>
              </form>
            </details>
          ))}
        </div>
        {workspace.environments.length ? null : (
          <p className="engineering-task__empty">还没有测试环境。</p>
        )}
      </section>

      <section className="engineering-environment-create">
        <form
          action={createEnvironmentAction}
          className="engineering-environment-batch-form"
        >
          <EngineeringFields
            engineeringId={engineeringId}
            projectId={projectId}
          />
          <EngineeringCreateEnvironments
            initialMutationId={randomUUID()}
            saveContext="一起保存到当前工程"
            submitLabel="保存测试环境"
          />
        </form>
      </section>
    </div>
  );
}

export function EngineeringInformationManagement({
  engineeringId,
  projectId,
  userId,
}: {
  engineeringId: string;
  projectId: string;
  userId: string;
}) {
  const service = engineeringService();
  const workspace = service.getWorkspace(userId, engineeringId);
  const identifierLocked = service.isIdentifierLocked(userId, engineeringId);

  return (
    <div className="engineering-task">
      <EngineeringTaskHeading
        label="信息管理"
        name={workspace.engineering.name}
        projectId={projectId}
      />

      <section className="engineering-task__section">
        <form
          action={updateEngineeringAction}
          className="engineering-information-form"
        >
          <header className="engineering-information-form__header">
            <div>
              <strong>工程信息</strong>
              <small>维护工程在提测与缺陷协作中展示的基础信息。</small>
            </div>
            <button type="submit">保存工程信息</button>
          </header>
          <EngineeringFields
            engineeringId={engineeringId}
            projectId={projectId}
          />
          <input
            name="expectedVersion"
            type="hidden"
            value={workspace.engineering.version}
          />
          <div className="engineering-information-form__fields">
            <label className="engineering-information-form__name">
              <span>名称</span>
              <input
                defaultValue={workspace.engineering.name}
                name="name"
                required
              />
            </label>
            <label>
              <span>归属</span>
              <select defaultValue={workspace.engineering.type} name="type">
                <option value="FRONTEND">前端</option>
                <option value="BACKEND">后端</option>
              </select>
            </label>
            <label>
              <span>稳定标识</span>
              <input
                aria-describedby={
                  identifierLocked
                    ? 'engineering-identifier-lock'
                    : 'engineering-identifier-format'
                }
                defaultValue={workspace.engineering.identifier}
                maxLength={40}
                name="identifier"
                pattern="[a-z\p{Script=Han}][a-z0-9\p{Script=Han}]*(?:-[a-z0-9\p{Script=Han}]+)*"
                readOnly={identifierLocked}
                required
              />
              {identifierLocked ? (
                <small id="engineering-identifier-lock">
                  已被提测引用，不可修改。
                </small>
              ) : (
                <small id="engineering-identifier-format">
                  支持中文、小写字母、数字和单个连字符，需以中文或小写字母开头。
                </small>
              )}
            </label>
          </div>
        </form>
      </section>

      {!workspace.engineering.archivedAt ? (
        <section className="engineering-task__archive">
          <div className="engineering-task__section-title">
            <strong>工程归档</strong>
          </div>
          <form action={archiveEngineeringAction}>
            <EngineeringFields
              engineeringId={engineeringId}
              projectId={projectId}
            />
            <input
              name="expectedVersion"
              type="hidden"
              value={workspace.engineering.version}
            />
            <p>归档后保留历史记录，并停止继续使用这个工程。</p>
            <button type="submit">归档工程</button>
          </form>
        </section>
      ) : (
        <p className="engineering-task__empty">这个工程已经归档。</p>
      )}
    </div>
  );
}

export function EngineeringDetail({
  bindingRequestId,
  engineeringId,
  projectId,
  userId,
}: {
  bindingRequestId?: string;
  engineeringId: string;
  projectId: string;
  userId: string;
}) {
  const service = engineeringService();
  const workspace = service.getWorkspace(userId, engineeringId);
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
  const runners = runnerService()
    .listRunners(userId)
    .filter(({ online, runner }) => online && !runner.revokedAt);
  const currentBinding = bindings.find(({ user }) => user.id === userId);
  const repositoryLabel =
    workspace.engineering.repositoryState === 'CONFIRMED'
      ? workspace.engineering.repositoryUrl
      : '等待首次本机 Agent 绑定确认仓库';

  return (
    <div className="engineering-detail">
      <EngineeringTaskHeading
        label="工程详情"
        name={workspace.engineering.name}
        projectId={projectId}
        status={workspace.engineering.archivedAt ? '已归档' : '使用中'}
      />

      <dl>
        <div>
          <dt>工程归属</dt>
          <dd>{workspace.engineering.type === 'FRONTEND' ? '前端' : '后端'}</dd>
        </div>
        <div>
          <dt>稳定标识</dt>
          <dd>{workspace.engineering.identifier}</dd>
        </div>
        <div>
          <dt>仓库地址</dt>
          <dd>{repositoryLabel}</dd>
        </div>
        <div>
          <dt>工程成员</dt>
          <dd>
            {workspace.members.length
              ? workspace.members.map(({ user }) => user.displayName).join('、')
              : '暂未配置工程成员'}
          </dd>
        </div>
      </dl>

      <section className="engineering-detail__environments">
        <div className="collaboration-section-title">
          <span>测试环境</span>
          <small>{workspace.environments.length} 个</small>
        </div>
        {workspace.environments.length ? (
          workspace.environments.map((environment) => (
            <article key={environment.id}>
              <div>
                <strong>{environment.name}</strong>
                <small>{deploymentLabel(environment.deployment.kind)}</small>
                {'command' in environment.deployment ? (
                  <code>{environment.deployment.command}</code>
                ) : null}
              </div>
            </article>
          ))
        ) : (
          <p className="collaboration-empty">还没有测试环境。</p>
        )}
      </section>

      <section className="engineering-detail__bindings">
        <div className="collaboration-section-title">
          <span>本机 Agent 绑定</span>
          <small>{bindings.length} 个</small>
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
                      ? '已连接'
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
            <BindingRequestRefresh
              active={['PENDING', 'PROCESSING'].includes(bindingRequest.state)}
            />
            <strong>{bindingRequestLabel(bindingRequest.state)}</strong>
            <p>
              {bindingRequest.errorMessage ??
                bindingRequestMessage(bindingRequest.state)}
            </p>
          </div>
        ) : null}
        {currentBinding ? null : bindingRequest &&
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
            <Link href="/cooking/agents">我的 Agent</Link>
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
    </div>
  );
}
