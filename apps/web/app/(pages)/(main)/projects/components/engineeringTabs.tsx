'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { engineeringCreatePath, engineeringSettingsPath } from './routeState';

export function EngineeringTabs({
  engineering,
  projectId,
  creationPanel,
}: {
  engineering: Array<{
    id: string;
    name: string;
    type: 'FRONTEND' | 'BACKEND';
    panel: ReactNode;
    archiveControl: ReactNode;
  }>;
  projectId: string;
  creationPanel: ReactNode;
}) {
  const tabs = useRef<HTMLDivElement>(null);
  const search = useSearchParams();
  const router = useRouter();
  const creating =
    search.get('engineering') === 'new' && Boolean(creationPanel);
  const selected = creating
    ? undefined
    : (engineering.find(({ id }) => id === search.get('engineering')) ??
      engineering[0]);
  const localSwitch = search.get('panel') !== 'invitations';

  function selectTab(event: MouseEvent<HTMLAnchorElement>) {
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
    if (!localSwitch) router.push(href, { scroll: false });
    else if (href !== window.location.href)
      window.history.pushState(null, '', href);
  }

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(
      tabs.current?.querySelectorAll<HTMLAnchorElement>('[role="tab"]') ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLAnchorElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  }

  return (
    <>
      {engineering.length ? (
        <div className="project-engineering-toolbar">
          <div
            aria-label="工程"
            className="project-engineering-tabs"
            onKeyDown={moveFocus}
            ref={tabs}
            role="tablist"
          >
            {engineering.map((item) => (
              <a
                aria-controls="project-engineering-panel"
                aria-selected={selected?.id === item.id}
                href={engineeringSettingsPath(projectId, item.id)}
                id={`engineering-tab-${item.id}`}
                key={item.id}
                role="tab"
                onClick={selectTab}
                tabIndex={
                  selected?.id === item.id ||
                  (!selected && item.id === engineering[0]?.id)
                    ? 0
                    : -1
                }
              >
                <small>{item.type === 'FRONTEND' ? '前端' : '后端'}</small>
                <span>{item.name}</span>
              </a>
            ))}
          </div>
          {creationPanel && !creating ? (
            <Link
              className="repair-primary project-engineering-create-link"
              href={engineeringCreatePath(projectId)}
              prefetch={false}
            >
              新建工程
            </Link>
          ) : null}
          {selected?.archiveControl}
        </div>
      ) : null}
      {creating ? (
        <div id="project-engineering-panel">{creationPanel}</div>
      ) : selected ? (
        <div
          role="tabpanel"
          id="project-engineering-panel"
          aria-labelledby={`engineering-tab-${selected.id}`}
          key={selected.id}
          tabIndex={0}
        >
          {selected.panel}
        </div>
      ) : null}
    </>
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
