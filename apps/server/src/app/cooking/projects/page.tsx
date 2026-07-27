import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { logoutAction } from '@/app/logout/action';
import { requireCurrentUser } from '@/platform/auth/server';
import { runnerService } from '@/platform/runner/server';
import {
  bindingService,
  engineeringService,
  projectService,
} from '@/modules/cooking/application/server';
import { createEngineeringBindingAction } from '@/modules/cooking/bindings/presentation/actions';
import {
  addEngineeringMemberAction,
  archiveEngineeringAction,
  createEngineeringAction,
  createEnvironmentAction,
  deleteEnvironmentAction,
  removeEngineeringMemberAction,
  updateEngineeringAction,
  updateEnvironmentAction,
} from '@/modules/cooking/engineering/presentation/actions';
import { DeploymentFields } from '@/modules/cooking/engineering/presentation/deployment-fields';
import {
  createProjectAction,
  inviteProjectUserAction,
  removeProjectMemberAction,
  respondProjectInvitationAction,
  revokeProjectInvitationAction,
  updateProjectAction,
} from '@/modules/cooking/projects/presentation/actions';
import { ThemeToggle } from './theme-toggle';

export default async function ProjectSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    create?: string;
    engineering?: string;
    error?: string;
    panel?: string;
    project?: string;
    success?: string;
  }>;
}) {
  const user = await requireCurrentUser();
  const query = await searchParams;
  const projects = projectService().listProjects(user.id);
  const invitations = projectService().listReceivedInvitations(user.id);
  const selected = query.project
    ? projects.find(({ project }) => project.id === query.project)
    : undefined;
  const panel = query.panel;

  return (
    <main className="collab-shell project-settings-shell" data-theme="paper">
      <header className="collab-topbar">
        <div className="brand-lockup">
          <Link className="brand" href="/cooking">
            Agent Party Time
          </Link>
          <span className="collab-topbar__mode">项目与工程</span>
        </div>
        <div className="collab-topbar__actions">
          <ThemeToggle />
          <span className="account-badge">
            <span className="account-badge__copy">
              <strong>{user.displayName}</strong>
              <small>协作成员</small>
            </span>
          </span>
        </div>
      </header>

      <div className="project-settings">
        <section className="project-settings__hero">
          <div className="project-settings__intro">
            <span className="collab-section-label">协作基础设置</span>
            <h1>项目与工程</h1>
            <p>管理私密项目、成员、工程、测试环境与本机 Runner 绑定。</p>
          </div>
          <div className="project-settings__toolbar-actions">
            <Link className="project-settings__quiet-action" href="/cooking">
              返回提测
            </Link>
            <Link
              className="project-settings__primary-action"
              href="/cooking/projects?create=1"
            >
              ＋ 新建项目
            </Link>
          </div>
        </section>

        <section className="project-settings__content">
          {query.error ? (
            <p className="project-settings__error" role="alert">
              {query.error}
            </p>
          ) : null}
          {query.success ? (
            <p className="notice notice-success">{query.success}</p>
          ) : null}

          {query.create === '1' || projects.length === 0 ? (
            <form
              action={createProjectAction}
              className="project-settings__create"
            >
              <input name="mutationId" type="hidden" value={randomUUID()} />
              <div>
                <span>新项目</span>
                <p>项目创建后继续配置成员、工程与 Runner。</p>
              </div>
              <label>
                <span>项目名称</span>
                <input maxLength={120} name="name" required />
              </label>
              <button type="submit">创建并配置工程</button>
            </form>
          ) : null}

          {projects.length ? (
            <ol className="project-settings__list">
              {projects.map(({ project, membership }) => (
                <li key={project.id}>
                  <div className="project-settings__project-copy">
                    <span>
                      {membership.role === 'OWNER' ? '项目负责人' : '项目成员'}
                    </span>
                    <h2>{project.name}</h2>
                  </div>
                  <div className="project-settings__row-actions">
                    <Link href={settingsHref(project.id, 'collaboration')}>
                      成员与邀请
                    </Link>
                    <Link
                      className="project-settings__row-primary"
                      href={settingsHref(project.id, 'engineering')}
                    >
                      工程与 Runner
                    </Link>
                    <Link href="/cooking">提测</Link>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="project-settings__empty">
              <span>暂无项目</span>
              <h2>从一个项目开始。</h2>
              <p>项目创建后，可继续添加工程、配置测试环境并绑定本机 Runner。</p>
            </div>
          )}

          {invitations.length ? (
            <section className="project-settings__empty">
              <span>项目邀请</span>
              <h2>等待你的决定。</h2>
              <ol className="project-settings__list">
                {invitations.map(
                  ({ invitation, projectName, invitedByDisplayName }) => (
                    <li key={invitation.id}>
                      <div className="project-settings__project-copy">
                        <span>{invitedByDisplayName} 邀请</span>
                        <h2>{projectName}</h2>
                      </div>
                      <div className="project-settings__row-actions">
                        <InvitationForm
                          decision="ACCEPT"
                          invitationId={invitation.id}
                          label="接受邀请"
                          version={invitation.version}
                        />
                        <InvitationForm
                          decision="REJECT"
                          invitationId={invitation.id}
                          label="拒绝邀请"
                          version={invitation.version}
                        />
                      </div>
                    </li>
                  ),
                )}
              </ol>
            </section>
          ) : null}
        </section>
      </div>

      {selected && panel === 'collaboration' ? (
        <CollaborationDialog projectId={selected.project.id} userId={user.id} />
      ) : null}
      {selected && panel === 'engineering' ? (
        <EngineeringDialog
          engineeringId={query.engineering}
          projectId={selected.project.id}
          userId={user.id}
        />
      ) : null}
    </main>
  );
}

function CollaborationDialog({
  projectId,
  userId,
}: {
  projectId: string;
  userId: string;
}) {
  const projects = projectService();
  const summary = projects.getProject(userId, projectId);
  const members = projects.listMembers(userId, projectId);
  const invitations = projects.listProjectInvitations(userId, projectId);
  const owner = summary.membership.role === 'OWNER';
  return (
    <Dialog title="成员与邀请" kicker={summary.project.name}>
      <div className="collaboration-dialog__body">
        <section className="collaboration-section">
          <div className="collaboration-section-title">
            <span>项目成员</span>
            <small>{members.length}</small>
          </div>
          <ul className="collaboration-list">
            {members.map(({ membership, user }) => (
              <li key={user.id}>
                <div>
                  <strong>{user.displayName}</strong>
                  <small>@{user.username}</small>
                </div>
                <span>{membership.role === 'OWNER' ? '负责人' : '成员'}</span>
                {owner && membership.role !== 'OWNER' ? (
                  <form action={removeProjectMemberAction}>
                    <ProjectFields projectId={projectId} />
                    <input name="userId" type="hidden" value={user.id} />
                    <input
                      name="expectedVersion"
                      type="hidden"
                      value={membership.version}
                    />
                    <button type="submit">移除</button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        {owner ? (
          <section className="collaboration-section">
            <div className="collaboration-section-title">
              <span>邀请成员</span>
            </div>
            <form
              action={inviteProjectUserAction}
              className="collaboration-invite-form"
            >
              <ProjectFields projectId={projectId} />
              <label>
                <span>用户名</span>
                <input maxLength={80} name="username" required />
              </label>
              <button type="submit">发送邀请</button>
            </form>
          </section>
        ) : null}

        {invitations.length ? (
          <section className="collaboration-section">
            <div className="collaboration-section-title">
              <span>邀请记录</span>
              <small>{invitations.length}</small>
            </div>
            <ul className="collaboration-list">
              {invitations.map(({ invitation, invitedUser }) => (
                <li key={invitation.id}>
                  <div>
                    <strong>{invitedUser.displayName}</strong>
                    <small>@{invitedUser.username}</small>
                  </div>
                  <span>{invitationStatus(invitation.status)}</span>
                  {owner && invitation.status === 'PENDING' ? (
                    <form action={revokeProjectInvitationAction}>
                      <ProjectFields projectId={projectId} />
                      <input
                        name="invitationId"
                        type="hidden"
                        value={invitation.id}
                      />
                      <input
                        name="expectedVersion"
                        type="hidden"
                        value={invitation.version}
                      />
                      <button type="submit">撤销</button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {owner ? (
          <section className="collaboration-section">
            <div className="collaboration-section-title">
              <span>项目名称</span>
            </div>
            <form
              action={updateProjectAction}
              className="collaboration-invite-form"
            >
              <ProjectFields projectId={projectId} />
              <input
                name="expectedVersion"
                type="hidden"
                value={summary.project.version}
              />
              <input defaultValue={summary.project.name} name="name" required />
              <button type="submit">保存名称</button>
            </form>
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}

function EngineeringDialog({
  engineeringId,
  projectId,
  userId,
}: {
  engineeringId?: string;
  projectId: string;
  userId: string;
}) {
  const projects = projectService();
  const engineering = engineeringService();
  const project = projects.getProject(userId, projectId);
  const items = engineering.listEngineering(userId, projectId);
  const members = projects.listMembers(userId, projectId);
  const selected = engineeringId
    ? items.find((candidate) => candidate.id === engineeringId)
    : undefined;
  const owner = project.membership.role === 'OWNER';

  return (
    <Dialog title="工程目录" kicker={project.project.name}>
      {selected ? (
        <EngineeringDetail
          engineeringId={selected.id}
          owner={owner}
          projectId={projectId}
          projectMembers={members}
          userId={userId}
        />
      ) : (
        <div className="engineering-catalog">
          <div className="engineering-catalog__intro">
            <div>
              <span>工程与 Runner</span>
              <p>维护工程成员、测试环境和开发者本机 Binding。</p>
            </div>
            <div className="engineering-detail__actions">
              <Link href="/cooking/runners">Runner 管理</Link>
            </div>
          </div>
          <section className="engineering-group">
            <div className="collaboration-section-title">
              <span>工程列表</span>
              <small>{items.length}</small>
            </div>
            <div className="engineering-list">
              {items.map((item) => (
                <Link
                  className="engineering-card"
                  href={engineeringHref(projectId, item.id)}
                  key={item.id}
                >
                  <span>{item.archivedAt ? '已归档' : '代码工程'}</span>
                  <strong>{item.name}</strong>
                  <small>{item.repositoryUrl}</small>
                </Link>
              ))}
            </div>
          </section>
          {owner ? (
            <section className="engineering-group">
              <div className="collaboration-section-title">
                <span>新增工程</span>
              </div>
              <form
                action={createEngineeringAction}
                className="engineering-editor"
              >
                <ProjectFields projectId={projectId} />
                <div className="engineering-editor__grid">
                  <label>
                    <span>工程名称</span>
                    <input maxLength={120} name="name" required />
                  </label>
                  <label>
                    <span>远程仓库地址</span>
                    <input maxLength={500} name="repositoryUrl" required />
                  </label>
                </div>
                <div className="dialog-actions">
                  <button type="submit">创建工程</button>
                </div>
              </form>
            </section>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

function EngineeringDetail({
  engineeringId,
  owner,
  projectId,
  projectMembers,
  userId,
}: {
  engineeringId: string;
  owner: boolean;
  projectId: string;
  projectMembers: ReturnType<ReturnType<typeof projectService>['listMembers']>;
  userId: string;
}) {
  const service = engineeringService();
  const workspace = service.getWorkspace(userId, engineeringId);
  const bindings = bindingService().listBindings(userId, engineeringId);
  const assigned = new Set(workspace.members.map(({ user }) => user.id));
  const availableMembers = projectMembers.filter(
    ({ user }) => !assigned.has(user.id),
  );
  const runners = runnerService()
    .listRunners(userId)
    .filter(({ runner }) => !runner.revokedAt);
  return (
    <div className="engineering-detail">
      <div className="engineering-detail__headline">
        <div>
          <span>
            {workspace.engineering.archivedAt ? '已归档工程' : '代码工程'}
          </span>
          <h3>{workspace.engineering.name}</h3>
          <small>{workspace.engineering.repositoryUrl}</small>
        </div>
        <Link href={settingsHref(projectId, 'engineering')}>返回工程列表</Link>
      </div>

      {owner ? (
        <form action={updateEngineeringAction} className="engineering-editor">
          <EngineeringFields
            engineeringId={engineeringId}
            projectId={projectId}
          />
          <input
            name="expectedVersion"
            type="hidden"
            value={workspace.engineering.version}
          />
          <div className="engineering-editor__grid">
            <label>
              <span>工程名称</span>
              <input
                defaultValue={workspace.engineering.name}
                name="name"
                required
              />
            </label>
            <label>
              <span>远程仓库地址</span>
              <input
                defaultValue={workspace.engineering.repositoryUrl}
                name="repositoryUrl"
                required
              />
            </label>
          </div>
          <div className="dialog-actions">
            <button type="submit">保存工程设置</button>
          </div>
        </form>
      ) : null}

      <section className="engineering-detail__bindings">
        <div className="collaboration-section-title">
          <span>工程成员</span>
          <small>{workspace.members.length}</small>
        </div>
        <ul>
          {workspace.members.map(({ membership, user }) => (
            <li key={user.id}>
              <span>
                <strong>{user.displayName}</strong>
                <small>@{user.username}</small>
              </span>
              {owner ? (
                <form action={removeEngineeringMemberAction}>
                  <EngineeringFields
                    engineeringId={engineeringId}
                    projectId={projectId}
                  />
                  <input name="userId" type="hidden" value={user.id} />
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
        {owner && availableMembers.length ? (
          <form
            action={addEngineeringMemberAction}
            className="engineering-binding-form"
          >
            <EngineeringFields
              engineeringId={engineeringId}
              projectId={projectId}
            />
            <select name="userId" required>
              {availableMembers.map(({ user }) => (
                <option key={user.id} value={user.id}>
                  {user.displayName}（@{user.username}）
                </option>
              ))}
            </select>
            <button type="submit">添加工程成员</button>
          </form>
        ) : null}
      </section>

      <section className="engineering-detail__environments">
        <div className="collaboration-section-title">
          <span>测试环境</span>
          <small>{workspace.environments.length}</small>
        </div>
        {workspace.environments.map((environment) => (
          <article key={environment.id}>
            <form
              action={updateEnvironmentAction}
              className="engineering-editor"
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
              <div className="dialog-actions">
                <button type="submit">保存环境</button>
              </div>
            </form>
            {owner ? (
              <form action={deleteEnvironmentAction}>
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
                <button
                  className="engineering-remove-environment"
                  type="submit"
                >
                  删除环境
                </button>
              </form>
            ) : null}
          </article>
        ))}
        {owner ? (
          <form action={createEnvironmentAction} className="engineering-editor">
            <EngineeringFields
              engineeringId={engineeringId}
              projectId={projectId}
            />
            <label>
              <span>环境名称</span>
              <input name="name" required />
            </label>
            <DeploymentFields />
            <div className="dialog-actions">
              <button type="submit">创建测试环境</button>
            </div>
          </form>
        ) : null}
      </section>

      <section className="engineering-detail__bindings">
        <div className="collaboration-section-title">
          <span>本机 Runner Binding</span>
          <small>{bindings.length}</small>
        </div>
        <ul>
          {bindings.map(({ binding, runner, user }) => (
            <li key={binding.id}>
              <span>
                <strong>{runner.name}</strong>
                <small>{user.displayName}</small>
              </span>
              <em>{binding.id}</em>
            </li>
          ))}
        </ul>
        {assigned.has(userId) && runners.length ? (
          <form
            action={createEngineeringBindingAction}
            className="engineering-binding-form"
          >
            <EngineeringFields
              engineeringId={engineeringId}
              projectId={projectId}
            />
            <select name="runnerId" required>
              {runners.map(({ runner }) => (
                <option key={runner.id} value={runner.id}>
                  {runner.name}
                </option>
              ))}
            </select>
            <button type="submit">创建 Binding</button>
          </form>
        ) : (
          <div className="collab-form__blocked">
            <div>
              <strong>需要先配对本机 Runner</strong>
              <p>配对完成后再为当前工程建立 Binding。</p>
            </div>
            <Link href="/cooking/runners">Runner 管理</Link>
          </div>
        )}
      </section>

      {owner && !workspace.engineering.archivedAt ? (
        <form
          action={archiveEngineeringAction}
          className="engineering-detail__actions"
        >
          <EngineeringFields
            engineeringId={engineeringId}
            projectId={projectId}
          />
          <input
            name="expectedVersion"
            type="hidden"
            value={workspace.engineering.version}
          />
          <button type="submit">归档工程</button>
        </form>
      ) : null}
    </div>
  );
}

function Dialog({
  children,
  kicker,
  title,
}: {
  children: React.ReactNode;
  kicker: string;
  title: string;
}) {
  return (
    <div
      className="repair-overlay engineering-catalog-overlay"
      role="presentation"
    >
      <section
        aria-modal="true"
        className="bug-dialog engineering-catalog-dialog"
        role="dialog"
      >
        <header className="engineering-dialog__header">
          <div>
            <p className="repair-kicker">{kicker}</p>
            <h2>{title}</h2>
          </div>
          <Link
            aria-label={`关闭${title}`}
            className="engineering-dialog__close"
            href="/cooking/projects"
          >
            ×
          </Link>
        </header>
        {children}
      </section>
    </div>
  );
}

function InvitationForm({
  decision,
  invitationId,
  label,
  version,
}: {
  decision: 'ACCEPT' | 'REJECT';
  invitationId: string;
  label: string;
  version: number;
}) {
  return (
    <form action={respondProjectInvitationAction}>
      <input name="mutationId" type="hidden" value={randomUUID()} />
      <input name="invitationId" type="hidden" value={invitationId} />
      <input name="expectedVersion" type="hidden" value={version} />
      <input name="decision" type="hidden" value={decision} />
      <button type="submit">{label}</button>
    </form>
  );
}

function ProjectFields({ projectId }: { projectId: string }) {
  return (
    <>
      <input name="mutationId" type="hidden" value={randomUUID()} />
      <input name="projectId" type="hidden" value={projectId} />
    </>
  );
}

function EngineeringFields({
  engineeringId,
  projectId,
}: {
  engineeringId: string;
  projectId: string;
}) {
  return (
    <>
      <ProjectFields projectId={projectId} />
      <input name="engineeringId" type="hidden" value={engineeringId} />
    </>
  );
}

function settingsHref(
  projectId: string,
  panel: 'collaboration' | 'engineering',
): string {
  return `/cooking/projects?project=${encodeURIComponent(projectId)}&panel=${panel}`;
}

function engineeringHref(projectId: string, engineeringId: string): string {
  return `${settingsHref(projectId, 'engineering')}&engineering=${encodeURIComponent(engineeringId)}`;
}

function invitationStatus(status: string): string {
  return (
    {
      PENDING: '等待处理',
      ACCEPTED: '已接受',
      REJECTED: '已拒绝',
      REVOKED: '已撤销',
    }[status] ?? '未知状态'
  );
}
