'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { User } from '@/platform/auth/contract';
import { logoutAction } from '@/app/logout/action';
import {
  CookingWorkspaceSnapshotSchema,
  type CookingWorkspaceSnapshot,
} from '@/modules/cooking/workspace/contract';
import { BugBoard } from '@/modules/cooking/bugs/presentation/bug-board';
import {
  WorkspaceInvalidationSchema,
  type SubmissionCreationCatalog,
  type SubmissionSummary,
} from '../contract';
import {
  loadSubmissionCreationCatalogAction,
  updateSubmissionAction,
} from './actions';
import { SubmissionComposer } from './submission-composer';

const SIDEBAR_STORAGE_KEY = 'agent-party-time:collab-sidebar-width';
const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 560;
const STAGE_MIN_WIDTH = 480;

type Theme = 'paper' | 'night';
type SyncState = 'connected' | 'reconnecting' | 'syncing';
type CollabLayoutStyle = CSSProperties & {
  '--collab-rail-expanded-width': string;
};

type WorkspaceState = {
  snapshot: CookingWorkspaceSnapshot | null;
  submissions: SubmissionSummary[];
  syncState: SyncState;
};

type WorkspaceAction =
  | {
      type: 'RESET';
      snapshot: CookingWorkspaceSnapshot | null;
      submissions: SubmissionSummary[];
    }
  | { type: 'REPLACE_SNAPSHOT'; snapshot: CookingWorkspaceSnapshot }
  | { type: 'SET_SYNC_STATE'; syncState: SyncState }
  | { type: 'UPDATE_SUBMISSION'; submission: SubmissionSummary['submission'] };

