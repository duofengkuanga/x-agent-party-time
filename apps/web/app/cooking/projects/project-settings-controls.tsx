'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createProjectAction } from '@/features/cooking/projects/presentation/actions';

export function ProjectSettingsControls({
  accountInitial,
  accountNotifications,
  children,
  error,
  hasProjects,
  mutationId,
  pendingInvitationCount,
  success,
}: {
  accountInitial: string;
  accountNotifications: ReactNode;
  children: ReactNode;
  error?: string;
  hasProjects: boolean;
  mutationId: string;
  pendingInvitationCount: number;
  success?: string;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [accountBadgeHost, setAccountBadgeHost] =
    useState<HTMLButtonElement | null>(null);
  const [accountNotificationsHost, setAccountNotificationsHost] =
    useState<HTMLDivElement | null>(null);

  useEffect(() => {
    // Keep the shared shell unchanged; only this page injects invitation UI into its account area.
    const accountMenu = document.querySelector<HTMLDivElement>(
      '.collab-topbar__actions .collab-account-menu',
    );
    const badge = accountMenu?.querySelector<HTMLButtonElement>(
      ':scope > .account-badge',
    );
    const panel = accountMenu?.querySelector<HTMLDivElement>(
      ':scope > .collab-account-menu__panel',
    );
    if (!badge || !panel) return;

    const previousLabel = badge.getAttribute('aria-label');
    badge.classList.add('project-account-menu__badge');
    badge.setAttribute(
      'aria-label',
      pendingInvitationCount > 0
        ? `打开账号菜单，有 ${pendingInvitationCount} 条待处理邀请`
        : '打开账号菜单',
    );
    const notificationsHost = document.createElement('div');
    notificationsHost.className = 'project-account-menu__notifications-host';
    panel.prepend(notificationsHost);
    setAccountBadgeHost(badge);
    setAccountNotificationsHost(notificationsHost);
    return () => {
      if (previousLabel) badge.setAttribute('aria-label', previousLabel);
      else badge.removeAttribute('aria-label');
      badge.classList.remove('project-account-menu__badge');
      notificationsHost.remove();
    };
  }, [pendingInvitationCount]);

  return (
    <>
      {accountBadgeHost
        ? createPortal(
            <>
              <b aria-hidden="true" className="project-account-menu__initial">
                {accountInitial}
              </b>
              {pendingInvitationCount > 0 ? (
                <span className="collab-account-menu__count">
                  {pendingInvitationCount > 9 ? '9+' : pendingInvitationCount}
                </span>
              ) : null}
              <span
                aria-hidden="true"
                className="project-account-menu__chevron"
              >
                ⌄
              </span>
            </>,
            accountBadgeHost,
          )
        : null}
      {accountNotificationsHost
        ? createPortal(accountNotifications, accountNotificationsHost)
        : null}

      <main className="project-settings project-settings-shell">
        <section className="project-settings__hero">
          <div className="project-settings__intro">
            <h1>项目与工程</h1>
            <p>
              在这里维护项目成员、工程环境和 Runner 绑定；提测仍在工作台完成。
            </p>
          </div>
          <div className="project-settings__toolbar-actions">
            <button
              aria-controls="project-create-form"
              aria-expanded={showCreate}
              className="project-settings__primary-action"
              onClick={() => setShowCreate((current) => !current)}
              type="button"
            >
              {showCreate ? '取消' : '新建项目'}
            </button>
          </div>
        </section>

        <section className="project-settings__content">
          {showCreate ? (
            <form
              action={createProjectAction}
              className="project-settings__create"
              id="project-create-form"
            >
              <input name="mutationId" type="hidden" value={mutationId} />
              <div>
                <span>新建项目</span>
                <p>先建立协作边界，随后添加工程并完成本机绑定。</p>
              </div>
              <label>
                <span>项目名称</span>
                <input
                  autoComplete="off"
                  maxLength={120}
                  name="name"
                  placeholder="例如：商城重构"
                  required
                />
              </label>
              <button type="submit">创建并配置工程</button>
            </form>
          ) : null}

          {error ? (
            <p className="project-settings__error" role="alert">
              {error}
            </p>
          ) : null}
          {success ? <p className="notice notice-success">{success}</p> : null}

          {hasProjects ? (
            children
          ) : showCreate ? null : (
            <div className="project-settings__empty">
              <span>暂无项目</span>
              <h2>从一个项目开始。</h2>
              <p>项目创建后，可继续添加工程、配置测试环境并绑定本机 Runner。</p>
              <button onClick={() => setShowCreate(true)} type="button">
                新建项目
              </button>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
