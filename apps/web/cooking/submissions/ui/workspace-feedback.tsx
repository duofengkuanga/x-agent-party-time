'use client';

import Link from 'next/link';

export function SubmissionComposerLoading({
  onClose,
}: {
  onClose: () => void;
}) {
  return (
    <div className="collab-dialog-backdrop" role="presentation">
      <section
        aria-labelledby="submission-composer-loading-title"
        aria-modal="true"
        className="collab-dialog"
        role="dialog"
      >
        <header>
          <div>
            <h2 id="submission-composer-loading-title">创建提测单</h2>
          </div>
          <button aria-label="关闭创建提测单" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <div className="collab-dialog__body">
          <p className="collab-rail__detail-loading">正在读取创建配置…</p>
        </div>
      </section>
    </div>
  );
}

export function EmptyStage({
  hasClosedSubmissions,
  onCreate,
}: {
  hasClosedSubmissions: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="collab-empty-stage">
      <h1>{hasClosedSubmissions ? '暂无进行中的提测单' : '暂无提测单'}</h1>
      <p>创建提测单前，请先确认项目、工程与 Agent 已配置。</p>
      <div className="collab-empty-stage__actions">
        <button className="collab-primary" onClick={onCreate} type="button">
          创建第一张提测单
        </button>
        <Link href="/cooking/projects">我的项目</Link>
      </div>
    </div>
  );
}

export function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
