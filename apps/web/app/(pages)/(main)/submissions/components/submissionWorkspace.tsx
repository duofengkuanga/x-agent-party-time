'use client';

import { messageOf } from '@/app/(pages)/(main)/components/actionError';
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
import type { User } from '@/contracts/auth';
import { createClientId } from '@/app/(pages)/(main)/components/clientId';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '@/app/(pages)/(main)/components/sidebarWidth';
import {
  SubmissionWorkspaceSnapshotSchema,
  type SubmissionWorkspaceSnapshot,
} from '@/contracts/submissions/workspace';
import { BugBoard } from '@/app/(pages)/(main)/submissions/[submissionId]/bugs/bugBoard';
import {
  closeSubmissionAction,
  resolveCleanupInteractionAction,
  retryCleanupAction,
} from '@/app/actions/submissions/lifecycle';
import {
  type SubmissionCreationCatalog,
  type SubmissionSummary,
} from '../../../../../contracts/submissions/submission';
import {
  loadSubmissionCreationCatalogAction,
  updateSubmissionAction,
} from '../../../../actions/submissions/submissions';
import { EnvironmentStatus } from './environmentStatus';
import { SubmissionComposer } from './submissionComposer';
import type { SubmissionDraft } from './submissionDraft';
import { workspaceReducer, parseInvalidation } from './workspaceState';
import { useSidebarWidth } from './sidebarPreference';
import { SubmissionRail } from './submissionRail';
import Link from 'next/link';

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
  initialSnapshot: SubmissionWorkspaceSnapshot | null;
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
  const creationDrafts = useRef(new Map<string, SubmissionDraft>());
  const draftKey = `${currentUser.id}:${snapshot?.submission.submission.projectId ?? 'new'}`;
  const saveCreationDraft = useCallback(
    (draft: SubmissionDraft) => {
      creationDrafts.current.set(draftKey, draft);
    },
    [draftKey],
  );
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
          let next: SubmissionWorkspaceSnapshot;
          do {
            const response = await fetch(
              `/api/submissions/${encodeURIComponent(selectedId)}/workspace`,
              { cache: 'no-store' },
            );
            const body = await response.json();
            if (!response.ok) {
              setError(body.error?.message ?? '无法刷新提测工作区');
              dispatch({ type: 'SET_SYNC_STATE', syncState: 'reconnecting' });
              return;
            }
            next = SubmissionWorkspaceSnapshotSchema.parse(body);
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
      `/api/submissions/events?submissionId=${encodeURIComponent(selectedId)}`,
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
    router.push(`/submissions/${submissionId}`);
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
                key={`${currentUser.id}:${snapshot.submission.submission.id}`}
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
          context={
            snapshot
              ? {
                  projectId: snapshot.submission.submission.projectId,
                  testerUserId: snapshot.submission.tester.id,
                }
              : null
          }
          savedDraft={creationDrafts.current.get(draftKey) ?? null}
          onDraftChange={saveCreationDraft}
          onDiscard={() => {
            creationDrafts.current.delete(draftKey);
            setShowCreateSubmission(false);
          }}
          onClose={() => setShowCreateSubmission(false)}
          onCreated={(submissionId) => {
            creationDrafts.current.delete(draftKey);
            setShowCreateSubmission(false);
            router.push(`/submissions/${submissionId}`);
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

function SubmissionComposerLoading({ onClose }: { onClose: () => void }) {
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

function EmptyStage({
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
        <Link href="/projects">我的项目</Link>
      </div>
    </div>
  );
}
