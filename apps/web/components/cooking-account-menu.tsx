'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import type { ProjectInvitationSummary } from '@agent-party-time/shared/control-plane';
import type { CurrentUser } from '@/lib/auth/core';

export function CookingAccountMenu({
  currentUser,
  currentArea,
  onProjectInvitationsChanged,
}: {
  currentUser: CurrentUser;
  currentArea: 'workspace' | 'projects';
  onProjectInvitationsChanged?: () => Promise<void>;
}) {
  const isDeveloper = currentUser.accountType === 'DEVELOPER';
  const [invitations, setInvitations] = useState<ProjectInvitationSummary[]>(
    [],
  );
  const [loadingInvitations, setLoadingInvitations] = useState(isDeveloper);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [respondingInvitationId, setRespondingInvitationId] = useState<
    string | null
  >(null);
  const [responding, startResponding] = useTransition();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const loadInvitations = useCallback(async () => {
    if (!isDeveloper) return;
    const response = await fetch('/api/control-plane/project-invitations', {
      cache: 'no-store',
    });
    const result = (await response.json()) as {
      items?: ProjectInvitationSummary[];
      error?: string;
    };
    if (!response.ok) throw new Error(result.error ?? '无法读取项目邀请');
    setInvitations(result.items ?? []);
    setInvitationError(null);
  }, [isDeveloper]);

  useEffect(() => {
    if (!isDeveloper) return;
    void loadInvitations()
      .catch((error) =>
        setInvitationError(messageOf(error, '无法读取项目邀请')),
      )
      .finally(() => setLoadingInvitations(false));
    const timer = window.setInterval(() => {
      void loadInvitations().catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [isDeveloper, loadInvitations]);

  useEffect(() => {
    if (!menuOpen) return;

    function closeOnPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false);
    }

    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  const pendingInvitations = invitations.filter(
    (invitation) => invitation.status === 'PENDING',
  );

  function respond(invitationId: string, action: 'ACCEPT' | 'REJECT') {
    setRespondingInvitationId(invitationId);
    startResponding(async () => {
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
        if (!response.ok) throw new Error(result.error ?? '无法处理项目邀请');
        await Promise.all([
          loadInvitations(),
          onProjectInvitationsChanged?.() ?? Promise.resolve(),
        ]);
        setInvitationError(null);
      } catch (error) {
        setInvitationError(messageOf(error, '无法处理项目邀请'));
      } finally {
        setRespondingInvitationId(null);
      }
    });
  }

  return (
    <div
      className={`collab-account-menu${menuOpen ? ' collab-account-menu--open' : ''}`}
      ref={menuRef}
    >
      <button
        aria-expanded={menuOpen}
        aria-haspopup="true"
        aria-label={
          pendingInvitations.length > 0
            ? `打开账号菜单，有 ${pendingInvitations.length} 条待处理邀请`
            : '打开账号菜单'
        }
        className="account-badge"
        onClick={() => setMenuOpen((current) => !current)}
        type="button"
      >
        <span className="account-badge__copy">
          <strong>{currentUser.displayName}</strong>
          <small>{isDeveloper ? '开发人员' : '测试人员'}</small>
        </span>
        {pendingInvitations.length > 0 ? (
          <span className="collab-account-menu__count">
            {pendingInvitations.length > 9 ? '9+' : pendingInvitations.length}
          </span>
        ) : null}
      </button>
      <div className="collab-account-menu__panel" hidden={!menuOpen}>
        {isDeveloper ? (
          <section className="collab-account-menu__notifications">
            <header>
              <span>项目邀请</span>
              {pendingInvitations.length > 0 ? (
                <small>{pendingInvitations.length} 条待处理</small>
              ) : null}
            </header>
            {invitationError ? (
              <p className="collab-account-menu__error" role="alert">
                {invitationError}
              </p>
            ) : loadingInvitations ? (
              <p className="collab-account-menu__empty">正在读取邀请…</p>
            ) : pendingInvitations.length > 0 ? (
              <div className="collab-account-menu__invitation-list">
                {pendingInvitations.map((invitation) => (
                  <article key={invitation.id}>
                    <span>
                      {invitation.invitedBy.displayName} 邀请你加入项目
                    </span>
                    <strong>{invitation.projectTitle}</strong>
                    <p>接受后，你可以参与该项目的工程配置与提测协作。</p>
                    <div>
                      <button
                        disabled={responding}
                        onClick={() => respond(invitation.id, 'REJECT')}
                        type="button"
                      >
                        {respondingInvitationId === invitation.id && responding
                          ? '处理中…'
                          : '拒绝'}
                      </button>
                      <button
                        className="collab-account-menu__accept"
                        disabled={responding}
                        onClick={() => respond(invitation.id, 'ACCEPT')}
                        type="button"
                      >
                        {respondingInvitationId === invitation.id && responding
                          ? '处理中…'
                          : '接受'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="collab-account-menu__empty">暂无待处理邀请。</p>
            )}
          </section>
        ) : null}
        <nav aria-label="账号导航" className="collab-account-menu__navigation">
          <span>工作区</span>
          {currentArea !== 'workspace' ? (
            <Link href="/cooking">提测工作台</Link>
          ) : null}
          {isDeveloper && currentArea !== 'projects' ? (
            <Link href="/cooking/projects">项目与工程</Link>
          ) : null}
        </nav>
        <form action="/api/auth/logout" method="post">
          <button type="submit">退出登录</button>
        </form>
      </div>
    </div>
  );
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
