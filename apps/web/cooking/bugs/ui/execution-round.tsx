'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import type { CookingValidationSchema } from '@/cooking/shared/contract';
import { formatDateTime } from './board-model';
import { ValidationResults } from './validation-results';

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
}) {
  const [open, setOpen] = useState(current);
  return (
    <details
      className="collab-execution-round"
      data-round-kind={kind}
      data-current={current}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <strong>{title}</strong>
        <span>{status}</span>
        <time dateTime={at}>{formatDateTime(at)}</time>
      </summary>
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
        {finishedAt ? (
          <p className="collab-execution-round__time">
            结束于 {formatDateTime(finishedAt)}
          </p>
        ) : null}
      </div>
    </details>
  );
}

export function RoundLines({
  items,
  empty,
  label = '查看明细',
}: {
  items: string[];
  empty: string;
  label?: string;
}) {
  if (!items.length) return <p>{empty}</p>;
  return (
    <>
      <p>{items[0]}</p>
      {items.length > 1 ? (
        <details className="collab-round-disclosure">
          <summary>
            {label}（{items.length} 项）
          </summary>
          <ul>
            {items.slice(1).map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </details>
      ) : null}
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
      {failed.length ? (
        <ValidationResults items={failed} title="失败项" emptyLabel="" />
      ) : null}
      <details className="collab-round-disclosure">
        <summary>查看检查明细</summary>
        <ValidationResults items={items} title="本轮检查" emptyLabel="" />
      </details>
    </>
  );
}
