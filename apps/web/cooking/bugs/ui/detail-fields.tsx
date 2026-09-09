'use client';

import { type ReactNode } from 'react';

export function TimelineList({
  emptyLabel = '无',
  items,
  title,
}: {
  emptyLabel?: string;
  items: string[];
  title: string;
}) {
  return (
    <div className="collab-repair-result-list">
      <h4>{title}</h4>
      {items.length ? (
        <ul>
          {items.map((item, index) => (
            <li key={`${index}:${item}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>{emptyLabel}</p>
      )}
    </div>
  );
}

export function DetailList({
  items,
  kind,
  title,
}: {
  items: string[];
  kind: 'completed' | 'pending' | 'warning';
  title: string;
}) {
  return (
    <section className="collab-update-result-list" data-result-kind={kind}>
      <h4>{title}</h4>
      <ul>
        {items.map((item, index) => (
          <li key={`${item}:${index}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

export function Detail({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
