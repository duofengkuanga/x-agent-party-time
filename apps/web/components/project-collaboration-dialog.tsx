'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
  type FormEvent,
} from 'react';
import type {
  ProjectAuditEventSummary,
  ProjectInvitationSummary,
  ProjectMemberSummary,
  ProjectSummary,
} from '@agent-party-time/shared/control-plane';
import type { CurrentUser } from '@/lib/auth/core';

interface CollaborationPayload {
  members: ProjectMemberSummary[];
  invitations: ProjectInvitationSummary[];
  auditEvents: ProjectAuditEventSummary[];
}

export function ProjectCollaborationDialog({
  project,
  currentUser,
  developers,
  onClose,
  onChanged,
}: {
  project: ProjectSummary;
  currentUser: CurrentUser;
  developers: CurrentUser[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [data, setData] = useState<CollaborationPayload | null>(null);
  const [inviteeUserId, setInviteeUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    const response = await fetch(
      `/api/control-plane/projects/${project.id}/collaboration`,
      { cache: 'no-store' },
    );
    const result = (await response.json()) as CollaborationPayload & {
      error?: string;
    };
    if (!response.ok) throw new Error(result.error ?? '无法读取项目成员');
    setData(result);
  }, [project.id]);

  useEffect(() => {
    void load().catch((requestError) =>
      setError(messageOf(requestError, '无法读取项目成员')),
    );
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const eligibleDevelopers = useMemo(() => {
    const memberIds = new Set(data?.members.map((member) => member.user.id));
    const pendingIds = new Set(
      data?.invitations
        .filter((invitation) => invitation.status === 'PENDING')
        .map((invitation) => invitation.invitee.id),
    );
    return developers.filter(
      (developer) =>
        developer.id !== currentUser.id &&
        !memberIds.has(developer.id) &&
        !pendingIds.has(developer.id),
    );
  }, [currentUser.id, data, developers]);

  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inviteeUserId) return;
    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/control-plane/projects/${project.id}/collaboration`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `web-project-invite:${crypto.randomUUID()}`,
            },
            body: JSON.stringify({ inviteeUserId }),
          },
        );
        const result = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(result.error ?? '邀请创建失败');
        setInviteeUserId('');
        setError(null);
        await load();
      } catch (requestError) {
        setError(messageOf(requestError, '邀请创建失败'));
      }
    });
  }

  function remove(kind: 'invitation' | 'member', id: string) {
    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/control-plane/projects/${project.id}/collaboration`,
          {
            method: 'DELETE',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `web-project-collaboration:${crypto.randomUUID()}`,
            },
            body: JSON.stringify(
              kind === 'invitation'
                ? { kind, invitationId: id }
                : { kind, userId: id },
            ),
          },
        );
        const result = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(result.error ?? '成员更新失败');
        setError(null);
        await Promise.all([load(), onChanged()]);
      } catch (requestError) {
        setError(messageOf(requestError, '成员更新失败'));
      }
    });
  }

  const isOwner = project.memberRole === 'OWNER';
  const pendingInvitations =
    data?.invitations.filter((invitation) => invitation.status === 'PENDING') ??
    [];

  return (
    <div className="repair-overlay" role="presentation">
      <section
        aria-labelledby="project-collaboration-title"
        aria-modal="true"
        className="bug-dialog project-collaboration-dialog"
        role="dialog"
      >
        <header>
          <div>
            <p className="repair-kicker">私密项目</p>
            <h2 id="project-collaboration-title">
              {project.title ?? project.slug} · 成员与邀请
            </h2>
          </div>
          <button aria-label="关闭" onClick={onClose} type="button">
            ×
          </button>
        </header>

        {error ? <p className="form-error">{error}</p> : null}
        {!data ? (
          <p className="collaboration-loading">正在读取成员关系…</p>
        ) : (
          <div className="collaboration-ledger">
            <section>
              <div className="collaboration-section-title">
                <span>项目成员</span>
                <small>{data.members.length} 人</small>
              </div>
              <div className="collaboration-member-list">
                {data.members.map((member) => (
                  <article
                    className="collaboration-member"
                    key={member.user.id}
                  >
                    <span aria-hidden="true">
                      {member.user.displayName.slice(0, 1)}
                    </span>
                    <div>
                      <strong>{member.user.displayName}</strong>
                      <small>@{member.user.username}</small>
                    </div>
                    <em>
                      {member.role === 'OWNER' ? '项目负责人' : '开发成员'}
                    </em>
                    {isOwner && member.role === 'DEVELOPER' ? (
                      <button
                        disabled={pending}
                        onClick={() => remove('member', member.user.id)}
                        type="button"
                      >
                        移除
                      </button>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>

            {isOwner ? (
              <section>
                <div className="collaboration-section-title">
                  <span>邀请开发人员</span>
                  <small>仅限已注册开发账号</small>
                </div>
                <form className="collaboration-invite-form" onSubmit={invite}>
                  <select
                    aria-label="选择开发人员"
                    onChange={(event) => setInviteeUserId(event.target.value)}
                    value={inviteeUserId}
                  >
                    <option value="">选择开发人员…</option>
                    {eligibleDevelopers.map((developer) => (
                      <option key={developer.id} value={developer.id}>
                        {developer.displayName} · @{developer.username}
                      </option>
                    ))}
                  </select>
                  <button
                    className="repair-primary"
                    disabled={!inviteeUserId || pending}
                    type="submit"
                  >
                    发出邀请
                  </button>
                </form>
                {eligibleDevelopers.length === 0 ? (
                  <p className="collaboration-empty">
                    当前没有可邀请的开发人员。
                  </p>
                ) : null}
              </section>
            ) : null}

            <section>
              <div className="collaboration-section-title">
                <span>待处理邀请</span>
                <small>{pendingInvitations.length} 条</small>
              </div>
              {pendingInvitations.length ? (
                <div className="collaboration-invitation-list">
                  {pendingInvitations.map((invitation) => (
                    <article key={invitation.id}>
                      <div>
                        <strong>{invitation.invitee.displayName}</strong>
                        <small>@{invitation.invitee.username}</small>
                      </div>
                      <span>等待接受</span>
                      {isOwner ? (
                        <button
                          disabled={pending}
                          onClick={() => remove('invitation', invitation.id)}
                          type="button"
                        >
                          撤销
                        </button>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="collaboration-empty">没有待处理邀请。</p>
              )}
            </section>

            <section>
              <div className="collaboration-section-title">
                <span>变更记录</span>
                <small>不可变更</small>
              </div>
              <ol className="collaboration-audit-list">
                {data.auditEvents.map((event) => (
                  <li key={event.id}>
                    <span>{auditLabel(event.type)}</span>
                    <time>{formatTime(event.createdAt)}</time>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

export function ProjectInvitationInbox({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [invitations, setInvitations] = useState<ProjectInvitationSummary[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    const response = await fetch('/api/control-plane/project-invitations', {
      cache: 'no-store',
    });
    const result = (await response.json()) as {
      items?: ProjectInvitationSummary[];
      error?: string;
    };
    if (!response.ok) throw new Error(result.error ?? '无法读取项目邀请');
    setInvitations(result.items ?? []);
  }, []);

  useEffect(() => {
    void load()
      .catch((requestError) =>
        setError(messageOf(requestError, '无法读取项目邀请')),
      )
      .finally(() => setLoading(false));
  }, [load]);

  function respond(invitationId: string, action: 'ACCEPT' | 'REJECT') {
    startTransition(async () => {
      try {
        const response = await fetch('/api/control-plane/project-invitations', {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `web-project-invitation-response:${crypto.randomUUID()}`,
          },
          body: JSON.stringify({ invitationId, action }),
        });
        const result = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(result.error ?? '无法处理邀请');
        setError(null);
        await Promise.all([load(), onChanged()]);
      } catch (requestError) {
        setError(messageOf(requestError, '无法处理邀请'));
      }
    });
  }

  return (
    <div className="repair-overlay" role="presentation">
      <section
        aria-labelledby="project-inbox-title"
        aria-modal="true"
        className="bug-dialog project-inbox-dialog"
        role="dialog"
      >
        <header>
          <div>
            <p className="repair-kicker">项目邀请</p>
            <h2 id="project-inbox-title">项目邀请</h2>
          </div>
          <button aria-label="关闭" onClick={onClose} type="button">
            ×
          </button>
        </header>
        {error ? <p className="form-error">{error}</p> : null}
        {loading ? (
          <p className="collaboration-loading">正在读取邀请…</p>
        ) : invitations.length ? (
          <div className="project-inbox-list">
            {invitations.map((invitation) => (
              <article key={invitation.id}>
                <div>
                  <small>{invitation.projectSlug}</small>
                  <strong>{invitation.projectTitle}</strong>
                  <span>邀请人：{invitation.invitedBy.displayName}</span>
                </div>
                <em>{invitationStatus(invitation.status)}</em>
                {invitation.status === 'PENDING' ? (
                  <div>
                    <button
                      disabled={pending}
                      onClick={() => respond(invitation.id, 'REJECT')}
                      type="button"
                    >
                      拒绝
                    </button>
                    <button
                      className="repair-primary"
                      disabled={pending}
                      onClick={() => respond(invitation.id, 'ACCEPT')}
                      type="button"
                    >
                      接受邀请
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
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

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function invitationStatus(status: ProjectInvitationSummary['status']) {
  return {
    PENDING: '待处理',
    ACCEPTED: '已接受',
    REJECTED: '已拒绝',
    REVOKED: '已撤销',
  }[status];
}

function auditLabel(type: ProjectAuditEventSummary['type']) {
  return {
    'project.created': '项目已创建',
    'project.invitation_created': '已发出开发人员邀请',
    'project.invitation_accepted': '开发人员已接受邀请',
    'project.invitation_rejected': '开发人员已拒绝邀请',
    'project.invitation_revoked': '项目邀请已撤销',
    'project.member_removed': '开发人员已移出项目',
  }[type];
}
