import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { requireCurrentUser } from '@/server/auth/server';
import { runnerService } from '@/server/runner/server';
import {
  bindingService,
  engineeringService,
  projectService,
} from '@/features/cooking/application/server';
import { createEngineeringBindingAction } from '@/features/cooking/bindings/presentation/actions';
import {
  addEngineeringMemberAction,
  archiveEngineeringAction,
  createEngineeringAction,
  createEnvironmentAction,
  deleteEnvironmentAction,
  removeEngineeringMemberAction,
  updateEngineeringAction,
  updateEnvironmentAction,
} from '@/features/cooking/engineering/presentation/actions';
import { DeploymentFields } from '@/features/cooking/engineering/presentation/deployment-fields';
import type { ReceivedProjectInvitation } from '@/features/cooking/projects/contract';
import {
  inviteProjectUserAction,
  removeProjectMemberAction,
  respondProjectInvitationAction,
  revokeProjectInvitationAction,
  updateProjectAction,
} from '@/features/cooking/projects/presentation/actions';
import { ProjectSettingsControls } from './project-settings-controls';

export default async function ProjectSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    engineering?: string;
    error?: string;
    mode?: string;
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
    <>
      <ProjectSettingsControls
        error={query.error}
        hasProjects={projects.length > 0}
        mutationId={randomUUID()}
        success={query.success}
      >
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
                  成员
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
      </ProjectSettingsControls>

      {panel === 'invitations' ? (
        <InvitationDialog invitations={invitations} />
      ) : null}
      {selected && panel === 'collaboration' ? (
        <CollaborationDialog projectId={selected.project.id} userId={user.id} />
      ) : null}
      {selected && panel === 'engineering' ? (
        <EngineeringDialog
          engineeringId={query.engineering}
          mode={query.mode}
          projectId={selected.project.id}
          userId={user.id}
        />
      ) : null}
    </>
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
  const pendingInvitations = invitations.filter(
    ({ invitation }) => invitation.status === 'PENDING',
  );
  const owner = summary.membership.role === 'OWNER';
  return (
    <Dialog
      className="project-collaboration-dialog"
      title={`${summary.project.name} · 成员`}
      kicker="私密项目"
      overlayClassName=""
    >
      <div className="collaboration-ledger">
        <section>
          <div className="collaboration-section-title">
            <span>项目成员</span>
            <small>{members.length} 人</small>
          </div>
          <div className="collaboration-member-list">
            {members.map(({ membership, user }) => (
              <article className="collaboration-member" key={user.id}>
                <span aria-hidden="true">{user.displayName.slice(0, 1)}</span>
                <div>
                  <strong>{user.displayName}</strong>
                  <small>@{user.username}</small>
                </div>
                <em>
                  {membership.role === 'OWNER' ? '项目负责人' : '项目成员'}
                </em>
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
              </article>
            ))}
          </div>
        </section>

        {owner ? (
          <section>
            <div className="collaboration-section-title">
              <span>邀请成员</span>
              <small>仅限已注册用户</small>
            </div>
            <form
              action={inviteProjectUserAction}
              className="collaboration-invite-form"
            >
              <ProjectFields projectId={projectId} />
              <input
                aria-label="受邀用户名"
                maxLength={80}
                name="username"
                placeholder="输入用户名"
                required
              />
              <button className="repair-primary" type="submit">
                发出邀请
              </button>
            </form>
          </section>
        ) : null}

        <section>
          <div className="collaboration-section-title">
            <span>待处理邀请</span>
            <small>{pendingInvitations.length} 条</small>
          </div>
          {pendingInvitations.length ? (
            <div className="collaboration-invitation-list">
              {pendingInvitations.map(({ invitation, invitedUser }) => (
                <article key={invitation.id}>
                  <div>
                    <strong>{invitedUser.displayName}</strong>
                    <small>@{invitedUser.username}</small>
                  </div>
                  <span>等待接受</span>
                  {owner ? (
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
                </article>
              ))}
            </div>
          ) : (
            <p className="collaboration-empty">没有待处理邀请。</p>
          )}
        </section>

        {owner ? (
          <section>
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

function InvitationDialog({
  invitations,
}: {
  invitations: ReceivedProjectInvitation[];
}) {
  return (
    <div className="repair-overlay" role="presentation">
      <section
        aria-modal="true"
        className="bug-dialog project-inbox-dialog"
        role="dialog"
      >
        <header>
          <div>
            <p className="repair-kicker">项目邀请</p>
            <h2>项目邀请</h2>
          </div>
          <Link aria-label="关闭项目邀请" href="/cooking/projects">
            ×
          </Link>
        </header>
        {invitations.length ? (
          <div className="project-inbox-list">
            {invitations.map(
              ({ invitation, invitedByDisplayName, projectName }) => (
                <article key={invitation.id}>
                  <div>
                    <strong>{projectName}</strong>
                    <span>邀请人：{invitedByDisplayName}</span>
                  </div>
                  <em>{invitationStatus(invitation.status)}</em>
                  {invitation.status === 'PENDING' ? (
                    <div>
                      <InvitationForm
                        decision="REJECT"
                        invitationId={invitation.id}
                        label="拒绝"
                        version={invitation.version}
                      />
                      <InvitationForm
                        decision="ACCEPT"
                        invitationId={invitation.id}
                        label="接受邀请"
                        version={invitation.version}
                      />
                    </div>
                  ) : null}
                </article>
              ),
            )}
          </div>
        ) : (
          <p className="collaboration-empty collaboration-empty--large">
            暂时没有项目邀请。
          </p>
        )}
      </section>
    </div>
  );
}

function EngineeringDialog({
  engineeringId,
  mode,
  projectId,
  userId,
}: {
  engineeringId?: string;
  mode?: string;
  projectId: string;
  userId: string;
}) {
  const projects = projectService();
  const engineering = engineeringService();
  const project = projects.getProject(userId, projectId);
  const items = engineering.listEngineering(userId, projectId);
  const members = projects.listMembers(userId, projectId);
  const selected =
    engineeringId && engineeringId !== 'new'
      ? items.find((candidate) => candidate.id === engineeringId)
      : undefined;
  const owner = project.membership.role === 'OWNER';

  return (
    <Dialog title="工程目录" kicker={project.project.name}>
      {engineeringId === 'new' && owner ? (
        <EngineeringCreateForm projectId={projectId} />
      ) : selected ? (
        <EngineeringDetail
          editing={mode === 'edit'}
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
            {owner ? (
              <Link
                className="repair-primary"
                href={engineeringCreateHref(projectId)}
              >
                新建工程
              </Link>
            ) : null}
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
                  <small>
                    {item.repositoryState === 'CONFIRMED'
                      ? item.repositoryUrl
                      : '等待首次本机 Binding 确认仓库'}
                  </small>
                </Link>
              ))}
            </div>
          </section>
        </div>
      )}
    </Dialog>
  );
}

function EngineeringCreateForm({ projectId }: { projectId: string }) {
  return (
    <form action={createEngineeringAction} className="engineering-editor">
      <div className="engineering-editor__heading">
        <div>
          <strong>新建工程</strong>
          <small>工程创建后再配置成员、环境与 Runner Binding。</small>
        </div>
        <Link href={settingsHref(projectId, 'engineering')}>取消</Link>
      </div>
      <ProjectFields projectId={projectId} />
      <div className="engineering-editor__grid">
        <label>
          <span>工程名称</span>
          <input maxLength={120} name="name" required />
        </label>
      </div>
      <div className="dialog-actions">
        <Link href={settingsHref(projectId, 'engineering')}>返回目录</Link>
        <button className="repair-primary" type="submit">
          创建工程
        </button>
      </div>
    </form>
  );
}

function EngineeringDetail({
  editing,
  engineeringId,
  owner,
  projectId,
  projectMembers,
  userId,
}: {
  editing: boolean;
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
          <small>
            {workspace.engineering.repositoryState === 'CONFIRMED'
              ? workspace.engineering.repositoryUrl
              : '等待首次本机 Binding 确认仓库'}
          </small>
        </div>
        <Link href={settingsHref(projectId, 'engineering')}>返回工程列表</Link>
      </div>

      {owner && editing ? (
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
              {owner && editing ? (
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
        {owner && editing && availableMembers.length ? (
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
            {owner && editing ? (
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
            ) : (
              <div>
                <strong>{environment.name}</strong>
                <small>{deploymentLabel(environment.deployment.kind)}</small>
                {'command' in environment.deployment ? (
                  <code>{environment.deployment.command}</code>
                ) : null}
              </div>
            )}
            {owner && editing ? (
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
        {owner && editing ? (
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

      <div className="dialog-actions engineering-detail__actions">
        <Link href={settingsHref(projectId, 'engineering')}>返回目录</Link>
        {owner ? (
          <Link
            className="repair-primary"
            href={
              editing
                ? engineeringHref(projectId, engineeringId)
                : engineeringEditHref(projectId, engineeringId)
            }
          >
            {editing ? '完成编辑' : '编辑配置'}
          </Link>
        ) : null}
        {owner && !workspace.engineering.archivedAt ? (
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
            <button type="submit">归档工程</button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

function Dialog({
  children,
  className = 'engineering-catalog-dialog',
  kicker,
  overlayClassName = 'engineering-catalog-overlay',
  title,
}: {
  children: React.ReactNode;
  className?: string;
  kicker: string;
  overlayClassName?: string;
  title: string;
}) {
  return (
    <div className={`repair-overlay ${overlayClassName}`} role="presentation">
      <section
        aria-modal="true"
        className={`bug-dialog ${className}`}
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

function engineeringCreateHref(projectId: string): string {
  return engineeringHref(projectId, 'new');
}

function engineeringEditHref(projectId: string, engineeringId: string): string {
  return `${engineeringHref(projectId, engineeringId)}&mode=edit`;
}

function deploymentLabel(kind: 'LOCAL_SCRIPT' | 'CI_CD'): string {
  return kind === 'LOCAL_SCRIPT' ? '本地脚本' : '持续集成';
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