export function SubmissionWorkspace({
  currentUser,
  initialSnapshot,
  initialSubmissions,
}: {
  currentUser: User;
  initialSnapshot: CookingWorkspaceSnapshot | null;
  initialSubmissions: SubmissionSummary[];
}) {
  const router = useRouter();
  const [theme, setTheme] = useState<Theme>('paper');
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
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
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
    const storedWidth = Number(
      window.localStorage.getItem(SIDEBAR_STORAGE_KEY),
    );
    if (Number.isFinite(storedWidth) && storedWidth > 0)
      setSidebarWidth(clampSidebarWidth(storedWidth));

    function fitSidebarToViewport() {
      setSidebarWidth((current) => clampSidebarWidth(current));
    }

    window.addEventListener('resize', fitSidebarToViewport);
    return () => window.removeEventListener('resize', fitSidebarToViewport);
  }, []);

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
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setSidebarWidth(finalWidth);
    setSidebarResizing(false);
    saveSidebarWidth(finalWidth);
  }

  function cancelSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sidebarDrag.current) return;
    const originalWidth = sidebarDrag.current.startWidth;
    sidebarDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
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

  const visibleSubmissions = includeClosed
    ? submissions
    : submissions.filter(({ submission }) => submission.status === 'ACTIVE');
  const layoutStyle: CollabLayoutStyle = {
    '--collab-rail-expanded-width': `${sidebarWidth}px`,
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
          <AccountMenu currentUser={currentUser} />
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
          detailOpen={showDetails}
          includeClosed={includeClosed}
          onBackToList={() => setShowDetails(false)}
          onCreate={openSubmissionComposer}
          onIncludeClosedChange={setIncludeClosed}
          onOpenDetails={(id) => {
            selectSubmission(id);
            setShowDetails(true);
            setSidebarCollapsed(false);
          }}
          onRefresh={() => void refreshSnapshot()}
          onSelect={selectSubmission}
          onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
          selectedId={selectedId}
          snapshot={snapshot}
          submissions={visibleSubmissions}
          syncState={syncState}
          updateDetails={(title, requirementDescription) => {
            if (!snapshot) return;
            startTransition(async () => {
              try {
                const result = await updateSubmissionAction(
                  snapshot.submission.submission.id,
                  {
                    mutationId: crypto.randomUUID(),
                    expectedVersion: snapshot.submission.submission.version,
                    title,
                    requirementDescription,
                  },
                );
                if (!result.ok) {
                  setError(result.error.message);
                  return;
                }
                const next = {
                  ...snapshot,
                  revision: result.submission.workspaceRevision,
                  submission: {
                    ...snapshot.submission,
                    submission: result.submission,
                  },
                };
                snapshotRef.current = next;
                dispatch({
                  type: 'UPDATE_SUBMISSION',
                  submission: result.submission,
                });
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
    </main>
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
            <span className="collab-section-label">多工程协作提测</span>
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

function SubmissionRail({
  collapsed,
  detailOpen,
  includeClosed,
  onBackToList,
  onCreate,
  onIncludeClosedChange,
  onOpenDetails,
  onRefresh,
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
  onCreate: () => void;
  onIncludeClosedChange: (value: boolean) => void;
  onOpenDetails: (id: string) => void;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onToggleCollapsed: () => void;
  selectedId: string | null;
  snapshot: CookingWorkspaceSnapshot | null;
  submissions: SubmissionSummary[];
  syncState: SyncState;
  updateDetails: (title: string, requirementDescription: string) => void;
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
                  snapshot={snapshot}
                  updateDetails={updateDetails}
                  updating={updating}
                />
              ) : (
                <p className="collab-rail__detail-loading">
                  正在加载提测单详情…
                </p>
              )}
            </div>
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

function SubmissionDetails({
  snapshot,
  updateDetails,
  updating,
}: {
  snapshot: CookingWorkspaceSnapshot;
  updateDetails: (title: string, requirementDescription: string) => void;
  updating: boolean;
}) {
  const view = snapshot.submission;
  const submission = view.submission;
  const [title, setTitle] = useState(submission.title);
  const [requirementDescription, setRequirementDescription] = useState(
    submission.requirementDescription,
  );
  const editable = view.availableActions.includes('EDIT_DETAILS');
  return (
    <header className="collab-submission-header">
      <dl className="collab-submission-facts">
        <div>
          <dt>项目</dt>
          <dd>{view.projectName}</dd>
        </div>
        <div>
          <dt>提测状态</dt>
          <dd>{submission.status === 'ACTIVE' ? '进行中' : '已关闭'}</dd>
        </div>
        <div>
          <dt>需求说明</dt>
          <dd>{submission.requirementDescription}</dd>
        </div>
        <div>
          <dt>测试负责人</dt>
          <dd>{view.tester.displayName}</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{formatDateTime(submission.createdAt)}</dd>
        </div>
      </dl>
      <div className="collab-submission-projects">
        <table aria-label="提测工程配置">
          <thead>
            <tr>
              <th>工程</th>
              <th>开发负责人</th>
              <th>目标分支</th>
              <th>测试环境 / 部署方式</th>
            </tr>
          </thead>
          <tbody>
            {view.items.map((item) => (
              <tr key={item.id}>
                <td>{item.engineering.name}</td>
                <td>{item.responsibleUser.displayName}</td>
                <td>{item.technical?.targetBranch ?? '仅负责人可见'}</td>
                <td>
                  {item.environment.name}
                  {item.technical
                    ? ` / ${
                        item.technical.deployment.kind === 'LOCAL_SCRIPT'
                          ? '本地脚本'
                          : '持续集成与部署'
                      }`
                    : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable ? (
        <form
          className="collab-form"
          onSubmit={(event) => {
            event.preventDefault();
            updateDetails(title, requirementDescription);
          }}
        >
          <label>
            <span>提测标题</span>
            <input
              maxLength={160}
              onChange={(event) => setTitle(event.target.value)}
              required
              value={title}
            />
          </label>
          <label>
            <span>需求说明</span>
            <textarea
              maxLength={8_000}
              onChange={(event) =>
                setRequirementDescription(event.target.value)
              }
              required
              rows={4}
              value={requirementDescription}
            />
          </label>
          <button disabled={updating} type="submit">
            {updating ? '正在保存…' : '保存提测信息'}
          </button>
        </form>
      ) : null}
    </header>
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
      <p>创建提测单前，请先确认项目、工程与 Runner 已配置。</p>
      <div className="collab-empty-stage__actions">
        <button className="collab-primary" onClick={onCreate} type="button">
          创建第一张提测单
        </button>
        <Link href="/cooking/projects">项目与工程</Link>
      </div>
    </div>
  );
}

function AccountMenu({ currentUser }: { currentUser: User }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function closeOnPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);
  return (
    <div
      className={`collab-account-menu${open ? ' collab-account-menu--open' : ''}`}
      ref={menuRef}
    >
      <button
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="打开账号菜单"
        className="account-badge"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="account-badge__copy">
          <strong>{currentUser.displayName}</strong>
          <small>协作成员</small>
        </span>
      </button>
      <div className="collab-account-menu__panel" hidden={!open}>
        <nav aria-label="账号导航" className="collab-account-menu__navigation">
          <span>工作区</span>
          <Link href="/cooking/projects">项目与工程</Link>
          <Link href="/cooking/runners">Runner 管理</Link>
        </nav>
        <form action={logoutAction}>
          <button type="submit">退出登录</button>
        </form>
      </div>
    </div>
  );
}

function clampSidebarWidth(width: number): number {
  if (typeof window === 'undefined')
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
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

function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case 'RESET':
      return {
        snapshot: action.snapshot,
        submissions: action.submissions,
        syncState: 'connected',
      };
    case 'REPLACE_SNAPSHOT':
      return {
        snapshot: action.snapshot,
        submissions: action.snapshot.submissions,
        syncState: state.syncState,
      };
    case 'SET_SYNC_STATE':
      return { ...state, syncState: action.syncState };
    case 'UPDATE_SUBMISSION':
      return {
        ...state,
        snapshot: state.snapshot
          ? {
              ...state.snapshot,
              revision: action.submission.workspaceRevision,
              submission: {
                ...state.snapshot.submission,
                submission: action.submission,
              },
            }
          : null,
        submissions: state.submissions.map((summary) =>
          summary.submission.id === action.submission.id
            ? { ...summary, submission: action.submission }
            : summary,
        ),
      };
  }
}

function formatCompactDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value));
}

function parseInvalidation(value: string) {
  try {
    const parsed = WorkspaceInvalidationSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
