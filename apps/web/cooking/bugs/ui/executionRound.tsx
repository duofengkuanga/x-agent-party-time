'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import type { CookingValidationSchema } from '@/cooking/shared/contract';
import { formatDateTime } from './boardModel';
import { ValidationResults } from './validationResults';

export function ExecutionIdentity({
  label,
  value,
  session = false,
}: {
  label: string;
  value: string | null;
  session?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="collab-execution-identity" aria-label={label}>
      <span>{label}</span>
      <code>{value ?? '暂无可见会话'}</code>
      {value ? (
        <div>
          <button
            type="button"
            aria-label={`复制${label}`}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopied(true);
                setError(false);
              } catch {
                setCopied(false);
                setError(true);
              }
            }}
          >
            {copied ? '已复制' : '复制'}
          </button>
          {session ? (
            <a href={`codex://threads/${encodeURIComponent(value)}`}>
              打开会话
            </a>
          ) : null}
        </div>
      ) : null}
      {error ? <span role="alert">复制失败，请重试。</span> : null}
    </div>
  );
}

export function ExecutionRound({
  title,
  status,
  at,
  finishedAt,
  current,
  identity,
  progress,
  changes,
  checks,
  delivery,
  kind,
  analysis,
}: {
  title: string;
  status: string;
  at: string;
  finishedAt: string | null;
  current: boolean;
  identity?: ReactNode;
  progress: ReactNode;
  changes: ReactNode;
  checks: ReactNode;
  delivery: ReactNode;
  kind: 'repair' | 'update';
  analysis?: ReactNode;
}) {
  return (
    <article
      aria-label={title}
      className="collab-execution-round"
      data-round-kind={kind}
      data-current={current}
    >
      <header>
        <strong>{status}</strong>
        <time dateTime={at}>{formatDateTime(at)}</time>
      </header>
      <div className="collab-execution-round__body">
        {identity}
        <dl className="collab-execution-round__fields">
          <div className="collab-execution-round__progress">
            <dt>执行进展</dt>
            <dd>{progress}</dd>
          </div>
          <div>
            <dt>代码变更</dt>
            <dd>{changes}</dd>
          </div>
          <div>
            <dt>检查结果</dt>
            <dd>{checks}</dd>
          </div>
          <div className="collab-execution-round__delivery">
            <dt>交付状态</dt>
            <dd>{delivery}</dd>
          </div>
        </dl>
        {analysis}
        {finishedAt ? (
          <p className="collab-execution-round__time">
            结束于 {formatDateTime(finishedAt)}
          </p>
        ) : null}
      </div>
    </article>
  );
}

export function ExecutionRoundTabs({
  label,
  rounds,
}: {
  label: string;
  rounds: Array<{ id: string; label: string; content: ReactNode }>;
}) {
  const scope = useId();
  const [selected, setSelected] = useState(rounds[0]?.id);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const active = rounds.some((round) => round.id === selected)
    ? selected
    : rounds[0]?.id;
  if (!rounds.length) return null;
  return (
    <div className="collab-execution-round-tabs">
      <div
        className="collab-execution-round-tabs__list"
        role="tablist"
        aria-label={label}
      >
        {rounds.map((round, index) => (
          <button
            key={round.id}
            type="button"
            role="tab"
            id={`${scope}-tab-${round.id}`}
            aria-controls={`${scope}-panel-${round.id}`}
            aria-selected={active === round.id}
            tabIndex={active === round.id ? 0 : -1}
            ref={(button) => {
              if (button) tabRefs.current.set(round.id, button);
              else tabRefs.current.delete(round.id);
            }}
            onClick={() => setSelected(round.id)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === 'ArrowRight')
                next = (index + 1) % rounds.length;
              else if (event.key === 'ArrowLeft')
                next = (index + rounds.length - 1) % rounds.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = rounds.length - 1;
              else return;
              event.preventDefault();
              setSelected(rounds[next]!.id);
              tabRefs.current.get(rounds[next]!.id)?.focus();
            }}
          >
            {round.label}
          </button>
        ))}
      </div>
      {rounds.map((round) => (
        <section
          className="collab-execution-round-panel"
          key={round.id}
          role="tabpanel"
          id={`${scope}-panel-${round.id}`}
          aria-labelledby={`${scope}-tab-${round.id}`}
          hidden={active !== round.id}
        >
          {round.content}
        </section>
      ))}
    </div>
  );
}

export function RoundLines({
  items,
  empty,
  label,
}: {
  items: string[];
  empty: string;
  label?: string;
}) {
  if (!items.length) return <p>{empty}</p>;
  return (
    <>
      {label ? <h4>{label}</h4> : null}
      {items.length === 1 ? (
        <p>{items[0]}</p>
      ) : (
        <ul className="collab-round-list">
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )}
    </>
  );
}

export function RoundChecks({
  items,
}: {
  items: z.infer<typeof CookingValidationSchema>[];
}) {
  const failed = items.filter(({ status }) => status === 'FAILED');
  if (!items.length) return <p>本轮尚未收到检查结果。</p>;
  return (
    <>
      <p>
        {items.filter(({ status }) => status === 'PASSED').length} 项通过，
        {failed.length} 项失败，
        {items.filter(({ status }) => status === 'SKIPPED').length} 项跳过
      </p>
      <ValidationResults items={items} title="本轮检查" emptyLabel="" />
    </>
  );
}
