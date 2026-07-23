'use client';

import Link from 'next/link';
import type { CurrentUser } from '@/lib/auth/core';

export function CookingAccountMenu({
  currentUser,
  currentArea,
}: {
  currentUser: CurrentUser;
  currentArea: 'workspace' | 'projects';
}) {
  const isDeveloper = currentUser.accountType === 'DEVELOPER';

  return (
    <details className="collab-account-menu">
      <summary aria-label="打开账号菜单" className="account-badge">
        <b className="account-badge__initial">
          {currentUser.displayName.slice(0, 1)}
        </b>
        <span className="account-badge__copy">
          <strong>{currentUser.displayName}</strong>
          <small>{isDeveloper ? 'DEVELOPER' : 'TESTER'}</small>
        </span>
        <span aria-hidden="true" className="collab-account-menu__chevron">
          ⌄
        </span>
      </summary>
      <div className="collab-account-menu__panel">
        <span>工作区</span>
        {currentArea !== 'workspace' ? (
          <Link href="/cooking">提测工作台</Link>
        ) : null}
        {isDeveloper && currentArea !== 'projects' ? (
          <Link href="/cooking/projects">项目与工程</Link>
        ) : null}
        <form action="/api/auth/logout" method="post">
          <button type="submit">退出登录</button>
        </form>
      </div>
    </details>
  );
}
