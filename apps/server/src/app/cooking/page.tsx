import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { logoutAction } from '@/app/logout/action';
import { requireCurrentUser } from '@/platform/auth/server';
import { projectService } from '@/modules/cooking/application/server';
import {
  createProjectAction,
  respondProjectInvitationAction,
} from '@/modules/cooking/projects/presentation/actions';

export default async function CookingHomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const user = await requireCurrentUser();
  const service = projectService();
  const [projects, invitations, message] = await Promise.all([
    Promise.resolve(service.listProjects(user.id)),
    Promise.resolve(service.listReceivedInvitations(user.id)),
    searchParams,
  ]);

  return (
    <main className="workspace-page">
      <header className="workspace-header">
        <div>
          <span className="eyebrow">协作提测</span>
          <h1>项目工作台</h1>
          <p>你好，{user.displayName}。这里只显示你已经加入的私密项目。</p>
        </div>
        <form action={logoutAction}>
          <button type="submit">退出登录</button>
        </form>
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
              <span className="eyebrow">我的项目</span>
              <h2>私密项目</h2>
            </div>
            <span className="count-badge">{projects.length}</span>
          </div>
          {projects.length ? (
            <ul className="card-list">
              {projects.map(({ project, membership }) => (
                <li className="list-card" key={project.id}>
                  <div>
                    <h3>{project.name}</h3>
                    <p>
                      {membership.role === 'OWNER' ? '项目所有者' : '项目成员'}
                    </p>
                  </div>
                  <Link
                    className="button-link"
                    href={`/cooking/projects/${project.id}`}
                  >
                    打开项目
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">
              还没有项目。创建后，你会自动成为项目所有者。
            </p>
          )}
        </section>

        <aside className="panel compact-panel">
          <span className="eyebrow">创建项目</span>
          <h2>建立新的私密空间</h2>
          <form action={createProjectAction} className="stack-form">
            <input name="mutationId" type="hidden" value={randomUUID()} />
            <label>
              项目名称
              <input maxLength={120} name="name" required />
            </label>
            <button type="submit">创建项目</button>
          </form>
        </aside>
      </div>

      <section className="panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">待处理</span>
            <h2>项目邀请</h2>
          </div>
          <span className="count-badge">{invitations.length}</span>
        </div>
        {invitations.length ? (
          <ul className="card-list">
            {invitations.map(
              ({ invitation, projectName, invitedByDisplayName }) => (
                <li className="list-card" key={invitation.id}>
                  <div>
                    <h3>{projectName}</h3>
                    <p>{invitedByDisplayName} 邀请你加入这个项目。</p>
                  </div>
                  <div className="button-row">
                    <InvitationResponseForm
                      decision="ACCEPT"
                      invitationId={invitation.id}
                      label="接受邀请"
                      version={invitation.version}
                    />
                    <InvitationResponseForm
                      decision="REJECT"
                      invitationId={invitation.id}
                      label="拒绝邀请"
                      version={invitation.version}
                    />
                  </div>
                </li>
              ),
            )}
          </ul>
        ) : (
          <p className="empty-state">当前没有待处理邀请。</p>
        )}
      </section>
    </main>
  );
}

function InvitationResponseForm({
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
