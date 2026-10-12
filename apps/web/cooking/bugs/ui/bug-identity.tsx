'use client';

import { useEffect, useState } from 'react';

export function BugIdentity({ bugId }: { bugId: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  useEffect(() => {
    if (copyState !== 'copied') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 1600);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  return (
    <div className="collab-bug-identity">
      <span>ID</span>
      <code>{bugId}</code>
      <button
        aria-label="复制删除命令"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(`xapt bugs delete ${bugId}`);
            setCopyState('copied');
          } catch {
            setCopyState('failed');
          }
        }}
      >
        {copyState === 'copied' ? '已复制' : '复制命令'}
      </button>
      {copyState === 'failed' ? (
        <span role="alert">复制失败，请重试。</span>
      ) : null}
    </div>
  );
}
