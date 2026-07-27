'use client';

import { useEffect } from 'react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('页面渲染失败', { digest: error.digest });
  }, [error.digest]);

  return (
    <main className="placeholder-page">
      <section className="placeholder-card" role="alert">
        <span className="eyebrow">Agent Party Time</span>
        <h1>页面暂时无法加载</h1>
        <p>内部错误信息已隐藏。你可以重试；如果问题持续，请检查服务端日志。</p>
        <button onClick={reset} type="button">
          重新加载
        </button>
      </section>
    </main>
  );
}
