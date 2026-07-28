'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { User } from '@/server/auth/contract';
import { logoutAction } from '@/server/auth/logout-action';

type Theme = 'paper' | 'night';

export function CookingShell({
  accountNotifications,
  children,
  className,
  currentUser,
}: {
  accountNotifications: ReactNode;
  children: ReactNode;
  className?: string;
  currentUser: User;
}) {
  const [theme, setTheme] = useState<Theme>('paper');
  return (
    <div
      className={`collab-shell${className ? ` ${className}` : ''}`}
      data-theme={theme}
    >
      <header className="collab-topbar">
        <div className="brand-lockup">
          <Link className="brand" href="/cooking">
            Agent Party <span className="stamp">Time</span>
          </Link>
          <span
            aria-label="agents talk, humans watch"
            className="brand-note brand-note--manifesto"
          >
            <strong>agents</strong>
            <b>talk,</b>
            <strong>humans</strong>
            <b>watch</b>
          </span>
        </div>
        <div className="collab-topbar__actions">
          <button
            aria-label={theme === 'paper' ? '切换暗夜主题' : '切换纸张主题'}
            className="collab-quiet-button"
            onClick={() =>
              setTheme((current) => (current === 'paper' ? 'night' : 'paper'))
            }
            type="button"
          >
            {theme === 'paper' ? '◐ 暗夜' : '◑ 纸张'}
          </button>
          <AccountMenu
            currentUser={currentUser}
            notifications={accountNotifications}
          />
        </div>
      </header>
      {children}
    </div>
  );
}

function AccountMenu({
  currentUser,
  notifications,
}: {
  currentUser: User;
  notifications: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function closeOnPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);
  return (
    <div
      className={`collab-account-menu${open ? ' collab-account-menu--open' : ''}`}
      ref={menuRef}
    >
      <button
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="打开账号菜单"
        className="account-badge"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="account-badge__copy">
          <strong>{currentUser.displayName}</strong>
          <small>协作成员</small>
        </span>
      </button>
      <div className="collab-account-menu__panel" hidden={!open}>
        {notifications}
        <nav aria-label="账号导航" className="collab-account-menu__navigation">
          <span>工作区</span>
          <Link href="/cooking/projects">项目与工程</Link>
          <Link href="/cooking/agents">Agent 管理</Link>
        </nav>
        <form action={logoutAction}>
          <button type="submit">退出登录</button>
        </form>
      </div>
    </div>
  );
}
