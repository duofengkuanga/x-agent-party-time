'use client';

import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
} from 'react';
import type { User } from '@/platform/auth/contract';
import { createClientId } from '@/cooking/shared/ui/client-id';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '@/cooking/shared/ui/sidebar-width';
import {
  CookingWorkspaceSnapshotSchema,
  type CookingWorkspaceSnapshot,
} from '@/cooking/workspace/contract';
import { BugBoard } from '@/cooking/bugs/ui/bug-board';
import {
  closeSubmissionAction,
  resolveCleanupInteractionAction,
  retryCleanupAction,
} from '@/cooking/lifecycle/server/actions';
import {
  type SubmissionCreationCatalog,
  type SubmissionSummary,
} from '../contract';
import {
  loadSubmissionCreationCatalogAction,
  updateSubmissionAction,
} from '../server/actions';
import { EnvironmentStatus } from './environment-status';
import { SubmissionComposer } from './submission-composer';
import { workspaceReducer, parseInvalidation } from './workspace-state';
import { useSidebarWidth } from './sidebar-preference';

import {
  messageOf,
  EmptyStage,
  SubmissionComposerLoading,
} from './workspace-feedback';

import { SubmissionRail } from './submission-rail';

const TRANSIENT_NOTICE_MS = 3_000;

type CollabLayoutStyle = CSSProperties & {
  '--collab-rail-expanded-width': string;
};

