'use client';

import dynamic from 'next/dynamic';
import { useCallback, useId, useState } from 'react';

const Panel = dynamic(
  () => import('./observationPanel').then((module) => module.ObservationPanel),
  {
    loading: () => <p role="status">正在加载耗时分析…</p>,
  },
);

export function ObservationDetails({
  executionId,
  shared = false,
}: {
  executionId: string;
  shared?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [summary, setSummary] = useState('按需查看本轮耗时记录');
  const id = useId();
  const onSummary = useCallback((value: string) => setSummary(value), []);
  return (
    <section className="collab-observation" aria-label="本轮耗时分析">
      <header className="collab-observation__header">
        <div>
          <h4>耗时分析</h4>
          <p>{summary}</p>
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起耗时分析' : '查看耗时分析'}
        </button>
      </header>
      {shared ? (
        <p className="collab-observation__note">
          本轮更新由整批共享，未按缺陷分摊。
        </p>
      ) : null}
      <div id={id} hidden={!expanded}>
        {expanded ? (
          <Panel executionId={executionId} onSummary={onSummary} />
        ) : null}
      </div>
    </section>
  );
}
