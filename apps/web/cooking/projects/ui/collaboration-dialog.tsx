import Link from 'next/link';
import { projectService } from '@/cooking/runtime/services';
import type { ReceivedProjectInvitation } from '@/cooking/projects/contract';
import {
  inviteProjectUserAction,
  removeProjectMemberAction,
  revokeProjectInvitationAction,
  updateProjectAction,
} from '@/cooking/projects/server/actions';
import { ProjectDialogEffects } from './project-dialog-effects';
import { Dialog } from './dialog';
import { DialogFeedback, ProjectFields } from './settings-fields';

import { invitationStatus } from './settings-links';
import { InvitationForm } from './invitation-form';

export function CollaborationDialog({
  error,
  projectId,
  success,
  userId,
}: {
  error?: string;
  projectId: string;
  success?: string;
  userId: string;
}) {
  const projects = projectService();
  const summary = projects.getProject(userId, projectId);
  const members = projects.listMembers(userId, projectId);
  const owner = summary.membership.role === 'OWNER';
  const invitations = owner
    ? projects.listProjectInvitations(userId, projectId)
    : [];
  const pendingInvitations = invitations.filter(
    ({ invitation }) => invitation.status === 'PENDING',
  );
  return (
    <Dialog
      className="project-collaboration-dialog"
      title={`${summary.project.name} · 成员与邀请`}
      kicker="私密项目"
      overlayClassName=""
    >
      <DialogFeedback error={error} success={success} />
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

        {owner ? (
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
                  </article>
                ))}
              </div>
            ) : (
              <p className="collaboration-empty">没有待处理邀请。</p>
            )}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}

export function ProjectSettingsDialog({
  error,
  projectId,
  success,
  userId,
}: {
  error?: string;
  projectId: string;
  success?: string;
  userId: string;
}) {
  const summary = projectService().getProject(userId, projectId);
  if (summary.membership.role !== 'OWNER') return null;
  return (
    <Dialog
      className="project-name-dialog"
      kicker="项目基础信息"
      overlayClassName=""
      title={`${summary.project.name} · 项目设置`}
    >
      <DialogFeedback error={error} success={success} />
      <form action={updateProjectAction}>
        <ProjectFields projectId={projectId} />
        <input
          name="expectedVersion"
          type="hidden"
          value={summary.project.version}
        />
        <label>
          <span>项目名称</span>
          <input
            autoComplete="off"
            defaultValue={summary.project.name}
            maxLength={120}
            name="name"
            required
          />
          <small>项目名称会展示在项目列表、成员协作和工程目录中。</small>
        </label>
        <div className="dialog-actions">
          <Link href="/cooking/projects">取消</Link>
          <button className="repair-primary" type="submit">
            保存项目名称
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function InvitationDialog({
  error,
  invitations,
  success,
}: {
  error?: string;
  invitations: ReceivedProjectInvitation[];
  success?: string;
}) {
  return (
    <div className="repair-overlay" role="presentation">
      <section
        aria-labelledby="project-inbox-title"
        aria-modal="true"
        className="bug-dialog project-inbox-dialog"
        role="dialog"
        tabIndex={-1}
      >
        <ProjectDialogEffects closeHref="/cooking/projects" />
        <header>
          <div>
            <p className="repair-kicker">项目邀请</p>
            <h2 id="project-inbox-title">项目邀请</h2>
          </div>
          <Link aria-label="关闭项目邀请" href="/cooking/projects">
            ×
          </Link>
        </header>
        <DialogFeedback error={error} success={success} />
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
