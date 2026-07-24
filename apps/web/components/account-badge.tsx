import type { CurrentUser } from '@/lib/auth/core';

export function AccountBadge({ user }: { user: CurrentUser }) {
  return (
    <div className="account-badge">
      <span className="account-badge__copy">
        <strong>{user.displayName}</strong>
        <small>
          {user.accountType === 'DEVELOPER' ? '开发者' : '测试人员'}
        </small>
      </span>
      <form action="/api/auth/logout" method="post">
        <button type="submit">退出</button>
      </form>
    </div>
  );
}
