'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { engineeringSettingsPath, projectPanelPath } from './routeState';

export function EngineeringList({
  engineering,
  projectId,
  projectName,
  canManage,
}: {
  engineering: Array<{
    id: string;
    name: string;
    type: 'FRONTEND' | 'BACKEND';
    environmentCount: number;
    panel: ReactNode;
    archiveControl: ReactNode;
  }>;
  projectId: string;
  projectName: string;
  canManage: boolean;
}) {
  const firstEngineeringId = engineering.at(0)?.id;
  const lastSelected = useRef(firstEngineeringId);
  const search = useSearchParams();
  const router = useRouter();
  const panel = search.get('panel');
  const requestedEngineering = search.get('engineering');
  const keepSelection =
    panel === 'invitations' || requestedEngineering === 'new';
  const expandedId = keepSelection
    ? lastSelected.current
    : (requestedEngineering ??
      (panel === 'engineering' ? undefined : firstEngineeringId));
  useEffect(() => {
    if (keepSelection) return;
    lastSelected.current = expandedId;
    if (requestedEngineering)
      document
        .getElementById(`engineering-row-${requestedEngineering}`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [expandedId, keepSelection, requestedEngineering]);

  function toggleEngineering(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    const href = event.currentTarget.href;
    if (panel === 'invitations') router.push(href, { scroll: false });
    else if (href !== window.location.href)
      window.history.pushState(null, '', href);
  }

  return engineering.length ? (
    <ul className="project-overview__engineering-list" role="list">
      {engineering.map((item) => {
        const expanded = expandedId === item.id;
        const panelId = `engineering-settings-${item.id}`;
        return (
          <li id={`engineering-row-${item.id}`} key={item.id}>
            <div className="project-engineering-list__row">
              <a
                aria-controls={panelId}
                aria-expanded={expanded}
                className="project-engineering-list__link"
                href={
                  expanded
                    ? projectPanelPath(projectId, 'engineering')
                    : engineeringSettingsPath(projectId, item.id)
                }
                onClick={toggleEngineering}
              >
                <span
                  aria-hidden="true"
                  className="project-engineering-list__chevron"
                />
                <small>{item.type === 'FRONTEND' ? '前端' : '后端'}</small>
                <strong>{item.name}</strong>
                <small>{item.environmentCount} 个环境</small>
              </a>
            </div>
            <div
              className="project-engineering-list__detail"
              hidden={!expanded}
              id={panelId}
            >
              {expanded ? item.panel : null}
              {expanded && item.archiveControl ? (
                <footer className="project-engineering-list__actions">
                  {item.archiveControl}
                </footer>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  ) : (
    <div className="project-overview__empty">
      <h4>为 {projectName} 添加第一个工程</h4>
      <p>
        {canManage
          ? '加入工程后，就能配置工程成员和测试环境。'
          : '项目负责人添加工程后，你可以在这里查看工程信息。'}
      </p>
    </div>
  );
}

export function ProjectRouteFeedback() {
  const search = useSearchParams();
  const error = search.get('error');
  const success = search.get('success');
  const [notice, setNotice] = useState<{ message: string } | null>(() =>
    success ? { message: success } : null,
  );

  useEffect(() => {
    if (!success) return;
    setNotice({ message: success });
    const url = new URL(window.location.href);
    if (url.searchParams.get('success') === success) {
      url.searchParams.delete('success');
      window.history.replaceState(
        null,
        '',
        url.pathname + url.search + url.hash,
      );
    }
  }, [success]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(
      () => setNotice((current) => (current === notice ? null : current)),
      3000,
    );
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (search.get('engineering') === 'new') return null;
  return (
    <>
      {error ? (
        <p className="project-settings__error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice notice-success" role="status">
          {notice.message}
        </p>
      ) : null}
    </>
  );
}
