'use client';

import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { User } from '@/platform/auth/contract';
import { createClientId } from '@/cooking/shared/ui/client-id';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
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
import { SubmissionComposer } from './submission-composer';
import { workspaceReducer, parseInvalidation } from './workspace-state';
import {
  subscribeSidebarWidth,
  getSidebarWidthSnapshot,
  SIDEBAR_STORAGE_KEY,
  writeSidebarWidthCookie,
  SIDEBAR_CHANGE_EVENT,
} from './sidebar-preference';

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
  const storedSidebarWidth = useSyncExternalStore(
    subscribeSidebarWidth,
    () => getSidebarWidthSnapshot(initialSidebarWidth),
    () => initialSidebarWidth,
  );
  const [sidebarWidthOverride, setSidebarWidthOverride] = useState<
    number | null
  >(null);
  const sidebarWidth = sidebarWidthOverride ?? storedSidebarWidth;
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [includeClosed, setIncludeClosed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [catalogPending, startCatalogTransition] = useTransition();
  const snapshotRef = useRef(initialSnapshot);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const requestedRevision = useRef(initialSnapshot?.revision ?? 0);
  const sidebarDrag = useRef<{
    currentWidth: number;
    startWidth: number;
    startX: number;
  } | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (!stored) return;
    const storedWidth = Number(stored);
    if (!(Number.isFinite(storedWidth) && storedWidth > 0)) return;
    writeSidebarWidthCookie(clampSidebarWidth(storedWidth));
  }, []);

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

  function saveSidebarWidth(width: number) {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(width));
    writeSidebarWidthCookie(width);
    window.dispatchEvent(new Event(SIDEBAR_CHANGE_EVENT));
  }

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || window.matchMedia('(max-width: 760px)').matches)
      return;
    sidebarDrag.current = {
      currentWidth: sidebarWidth,
      startWidth: sidebarWidth,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSidebarResizing(true);
  }

  function resizeSidebar(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sidebarDrag.current) return;
    const nextWidth = clampSidebarWidth(
      sidebarDrag.current.startWidth +
        event.clientX -
        sidebarDrag.current.startX,
    );
    sidebarDrag.current.currentWidth = nextWidth;
    setSidebarWidthOverride(nextWidth);
  }

  function finishSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sidebarDrag.current) return;
    const finalWidth = sidebarDrag.current.currentWidth;
    sidebarDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setSidebarWidthOverride(null);
    setSidebarResizing(false);
    saveSidebarWidth(finalWidth);
  }

  function cancelSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sidebarDrag.current) return;
    sidebarDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setSidebarWidthOverride(null);
    setSidebarResizing(false);
  }

  function resizeSidebarWithKeyboard(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    const step = event.shiftKey ? 32 : 16;
    const nextWidth =
      event.key === 'Home'
        ? SIDEBAR_MIN_WIDTH
        : event.key === 'End'
          ? clampSidebarWidth(SIDEBAR_MAX_WIDTH)
          : event.key === 'ArrowLeft'
            ? clampSidebarWidth(sidebarWidth - step)
            : event.key === 'ArrowRight'
              ? clampSidebarWidth(sidebarWidth + step)
              : null;
    if (nextWidth === null) return;
    event.preventDefault();
    saveSidebarWidth(nextWidth);
    setSidebarWidthOverride(null);
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
            startTransition(async () => {
              try {
                const result = await closeSubmissionAction(
                  snapshot.submission.submission.id,
                  {
                    mutationId: createClientId(),
                    expectedVersion: snapshot.submission.submission.version,
                  },
                );
                if (!result.ok) {
                  setError(result.error.message);
                  return;
                }
                setError(null);
                setNotice('提测单已关闭，环境已释放，清理任务已排队。');
                await refreshSnapshot(result.result.revision);
              } catch (actionError) {
                setError(
                  messageOf(actionError, '关闭提测单失败，请稍后重试。'),
                );
              }
            });
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
            startTransition(async () => {
              try {
                const result = await resolveCleanupInteractionAction(
                  interactionId,
                  {
                    mutationId: createClientId(),
                    expectedVersion,
                    resolution,
                  },
                );
                if (!result.ok) {
                  setError(result.error.message);
                  return;
                }
                setError(null);
                setNotice('清理交互已提交给 Codex。');
                await refreshSnapshot(result.result.revision);
              } catch (actionError) {
                setError(
                  messageOf(actionError, '提交清理交互失败，请稍后重试。'),
                );
              }
            });
          }}
          onRetryCleanup={(cleanupId, expectedVersion) => {
            startTransition(async () => {
              try {
                const result = await retryCleanupAction(cleanupId, {
                  mutationId: createClientId(),
                  expectedVersion,
                });
                if (!result.ok) {
                  setError(result.error.message);
                  return;
                }
                setError(null);
                setNotice('本地资源清理已重新排队。');
                await refreshSnapshot(result.result.revision);
              } catch (actionError) {
                setError(messageOf(actionError, '重试清理失败，请稍后重试。'));
              }
            });
          }}
          onSelect={selectSubmission}
          onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
          selectedId={selectedId}
          snapshot={snapshot}
          submissions={visibleSubmissions}
          syncState={syncState}
          updateDetails={(title, requirementDescription, targetBranches) => {
            if (!snapshot) return;
            startTransition(async () => {
              try {
                const result = await updateSubmissionAction(
                  snapshot.submission.submission.id,
                  {
                    mutationId: createClientId(),
                    expectedVersion: snapshot.submission.submission.version,
                    title,
                    requirementDescription,
                    targetBranches,
                  },
                );
                if (!result.ok) {
                  setError(result.error.message);
                  return;
                }
                dispatch({
                  type: 'UPDATE_SUBMISSION',
                  submission: result.result,
                });
                await refreshSnapshot(result.result.workspaceRevision);
                setNotice('提测信息已更新。');
                setError(null);
              } catch (actionError) {
                setError(
                  messageOf(actionError, '保存提测信息失败，请稍后重试。'),
                );
              }
            });
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
          onKeyDown={resizeSidebarWithKeyboard}
          onLostPointerCapture={finishSidebarResize}
          onPointerCancel={cancelSidebarResize}
          onPointerDown={beginSidebarResize}
          onPointerMove={resizeSidebar}
          onPointerUp={finishSidebarResize}
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
