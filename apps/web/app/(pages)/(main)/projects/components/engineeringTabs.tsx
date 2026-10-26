'use client';

import Link from 'next/link';
import { useRef, type KeyboardEvent } from 'react';
import { engineeringSettingsPath } from './routeState';

export function EngineeringTabs({
  engineering,
  projectId,
  selectedId,
}: {
  engineering: Array<{
    id: string;
    name: string;
    type: 'FRONTEND' | 'BACKEND';
  }>;
  projectId: string;
  selectedId?: string;
}) {
  const tabs = useRef<HTMLDivElement>(null);

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
    <div
      aria-label="工程"
      className="project-engineering-tabs"
      onKeyDown={moveFocus}
      ref={tabs}
      role="tablist"
    >
      {engineering.map((item) => (
        <Link
          aria-controls="project-engineering-panel"
          aria-selected={selectedId === item.id}
          href={engineeringSettingsPath(projectId, item.id)}
          id={`engineering-tab-${item.id}`}
          key={item.id}
          role="tab"
          scroll={false}
          tabIndex={
            selectedId === item.id ||
            (!selectedId && item.id === engineering[0]?.id)
              ? 0
              : -1
          }
        >
          <small>{item.type === 'FRONTEND' ? '前端' : '后端'}</small>
          <span>{item.name}</span>
        </Link>
      ))}
    </div>
  );
}
