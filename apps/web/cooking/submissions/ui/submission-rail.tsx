'use client';

import Link from 'next/link';
import type { JsonValue } from '@agent-party-time/execution-contract';
import { type CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import { type SubmissionSummary } from '../contract';
import type { SyncState } from './workspace-state';
import { SubmissionDetails } from './submission-details';

export function SubmissionRail({
  collapsed,
  detailOpen,
  includeClosed,
  onBackToList,
  onCloseSubmission,
  onCreate,
  onIncludeClosedChange,
  onOpenDetails,
  onRefresh,
  onResolveCleanupInteraction,
  onRetryCleanup,
  onSelect,
  onToggleCollapsed,
  selectedId,
  snapshot,
  submissions,
  syncState,
  updateDetails,
  updating,
}: {
  collapsed: boolean;
  detailOpen: boolean;
  includeClosed: boolean;
  onBackToList: () => void;
  onCloseSubmission: () => void;
  onCreate: () => void;
  onIncludeClosedChange: (value: boolean) => void;
  onOpenDetails: (id: string) => void;
  onRefresh: () => void;
  onResolveCleanupInteraction: (
    interactionId: string,
    expectedVersion: number,
    resolution: JsonValue,
  ) => void;
  onRetryCleanup: (cleanupId: string, expectedVersion: number) => void;
  onSelect: (id: string) => void;
  onToggleCollapsed: () => void;
  selectedId: string | null;
  snapshot: CookingWorkspaceSnapshot | null;
  submissions: SubmissionSummary[];
  syncState: SyncState;
  updateDetails: (
    title: string,
    requirementDescription: string,
    targetBranches: Array<{
      submissionItemId: string;
      targetBranch: string;
    }>,
  ) => void;
  updating: boolean;
}) {
  return (
    <aside
      className={`collab-rail${detailOpen ? ' collab-rail--detail' : ''}`}
      data-collapsed={collapsed ? 'true' : undefined}
      id="collab-submission-rail"
    >
      <button
        aria-hidden={!collapsed}
        aria-label="展开提测单侧边栏"
        className="collab-rail__expand"
        onClick={onToggleCollapsed}
        tabIndex={collapsed ? 0 : -1}
        type="button"
      >
        <span>提测单</span>
        <b>›</b>
      </button>
      <div
        aria-hidden={collapsed}
        className="collab-rail__expanded"
        inert={collapsed}
      >
        {detailOpen ? (
          <>
            <div className="collab-rail__detail-toolbar">
              <button onClick={onBackToList} type="button">
                ← 返回列表
              </button>
              <button
                aria-label="收起提测单侧边栏"
                onClick={onToggleCollapsed}
                type="button"
              >
                ‹
              </button>
            </div>
            <label className="collab-rail__switcher">
              <span>切换提测单</span>
              <select
                onChange={(event) => onSelect(event.target.value)}
                value={selectedId ?? ''}
              >
                {submissions.map(({ submission }) => (
                  <option key={submission.id} value={submission.id}>
                    {submission.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="collab-rail__detail-body">
              {snapshot ? (
                <SubmissionDetails
                  key={`${snapshot.submission.submission.id}:${snapshot.revision}`}
                  onResolveCleanupInteraction={onResolveCleanupInteraction}
                  snapshot={snapshot}
                  onRetryCleanup={onRetryCleanup}
                  updateDetails={updateDetails}
                  updating={updating}
                />
              ) : (
                <p className="collab-rail__detail-loading">
                  正在加载提测单详情…
                </p>
              )}
            </div>
            {snapshot?.submission.submission.status === 'ACTIVE' &&
            snapshot.submission.submission.testerUserId ===
              snapshot.currentUser.id ? (
              <div className="collab-rail__detail-footer">
                <button
                  disabled={
                    updating ||
                    !snapshot.bugs.every(({ stage }) =>
                      ['DONE', 'CANCELLED'].includes(stage),
                    )
                  }
                  onClick={onCloseSubmission}
                  type="button"
                >
                  关闭提测单
                </button>
                {!snapshot.bugs.every(({ stage }) =>
                  ['DONE', 'CANCELLED'].includes(stage),
                ) ? (
                  <small>所有缺陷完成或取消后可关闭</small>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="collab-rail__heading">
              <h2>提测单</h2>
              <div className="collab-rail__heading-actions">
                <button
                  aria-label="刷新"
                  disabled={syncState === 'syncing'}
                  onClick={onRefresh}
                  type="button"
                >
                  {syncState === 'syncing' ? '…' : '↻'}
                </button>
                <button
                  aria-label="收起提测单侧边栏"
                  onClick={onToggleCollapsed}
                  type="button"
                >
                  ‹
                </button>
              </div>
            </div>
            <label className="collab-check">
              <input
                checked={includeClosed}
                onChange={(event) =>
                  onIncludeClosedChange(event.target.checked)
                }
                type="checkbox"
              />
              <span>包含已关闭提测单</span>
            </label>
            <nav aria-label="提测单列表" className="collab-submission-list">
              {submissions.map(({ submission, tester, itemCount }) => (
                <article
                  className="collab-submission-card"
                  data-selected={
                    submission.id === selectedId ? 'true' : undefined
                  }
                  key={submission.id}
                >
                  <Link
                    aria-current={
                      submission.id === selectedId ? 'page' : undefined
                    }
                    className="collab-submission-card__select"
                    href={`/cooking/${submission.id}`}
                  >
                    <span className="collab-submission-list__meta">
                      <b>
                        {submission.status === 'ACTIVE' ? '进行中' : '已关闭'}
                      </b>
                      <time>{formatCompactDate(submission.updatedAt)}</time>
                    </span>
                    <strong>{submission.title}</strong>
                    <small>
                      {tester.displayName} · {itemCount} 工程
                    </small>
                  </Link>
                  <button
                    aria-label={`查看${submission.title}详情`}
                    className="collab-submission-card__details"
                    onClick={() => onOpenDetails(submission.id)}
                    type="button"
                  >
                    详情
                  </button>
                </article>
              ))}
              {submissions.length === 0 ? (
                <p className="collab-rail__empty">还没有协作提测单。</p>
              ) : null}
            </nav>
            <button
              className="collab-primary collab-rail__create"
              onClick={onCreate}
              type="button"
            >
              ＋ 创建多工程提测
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

function formatCompactDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value));
}
