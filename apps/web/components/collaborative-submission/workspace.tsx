'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type {
  CollaborativeCommand,
  TestSubmissionSummary,
} from '@agent-party-time/shared/control-plane';
import type { CurrentUser } from '@/lib/auth/core';
import { CookingAccountMenu } from '@/components/cooking-account-menu';
import { collaborativeCommand, collaborativeQuery, messageOf } from './client';
import { BugBoard, SubmissionRail } from './board';
import { SubmissionComposer } from './dialogs';
import type { Theme, WorkspaceSnapshot } from './model';

const SIDEBAR_STORAGE_KEY = 'agent-party-time:collab-sidebar-width';
const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 560;
const STAGE_MIN_WIDTH = 480;

type CollabLayoutStyle = CSSProperties & {
  '--collab-rail-expanded-width': string;
};

function clampSidebarWidth(width: number) {
  if (typeof window === 'undefined') {
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
  }
  const viewportMaximum = Math.max(
    SIDEBAR_MIN_WIDTH,
    window.innerWidth - STAGE_MIN_WIDTH,
  );
  return Math.round(
    Math.min(
      SIDEBAR_MAX_WIDTH,
      viewportMaximum,
      Math.max(SIDEBAR_MIN_WIDTH, width),
    ),
  );
}

export function CollaborativeSubmissionWorkspace({
  currentUser,
  registeredUsers,
}: {
  currentUser: CurrentUser;
  registeredUsers: CurrentUser[];
}) {
  const [theme, setTheme] = useState<Theme>('paper');
  const [submissions, setSubmissions] = useState<TestSubmissionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showCreateSubmission, setShowCreateSubmission] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [includeClosed, setIncludeClosed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const refreshInFlight = useRef(false);
  const sidebarDrag = useRef<{
    currentWidth: number;
    startWidth: number;
    startX: number;
  } | null>(null);
  const isDeveloper = currentUser.accountType === 'DEVELOPER';

  const loadSubmissions = useCallback(
    async (preferredId?: string | null) => {
      const result = await collaborativeQuery({
        kind: 'submission.list',
        includeClosed,
      });
      const next = result.submissions ?? [];
      setSubmissions(next);
      const candidate = preferredId ?? selectedId;
      const nextId = next.some((item) => item.id === candidate)
        ? candidate
        : (next[0]?.id ?? null);
      setSelectedId(nextId);
      return nextId;
    },
    [includeClosed, selectedId],
  );

  const loadSnapshot = useCallback(
    async (submissionId: string) => {
      const [submissionResult, boardResult] = await Promise.all([
        collaborativeQuery({ kind: 'submission.get', submissionId }),
        collaborativeQuery({ kind: 'bug.board', submissionId }),
      ]);
      if (!submissionResult.submission)
        throw new Error('控制平面未返回提测单详情');
      const submission = submissionResult.submission;
      const itemOperations = await Promise.all(
        submission.items.map(async (item) => {
          const [repairResult, updateResult, interactionResult] =
            await Promise.all([
              isDeveloper
                ? collaborativeQuery({
                    kind: 'repair_queue.get',
                    submissionItemId: item.id,
                  })
                : Promise.resolve(null),
              collaborativeQuery({
                kind: 'update_batches.list',
                submissionItemId: item.id,
              }),
              isDeveloper && currentUser.id === item.responsibleDeveloper.id
                ? collaborativeQuery({
                    kind: 'interactions.list',
                    submissionItemId: item.id,
                    pendingOnly: true,
                  })
                : Promise.resolve(null),
            ]);
          return {
            itemId: item.id,
            repairTasks: repairResult?.repairTasks ?? [],
            updateBatches: updateResult.updateBatches ?? [],
            interactions: interactionResult?.interactions ?? [],
          };
        }),
      );
      setSnapshot({
        submission,
        bugs: boardResult.bugs ?? [],
        repairQueues: Object.fromEntries(
          itemOperations.map((item) => [item.itemId, item.repairTasks]),
        ),
        updateBatches: Object.fromEntries(
          itemOperations.map((item) => [item.itemId, item.updateBatches]),
        ),
        interactions: Object.fromEntries(
          itemOperations.map((item) => [item.itemId, item.interactions]),
        ),
      });
    },
    [isDeveloper],
  );

  const refresh = useCallback(
    async (preferredId?: string | null, quiet = false) => {
      if (refreshInFlight.current) return;
      refreshInFlight.current = true;
      if (!quiet) setRefreshing(true);
      try {
        const nextId = await loadSubmissions(preferredId);
        if (nextId) await loadSnapshot(nextId);
        else setSnapshot(null);
        setError(null);
      } catch (requestError) {
        if (!quiet) setError(messageOf(requestError, '无法刷新协作提测工作台'));
      } finally {
        refreshInFlight.current = false;
        if (!quiet) setRefreshing(false);
        setLoading(false);
      }
    },
    [loadSnapshot, loadSubmissions],
  );

  useEffect(() => {
    const storedWidth = Number(
      window.localStorage.getItem(SIDEBAR_STORAGE_KEY),
    );
    if (Number.isFinite(storedWidth) && storedWidth > 0) {
      setSidebarWidth(clampSidebarWidth(storedWidth));
    }

    function fitSidebarToViewport() {
      setSidebarWidth((current) => clampSidebarWidth(current));
    }

    window.addEventListener('resize', fitSidebarToViewport);
    return () => window.removeEventListener('resize', fitSidebarToViewport);
  }, []);

  useEffect(() => {
    void refresh();
  }, [includeClosed]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedId) return;
    void loadSnapshot(selectedId).catch((requestError) =>
      setError(messageOf(requestError, '无法读取提测单详情')),
    );
  }, [loadSnapshot, selectedId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh(selectedId, true);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [refresh, selectedId]);

  const mutate = useCallback(
    (command: CollaborativeCommand, successMessage: string | null) =>
      new Promise<boolean>((resolve) => {
        startTransition(async () => {
          try {
            const result = await collaborativeCommand(command);
            const preferredId =
              result.submission?.id ?? snapshot?.submission.id;
            await refresh(preferredId);
            setNotice(successMessage);
            setError(null);
            resolve(true);
          } catch (requestError) {
            setError(messageOf(requestError, '操作失败'));
            resolve(false);
          }
        });
      }),
    [refresh, snapshot?.submission.id],
  );

  const selectedSummary = submissions.find((item) => item.id === selectedId);

  function saveSidebarWidth(width: number) {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(width));
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
    setSidebarWidth(nextWidth);
  }

  function finishSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sidebarDrag.current) return;
    const finalWidth = sidebarDrag.current.currentWidth;
    sidebarDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setSidebarWidth(finalWidth);
    setSidebarResizing(false);
    saveSidebarWidth(finalWidth);
  }

  function cancelSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sidebarDrag.current) return;
    const originalWidth = sidebarDrag.current.startWidth;
    sidebarDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setSidebarWidth(originalWidth);
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
    setSidebarWidth(nextWidth);
    saveSidebarWidth(nextWidth);
  }

  const layoutStyle: CollabLayoutStyle = {
    '--collab-rail-expanded-width': sidebarWidth + 'px',
  };

  return (
    <main className="collab-shell" data-theme={theme}>
      <header className="collab-topbar">
        <div className="brand-lockup">
          <Link className="brand" href="/cooking">
            Agent Party <span className="stamp">Time</span>
          </Link>
          <span
            aria-label="agents talk, humans watch"
            className="brand-note brand-note--manifesto"
          >
            <strong>agents</strong>
            <b>talk,</b>
            <strong>humans</strong>
            <b>watch</b>
          </span>
        </div>
        <div className="collab-topbar__actions">
          <button
            aria-label={theme === 'paper' ? '切换暗夜主题' : '切换纸张主题'}
            className="collab-quiet-button"
            onClick={() =>
              setTheme((current) => (current === 'paper' ? 'night' : 'paper'))
            }
            type="button"
          >
            {theme === 'paper' ? '◐ 暗夜' : '◑ 纸张'}
          </button>
          <CookingAccountMenu
            currentArea="workspace"
            currentUser={currentUser}
          />
        </div>
      </header>

      <div
        className="collab-layout"
        data-sidebar-collapsed={sidebarCollapsed ? 'true' : undefined}
        data-sidebar-mode={showDetails ? 'detail' : 'list'}
        data-sidebar-resizing={sidebarResizing ? 'true' : undefined}
        style={layoutStyle}
      >
        <SubmissionRail
          collapsed={sidebarCollapsed}
          currentUser={currentUser}
          detailOpen={showDetails}
          includeClosed={includeClosed}
          loading={loading}
          mutate={mutate}
          onBackToList={() => setShowDetails(false)}
          onCloseSubmission={() => {
            if (!snapshot) return;
            void mutate(
              {
                kind: 'submission.close',
                submissionId: snapshot.submission.id,
              },
              '提测单已关闭，环境锁已释放，清理任务已排队。',
            );
          }}
          onCreate={() => setShowCreateSubmission(true)}
          onIncludeClosedChange={setIncludeClosed}
          onOpenDetails={(id) => {
            setSelectedId(id);
            setShowDetails(true);
            setSidebarCollapsed(false);
          }}
          onRefresh={() => void refresh(selectedId)}
          onSelect={setSelectedId}
          onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
          pending={pending}
          refreshing={refreshing}
          selectedId={selectedId}
          snapshot={snapshot}
          submissions={submissions}
        />

        <div
          aria-controls="collab-submission-rail"
          aria-label="调整提测单侧边栏宽度"
          aria-orientation="vertical"
          aria-valuemax={clampSidebarWidth(SIDEBAR_MAX_WIDTH)}
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
                currentUser={currentUser}
                mutate={mutate}
                onBugSaved={async (_bugId, message) => {
                  setNotice(message);
                  await refresh(snapshot.submission.id);
                }}
                pending={pending}
                snapshot={snapshot}
              />
            </div>
          ) : (
            <EmptyStage
              canCreate={isDeveloper}
              hasSubmissions={submissions.length > 0}
              loading={loading}
              onCreate={() => setShowCreateSubmission(true)}
              selectedTitle={selectedSummary?.title}
            />
          )}
        </section>
      </div>

      {showCreateSubmission && isDeveloper ? (
        <SubmissionComposer
          currentUser={currentUser}
          onClose={() => setShowCreateSubmission(false)}
          onCreated={async (submissionId) => {
            setShowCreateSubmission(false);
            setNotice('多工程提测单已创建，所选环境已锁定。');
            await refresh(submissionId);
          }}
          registeredUsers={registeredUsers}
        />
      ) : null}
    </main>
  );
}

function EmptyStage({
  loading,
  hasSubmissions,
  canCreate,
  selectedTitle,
  onCreate,
}: {
  loading: boolean;
  hasSubmissions: boolean;
  canCreate: boolean;
  selectedTitle?: string;
  onCreate: () => void;
}) {
  return (
    <div className="collab-empty-stage">
      <h1>
        {loading
          ? '正在加载提测单…'
          : (selectedTitle ??
            (hasSubmissions
              ? '请选择提测单'
              : canCreate
                ? '暂无提测单'
                : '暂无分配给你的提测单'))}
      </h1>
      <p>
        {loading
          ? '请稍候。'
          : hasSubmissions
            ? '从左侧列表选择一张提测单查看详情。'
            : canCreate
              ? '创建提测单前，请先确认项目、工程与执行器已配置。'
              : '开发人员分配提测单后，会显示在这里。'}
      </p>
      {!loading && canCreate && !hasSubmissions ? (
        <div className="collab-empty-stage__actions">
          <button className="collab-primary" onClick={onCreate}>
            创建第一张提测单
          </button>
          <Link href="/cooking/projects">项目与工程</Link>
        </div>
      ) : null}
    </div>
  );
}
