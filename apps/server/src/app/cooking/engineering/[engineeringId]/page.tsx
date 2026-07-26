import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCurrentUser } from '@/platform/auth/server';
import { PlatformError } from '@/platform/errors';
import { engineeringService } from '@/modules/cooking/application/server';
import {
  addEngineeringMemberAction,
  archiveEngineeringAction,
  createEnvironmentAction,
  deleteEnvironmentAction,
  removeEngineeringMemberAction,
  updateEngineeringAction,
  updateEnvironmentAction,
} from '@/modules/cooking/engineering/presentation/actions';
import type { TestEnvironment } from '@/modules/cooking/engineering/contract';
import { DeploymentFields } from '@/modules/cooking/engineering/presentation/deployment-fields';
import { projectService } from '@/modules/cooking/application/server';

export default async function EngineeringPage({
  params,
  searchParams,
}: {
  params: Promise<{ engineeringId: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const user = await requireCurrentUser();
  const { engineeringId } = await params;
  const engineeringModule = engineeringService();
  let workspace;
  let project;
  let projectMembers;
  try {
    workspace = engineeringModule.getWorkspace(user.id, engineeringId);
    const projects = projectService();
    project = projects.getProject(user.id, workspace.engineering.projectId);
    projectMembers = projects.listMembers(
      user.id,
      workspace.engineering.projectId,
    );
  } catch (error) {
    if (error instanceof PlatformError && error.code === 'NOT_FOUND')
      notFound();
    throw error;
  }
  const message = await searchParams;
  const isOwner = project.membership.role === 'OWNER';
  const assignedUserIds = new Set(
    workspace.members.map(({ user: member }) => member.id),
  );
  const availableMembers = projectMembers.filter(
    ({ user: member }) => !assignedUserIds.has(member.id),
  );

  return (
    <main className="workspace-page">
      <header className="workspace-header">
        <div>
          <Link
            className="back-link"
            href={`/cooking/projects/${workspace.engineering.projectId}`}
          >
            返回项目
          </Link>
          <span className="eyebrow">
            {workspace.engineering.archivedAt ? '已归档工程' : '代码工程'}
          </span>
          <h1>{workspace.engineering.name}</h1>
          <p>{workspace.engineering.repositoryUrl}</p>
        </div>
      </header>

      {message.error ? (
        <p className="notice notice-error">{message.error}</p>
      ) : null}
      {message.success ? (
        <p className="notice notice-success">{message.success}</p>
      ) : null}

      <div className="workspace-grid">
        <section className="panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">工程成员</span>
              <h2>可负责此工程的成员</h2>
            </div>
            <span className="count-badge">{workspace.members.length}</span>
          </div>
          {workspace.members.length ? (
            <ul className="card-list">
              {workspace.members.map(({ membership, user: member }) => (
                <li className="list-card" key={member.id}>
                  <div>
                    <h3>{member.displayName}</h3>
                    <p>@{member.username}</p>
                  </div>
                  {isOwner ? (
                    <form action={removeEngineeringMemberAction}>
                      <CommonFields
                        engineeringId={engineeringId}
                        projectId={workspace.engineering.projectId}
                      />
                      <input name="userId" type="hidden" value={member.id} />
                      <input
                        name="expectedVersion"
                        type="hidden"
                        value={membership.version}
                      />
                      <button type="submit">移出工程</button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">尚未选择工程成员。</p>
          )}
          {isOwner &&
          !workspace.engineering.archivedAt &&
          availableMembers.length ? (
            <form
              action={addEngineeringMemberAction}
              className="stack-form separated-form"
            >
              <CommonFields
                engineeringId={engineeringId}
                projectId={workspace.engineering.projectId}
              />
              <label>
                添加项目成员
                <select name="userId" required>
                  {availableMembers.map(({ user: member }) => (
                    <option key={member.id} value={member.id}>
                      {member.displayName}（@{member.username}）
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit">添加工程成员</button>
            </form>
          ) : null}
        </section>

        {isOwner ? (
          <aside className="panel compact-panel">
            <span className="eyebrow">工程设置</span>
            <h2>仓库信息</h2>
            <form action={updateEngineeringAction} className="stack-form">
              <CommonFields
                engineeringId={engineeringId}
                projectId={workspace.engineering.projectId}
              />
              <input
                name="expectedVersion"
                type="hidden"
                value={workspace.engineering.version}
              />
              <label>
                工程名称
                <input
                  defaultValue={workspace.engineering.name}
                  maxLength={120}
                  name="name"
                  required
                />
              </label>
              <label>
                远程仓库地址
                <input
                  defaultValue={workspace.engineering.repositoryUrl}
                  maxLength={500}
                  name="repositoryUrl"
                  required
                />
              </label>
              <button
                disabled={Boolean(workspace.engineering.archivedAt)}
                type="submit"
              >
                保存工程设置
              </button>
            </form>
            <form action={archiveEngineeringAction}>
              <CommonFields
                engineeringId={engineeringId}
                projectId={workspace.engineering.projectId}
              />
              <input
                name="expectedVersion"
                type="hidden"
                value={workspace.engineering.version}
              />
              <button
                disabled={Boolean(workspace.engineering.archivedAt)}
                type="submit"
              >
                {workspace.engineering.archivedAt ? '工程已归档' : '归档工程'}
              </button>
            </form>
          </aside>
        ) : null}
      </div>

      <section className="panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">测试环境</span>
            <h2>部署配置</h2>
          </div>
          <span className="count-badge">{workspace.environments.length}</span>
        </div>
        {workspace.environments.length ? (
          <div className="environment-grid">
            {workspace.environments.map((environment) => (
              <EnvironmentCard
                canManage={isOwner && !workspace.engineering.archivedAt}
                environment={environment}
                projectId={workspace.engineering.projectId}
              />
            ))}
          </div>
        ) : (
          <p className="empty-state">还没有测试环境。</p>
        )}
        {isOwner && !workspace.engineering.archivedAt ? (
          <form
            action={createEnvironmentAction}
            className="stack-form separated-form"
          >
            <CommonFields
              engineeringId={engineeringId}
              projectId={workspace.engineering.projectId}
            />
            <label>
              环境名称
              <input maxLength={120} name="name" required />
            </label>
            <DeploymentFields />
            <button type="submit">创建测试环境</button>
          </form>
        ) : null}
      </section>
    </main>
  );
}

function EnvironmentCard({
  canManage,
  environment,
  projectId,
}: {
  canManage: boolean;
  environment: TestEnvironment;
  projectId: string;
}) {
  return (
    <article className="environment-card" key={environment.id}>
      <div>
        <span className="eyebrow">
          {environment.deployment.kind === 'LOCAL_SCRIPT'
            ? '本地脚本部署'
            : '持续集成部署'}
        </span>
        <h3>{environment.name}</h3>
        {environment.deployment.kind === 'LOCAL_SCRIPT' ? (
          <p className="code-summary">{environment.deployment.command}</p>
        ) : (
          <p>部署结果由外部持续集成流程回传。</p>
        )}
      </div>
      {canManage ? (
        <div className="environment-actions">
          <form action={updateEnvironmentAction} className="stack-form">
            <CommonFields
              engineeringId={environment.engineeringId}
              projectId={projectId}
            />
            <input name="environmentId" type="hidden" value={environment.id} />
            <input
              name="expectedVersion"
              type="hidden"
              value={environment.version}
            />
            <label>
              环境名称
              <input defaultValue={environment.name} name="name" required />
            </label>
            <DeploymentFields deployment={environment.deployment} />
            <button type="submit">保存环境</button>
          </form>
          <form action={deleteEnvironmentAction}>
            <CommonFields
              engineeringId={environment.engineeringId}
              projectId={projectId}
            />
            <input name="environmentId" type="hidden" value={environment.id} />
            <input
              name="expectedVersion"
              type="hidden"
              value={environment.version}
            />
            <button type="submit">删除环境</button>
          </form>
        </div>
      ) : null}
    </article>
  );
}

function CommonFields({
  engineeringId,
  projectId,
}: {
  engineeringId: string;
  projectId: string;
}) {
  return (
    <>
      <input name="mutationId" type="hidden" value={randomUUID()} />
      <input name="engineeringId" type="hidden" value={engineeringId} />
      <input name="projectId" type="hidden" value={projectId} />
    </>
  );
}