export function SubmissionWorkspace({
  currentUser,
  initialSnapshot,
  initialSubmissions,
  initialSidebarWidth,
}: {
  currentUser: User;
  initialSnapshot: CookingWorkspaceSnapshot | null;
  initialSubmissions: SubmissionSummary[];
  initialSidebarWidth: number;
}) {
  const router = useRouter();
  const [{ snapshot, submissions, syncState }, dispatch] = useReducer(
    workspaceReducer,
    {
      snapshot: initialSnapshot,
      submissions: initialSubmissions,
      syncState: 'connected',
    },
  );
  const [showCreateSubmission, setShowCreateSubmission] = useState(false);
  const [creationCatalog, setCreationCatalog] =
    useState<SubmissionCreationCatalog | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { sidebarWidth, sidebarResizing, resizerHandlers } =
    useSidebarWidth(initialSidebarWidth);
  const [includeClosed, setIncludeClosed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [catalogPending, startCatalogTransition] = useTransition();
  const snapshotRef = useRef(initialSnapshot);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const requestedRevision = useRef(initialSnapshot?.revision ?? 0);
  const selectedId = snapshot?.submission.submission.id ?? null;

  const refreshSnapshot = useCallback(
    async (minimumRevision = 0) => {
      if (!selectedId) return;
      requestedRevision.current = Math.max(
        requestedRevision.current,
        minimumRevision,
      );
      if (refreshInFlight.current) return refreshInFlight.current;
      const refresh = (async () => {
        dispatch({ type: 'SET_SYNC_STATE', syncState: 'syncing' });
        try {
          let next: CookingWorkspaceSnapshot;
          do {
            const response = await fetch(
              `/api/cooking/submissions/${encodeURIComponent(selectedId)}/workspace`,
              { cache: 'no-store' },
            );
            const body = await response.json();
            if (!response.ok)
              throw new Error(body.error?.message ?? '无法刷新提测工作区');
            next = CookingWorkspaceSnapshotSchema.parse(body);
            snapshotRef.current = next;
            dispatch({ type: 'REPLACE_SNAPSHOT', snapshot: next });
          } while (next.revision < requestedRevision.current);
          setError(null);
          dispatch({ type: 'SET_SYNC_STATE', syncState: 'connected' });
        } catch (requestError) {
          setError(messageOf(requestError, '无法刷新提测工作区'));
          dispatch({ type: 'SET_SYNC_STATE', syncState: 'reconnecting' });
        } finally {
          refreshInFlight.current = null;
        }
      })();
      refreshInFlight.current = refresh;
      return refresh;
    },
    [selectedId],
  );

  useEffect(() => {
    snapshotRef.current = initialSnapshot;
    requestedRevision.current = initialSnapshot?.revision ?? 0;
    dispatch({
      type: 'RESET',
      snapshot: initialSnapshot,
      submissions: initialSubmissions,
    });
  }, [initialSnapshot, initialSubmissions]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(
      () => setNotice(null),
      TRANSIENT_NOTICE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!selectedId) return;
    const events = new EventSource(
      `/api/cooking/events?submissionId=${encodeURIComponent(selectedId)}`,
    );
    events.onopen = () =>
      dispatch({ type: 'SET_SYNC_STATE', syncState: 'connected' });
    events.onerror = () =>
      dispatch({ type: 'SET_SYNC_STATE', syncState: 'reconnecting' });
    events.onmessage = (event) => {
      const invalidation = parseInvalidation(event.data);
      if (
        invalidation &&
        invalidation.submissionId === selectedId &&
        invalidation.revision >
          (snapshotRef.current?.revision ?? Number.NEGATIVE_INFINITY)
      )
        void refreshSnapshot(invalidation.revision);
    };
    return () => events.close();
  }, [refreshSnapshot, selectedId]);

  function selectSubmission(submissionId: string) {
    if (submissionId === selectedId) return;
    router.push(`/cooking/${submissionId}`);
  }

  function openSubmissionComposer() {
    setShowCreateSubmission(true);
    setCreationCatalog(null);
    startCatalogTransition(async () => {
      try {
        const result = await loadSubmissionCreationCatalogAction();
        if (!result.ok) {
          setError(result.error.message);
          setShowCreateSubmission(false);
          return;
        }
        setCreationCatalog(result.catalog);
        setError(null);
      } catch (catalogError) {
        setError(messageOf(catalogError, '读取创建配置失败，请稍后重试。'));
        setShowCreateSubmission(false);
      }
    });
  }

  function runMutation<T>(
    action: () => Promise<
      { ok: true; result: T } | { ok: false; error: { message: string } }
    >,
    onSuccess: (result: T) => Promise<void>,
    fallback: string,
  ) {
    startTransition(async () => {
      try {
        const response = await action();
        if (!response.ok) {
          setError(response.error.message);
          return;
        }
        await onSuccess(response.result);
      } catch (actionError) {
        setError(messageOf(actionError, fallback));
      }
    });
  }

  const visibleSubmissions = includeClosed
    ? submissions
    : submissions.filter(({ submission }) => submission.status === 'ACTIVE');
  const layoutStyle: CollabLayoutStyle = {
    '--collab-rail-expanded-width': `${sidebarWidth}px`,
  };

  return (
    <>
      <div
        className="collab-layout"
        data-sidebar-collapsed={sidebarCollapsed ? 'true' : undefined}
        data-sidebar-mode={showDetails ? 'detail' : 'list'}
        data-sidebar-resizing={sidebarResizing ? 'true' : undefined}
        style={layoutStyle}
      >
        <SubmissionRail
          collapsed={sidebarCollapsed}
          detailOpen={showDetails}
          includeClosed={includeClosed}
          onBackToList={() => setShowDetails(false)}
          onCloseSubmission={() => {
            if (!snapshot) return;
            runMutation(
              () =>
                closeSubmissionAction(snapshot.submission.submission.id, {
                  mutationId: createClientId(),
                  expectedVersion: snapshot.submission.submission.version,
                }),
              async (result) => {
                setError(null);
                setNotice('提测单已关闭，环境已释放，清理任务已排队。');
                await refreshSnapshot(result.revision);
              },
              '关闭提测单失败，请稍后重试。',
            );
          }}
          onCreate={openSubmissionComposer}
          onIncludeClosedChange={setIncludeClosed}
          onOpenDetails={(id) => {
            selectSubmission(id);
            setShowDetails(true);
            setSidebarCollapsed(false);
          }}
          onRefresh={() => void refreshSnapshot()}
          onResolveCleanupInteraction={(
            interactionId,
            expectedVersion,
            resolution,
          ) => {
            runMutation(
              () =>
                resolveCleanupInteractionAction(interactionId, {
                  mutationId: createClientId(),
                  expectedVersion,
                  resolution,
                }),
              async (result) => {
                setError(null);
                setNotice('清理交互已提交给 Codex。');
                await refreshSnapshot(result.revision);
              },
              '提交清理交互失败，请稍后重试。',
            );
          }}
          onRetryCleanup={(cleanupId, expectedVersion) => {
            runMutation(
              () =>
                retryCleanupAction(cleanupId, {
                  mutationId: createClientId(),
                  expectedVersion,
                }),
              async (result) => {
                setError(null);
                setNotice('本地资源清理已重新排队。');
                await refreshSnapshot(result.revision);
              },
              '重试清理失败，请稍后重试。',
            );
          }}
          onSelect={selectSubmission}
          onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
          selectedId={selectedId}
          snapshot={snapshot}
          submissions={visibleSubmissions}
          syncState={syncState}
          updateDetails={(title, requirementDescription, targetBranches) => {
            if (!snapshot) return;
            runMutation(
              () =>
                updateSubmissionAction(snapshot.submission.submission.id, {
                  mutationId: createClientId(),
                  expectedVersion: snapshot.submission.submission.version,
                  title,
                  requirementDescription,
                  targetBranches,
                }),
              async (result) => {
                dispatch({
                  type: 'UPDATE_SUBMISSION',
                  submission: result,
                });
                await refreshSnapshot(result.workspaceRevision);
                setNotice('提测信息已更新。');
                setError(null);
              },
              '保存提测信息失败，请稍后重试。',
            );
          }}
          updating={pending}
        />

        <div
          aria-controls="collab-submission-rail"
          aria-label="调整提测单侧边栏宽度"
          aria-orientation="vertical"
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuenow={sidebarWidth}
          className="collab-rail-resizer"
          {...resizerHandlers}
          role="separator"
          tabIndex={sidebarCollapsed ? -1 : 0}
        />

        <section className="collab-stage">
          {error ? (
            <div className="collab-banner collab-banner--error" role="alert">
              <span>{error}</span>
              <button onClick={() => setError(null)} type="button">
                ×
              </button>
            </div>
          ) : null}
          {notice ? (
            <div className="collab-banner" role="status">
              <span>{notice}</span>
              <button onClick={() => setNotice(null)} type="button">
                ×
              </button>
            </div>
          ) : null}
          {snapshot ? (
            <div className="collab-stage__content">
              {snapshot.submission.submission.status === 'ACTIVE' &&
              snapshot.submission.items.some(
                (item) =>
                  !item.environmentAccess.owned ||
                  !item.environmentAccess.deploymentConfirmed,
              ) ? (
                <div
                  className="collab-environment-notices"
                  aria-label="环境使用提醒"
                >
                  {snapshot.submission.items.map((item) => (
                    <EnvironmentStatus
                      key={item.id}
                      item={item}
                      title={snapshot.submission.submission.title}
                      revision={snapshot.revision}
                      onChanged={(revision) => {
                        void refreshSnapshot(revision);
                      }}
                    />
                  ))}
                </div>
              ) : null}
              <BugBoard
                onChanged={(revision, message) => {
                  setNotice(message);
                  void refreshSnapshot(revision);
                }}
                snapshot={snapshot}
                syncLabel={
                  syncState === 'connected'
                    ? '实时同步已连接'
                    : syncState === 'syncing'
                      ? '正在同步最新状态'
                      : '连接中断，正在重连'
                }
              />
            </div>
          ) : (
            <EmptyStage
              hasClosedSubmissions={submissions.length > 0}
              onCreate={openSubmissionComposer}
            />
          )}
        </section>
      </div>

      {showCreateSubmission && creationCatalog ? (
        <SubmissionComposer
          catalog={creationCatalog}
          currentUser={currentUser}
          onClose={() => setShowCreateSubmission(false)}
          onCreated={(submissionId) => {
            setShowCreateSubmission(false);
            router.push(`/cooking/${submissionId}`);
          }}
        />
      ) : showCreateSubmission && catalogPending ? (
        <SubmissionComposerLoading
          onClose={() => setShowCreateSubmission(false)}
        />
      ) : null}
    </>
  );
}
