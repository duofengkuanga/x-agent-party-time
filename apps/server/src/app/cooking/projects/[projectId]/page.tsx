import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCurrentUser } from '@/platform/auth/server';
import { PlatformError } from '@/platform/errors';
import { projectService } from '@/modules/cooking/projects/application/server';
import {
  inviteProjectUserAction,
  removeProjectMemberAction,
  revokeProjectInvitationAction,
  updateProjectAction,
} from '@/modules/cooking/projects/presentation/actions';

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const user = await requireCurrentUser();
  const { projectId } = await params;
  const service = projectService();
  let summary;
  let members;
  try {
    summary = service.getProject(user.id, projectId);
    members = service.listMembers(user.id, projectId);
  } catch (error) {
    if (error instanceof PlatformError && error.code === 'NOT_FOUND')
      notFound();
    throw error;
  }
  const invitations =
    summary.membership.role === 'OWNER'
      ? service.listProjectInvitations(user.id, projectId)
      : [];
  const message = await searchParams;

  return (
    <main className="workspace-page">
      <header className="workspace-header">
        <div>
          <Link className="back-link" href="/cooking">
            返回项目工作台
          </Link>
          <span className="eyebrow">
            {summary.membership.role === 'OWNER' ? '项目所有者' : '项目成员'}
          </span>
          <h1>{summary.project.name}</h1>
          <p>成员和邀请只对项目内用户可见。</p>
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
              <span className="eyebrow">访问成员</span>
              <h2>项目成员</h2>
            </div>
            <span className="count-badge">{members.length}</span>
          </div>
          <ul className="card-list">
            {members.map(({ membership, user: member }) => (
              <li className="list-card" key={member.id}>
                <div>
                  <h3>{member.displayName}</h3>
                  <p>
                    @{member.username} ·{' '}
                    {membership.role === 'OWNER' ? '项目所有者' : '项目成员'}
                  </p>
                </div>
                {summary.membership.role === 'OWNER' ? (
                  <form action={removeProjectMemberAction}>
                    <input
                      name="mutationId"
                      type="hidden"
                      value={randomUUID()}
                    />
                    <input name="projectId" type="hidden" value={projectId} />
                    <input name="userId" type="hidden" value={member.id} />
                    <input
                      name="expectedVersion"
                      type="hidden"
                      value={membership.version}
                    />
                    <button type="submit">
                      {membership.role === 'OWNER' ? '移除所有者' : '移除成员'}
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        {summary.membership.role === 'OWNER' ? (
          <aside className="panel compact-panel">
            <span className="eyebrow">所有者操作</span>
            <h2>项目设置</h2>
            <form action={updateProjectAction} className="stack-form">
              <input name="mutationId" type="hidden" value={randomUUID()} />
              <input name="projectId" type="hidden" value={projectId} />
              <input
                name="expectedVersion"
                type="hidden"
                value={summary.project.version}
              />
              <label>
                项目名称
                <input
                  defaultValue={summary.project.name}
                  maxLength={120}
                  name="name"
                  required
                />
              </label>
              <button type="submit">保存项目名称</button>
            </form>
            <hr />
            <form action={inviteProjectUserAction} className="stack-form">
              <input name="mutationId" type="hidden" value={randomUUID()} />
              <input name="projectId" type="hidden" value={projectId} />
              <label>
                邀请用户名
                <input autoComplete="off" name="username" required />
              </label>
              <button type="submit">发送邀请</button>
            </form>
          </aside>
        ) : null}
      </div>

      {summary.membership.role === 'OWNER' ? (
        <section className="panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">等待响应</span>
              <h2>待处理邀请</h2>
            </div>
            <span className="count-badge">{invitations.length}</span>
          </div>
          {invitations.length ? (
            <ul className="card-list">
              {invitations.map(({ invitation, invitedUser }) => (
                <li className="list-card" key={invitation.id}>
                  <div>
                    <h3>{invitedUser.displayName}</h3>
                    <p>@{invitedUser.username}</p>
                  </div>
                  <form action={revokeProjectInvitationAction}>
                    <input
                      name="mutationId"
                      type="hidden"
                      value={randomUUID()}
                    />
                    <input name="projectId" type="hidden" value={projectId} />
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
                    <button type="submit">撤销邀请</button>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">没有等待响应的邀请。</p>
          )}
        </section>
      ) : null}
    </main>
  );
}
