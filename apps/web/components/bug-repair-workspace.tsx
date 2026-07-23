'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type DragEvent,
  type FormEvent,
  type RefObject,
} from 'react';
import type {
  BugStatus,
  BugSummary,
  ProjectSummary,
  PromptTemplateSummary,
  RepairDispatchSummary,
} from '@agent-party-time/shared/control-plane';
import type {
  PublicBugDetail,
  PublicDeploymentBatch,
  PublicRepairAttempt,
} from '@/lib/control-plane/public';
import type { CurrentUser } from '@/lib/auth/core';
import { AccountBadge } from '@/components/account-badge';
import { EngineeringCatalogDialog } from '@/components/engineering-catalog-dialog';
import {
  ProjectCollaborationDialog,
  ProjectInvitationInbox,
} from '@/components/project-collaboration-dialog';

const COLUMNS: Array<{
  status: BugStatus;
  label: string;
  mark: string;
}> = [
  { status: 'waiting_for_repair', label: '待修复', mark: '○' },
  { status: 'repairing', label: '修复中', mark: '↻' },
  { status: 'repair_ready', label: '修复就绪', mark: '✓' },
  { status: 'deploying', label: '部署处理中', mark: '↻' },
  { status: 'waiting_for_verification', label: '待验证', mark: '◇' },
  { status: 'done', label: '已完成', mark: '●' },
];

interface ListResponse<T> {
  items?: T[];
  error?: string;
}

export function BugRepairWorkspace({
  currentUser,
  registeredDevelopers,
}: {
  currentUser: CurrentUser;
  registeredDevelopers: CurrentUser[];
}) {
  const canManageProjects = currentUser.accountType === 'DEVELOPER';
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [bugs, setBugs] = useState<BugSummary[]>([]);
  const [repairDispatches, setRepairDispatches] = useState<
    RepairDispatchSummary[]
  >([]);
  const [deploymentBatches, setDeploymentBatches] = useState<
    PublicDeploymentBatch[]
  >([]);
  const [detail, setDetail] = useState<PublicBugDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [renamingProject, setRenamingProject] = useState<ProjectSummary | null>(
    null,
  );
  const [collaborationProject, setCollaborationProject] =
    useState<ProjectSummary | null>(null);
  const [engineeringProject, setEngineeringProject] =
    useState<ProjectSummary | null>(null);
  const [invitationInboxOpen, setInvitationInboxOpen] = useState(false);
  const [promptTemplates, setPromptTemplates] = useState<
    PromptTemplateSummary[] | null
  >(null);
  const [promptViewerOpen, setPromptViewerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dismissedNotices, setDismissedNotices] = useState<Set<string>>(
    () => new Set(),
  );
  const [draggingBugId, setDraggingBugId] = useState<string | null>(null);
  const [dropTargetStatus, setDropTargetStatus] = useState<BugStatus | null>(
    null,
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [boardPending, startBoardTransition] = useTransition();
  const detailRequest = useRef(0);
  const boardRequest = useRef(0);

  const refreshProjects = useCallback(async () => {
    if (currentUser.accountType !== 'DEVELOPER') {
      setProjects([]);
      setProjectId('');
      return;
    }
    const response = await fetch('/api/control-plane/projects', {
      cache: 'no-store',
    });
    const result = (await response.json()) as ListResponse<ProjectSummary>;
    if (!response.ok) throw new Error(result.error ?? '无法读取项目');
    setProjects(result.items ?? []);
    setProjectId((current) =>
      result.items?.some((project) => project.id === current)
        ? current
        : (result.items?.[0]?.id ?? ''),
    );
  }, [currentUser.accountType]);

  const refreshBoard = useCallback(async (selectedProjectId: string) => {
    const requestNumber = ++boardRequest.current;
    if (!selectedProjectId) {
      setBugs([]);
      setRepairDispatches([]);
      setDeploymentBatches([]);
      return;
    }
    const query = encodeURIComponent(selectedProjectId);
    const [bugsResponse, dispatchesResponse, deploymentsResponse] =
      await Promise.all([
        fetch(`/api/control-plane/bugs?projectId=${query}`, {
          cache: 'no-store',
        }),
        fetch(`/api/control-plane/repair-dispatches?projectId=${query}`, {
          cache: 'no-store',
        }),
        fetch(`/api/control-plane/deployment-batches?projectId=${query}`, {
          cache: 'no-store',
        }),
      ]);
    const [bugsResult, dispatchesResult, deploymentsResult] = await Promise.all(
      [
        bugsResponse.json() as Promise<ListResponse<BugSummary>>,
        dispatchesResponse.json() as Promise<
          ListResponse<RepairDispatchSummary>
        >,
        deploymentsResponse.json() as Promise<
          ListResponse<PublicDeploymentBatch>
        >,
      ],
    );
    if (!bugsResponse.ok) throw new Error(bugsResult.error ?? '无法读取 Bug');
    if (!dispatchesResponse.ok)
      throw new Error(dispatchesResult.error ?? '无法读取修复队列');
    if (!deploymentsResponse.ok)
      throw new Error(deploymentsResult.error ?? '无法读取部署队列');
    if (boardRequest.current !== requestNumber) return;
    setBugs(bugsResult.items ?? []);
    setRepairDispatches(dispatchesResult.items ?? []);
    setDeploymentBatches(deploymentsResult.items ?? []);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await refreshProjects();
        setError(null);
      } catch (requestError) {
        setError(messageOf(requestError, '无法连接控制平面'));
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshProjects]);

  useEffect(() => {
    const refresh = () =>
      void refreshBoard(projectId).catch((requestError) =>
        setError(messageOf(requestError, '无法读取看板')),
      );
    refresh();
    if (!projectId) return;
    const timer = window.setInterval(refresh, 2_000);
    return () => window.clearInterval(timer);
  }, [projectId, refreshBoard]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const grouped = useMemo(
    () =>
      Object.fromEntries(
        COLUMNS.map((column) => [
          column.status,
          bugs.filter((bug) => bug.status === column.status),
        ]),
      ) as Record<BugStatus, BugSummary[]>,
    [bugs],
  );
  const deploymentById = useMemo(
    () => new Map(deploymentBatches.map((batch) => [batch.id, batch])),
    [deploymentBatches],
  );
  const selectedProject =
    projects.find((project) => project.id === projectId) ?? null;

  async function openDetail(bugId: string) {
    const requestNumber = ++detailRequest.current;
    setDetail(null);
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/control-plane/bugs/${bugId}`, {
        cache: 'no-store',
      });
      const result = (await response.json()) as {
        bug?: PublicBugDetail;
        error?: string;
      };
      if (!response.ok || !result.bug)
        throw new Error(result.error ?? '无法读取 Bug 详情');
      if (detailRequest.current === requestNumber) setDetail(result.bug);
    } catch (requestError) {
      if (detailRequest.current === requestNumber)
        setError(messageOf(requestError, '无法读取 Bug 详情'));
    } finally {
      if (detailRequest.current === requestNumber) setDetailLoading(false);
    }
  }

  function closeDetail() {
    detailRequest.current += 1;
    setDetail(null);
    setDetailLoading(false);
  }

  async function mutation(
    url: string,
    init: RequestInit,
    fallback: string,
    detailBugId?: string,
  ) {
    const response = await fetch(url, init);
    const result = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(result.error ?? fallback);
    await refreshBoard(projectId);
    if (detailBugId) await openDetail(detailBugId);
    setError(null);
  }

  function moveBug(bugId: string, targetStatus: BugStatus) {
    const bug = bugs.find((item) => item.id === bugId);
    if (!bug || bug.status === targetStatus) return;
    const action = boardActionForMove(bug, targetStatus);
    if (!action) {
      setError('该状态转换不能通过拖拽执行');
      return;
    }
    if (
      action === 'enqueue-deployment' &&
      !window.confirm(
        `确认授权部署 ${bug.shortId}？加入批次后不能单独移出，Codex 将按批次执行项目部署流程。`,
      )
    )
      return;

    startBoardTransition(async () => {
      try {
        if (action === 'enqueue-deployment') {
          await mutation(
            `/api/control-plane/bugs/${bugId}/deployment`,
            {
              method: 'POST',
              headers: {
                'idempotency-key': `web-deployment-enqueue:${crypto.randomUUID()}`,
              },
            },
            '无法加入部署批次',
          );
          return;
        }
        const repairAction = action === 'enqueue-repair' ? 'enqueue' : 'return';
        await mutation(
          `/api/control-plane/bugs/${bugId}/repair`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `web-repair:${repairAction}:${crypto.randomUUID()}`,
            },
            body: JSON.stringify({ action: repairAction }),
          },
          '无法更新 Bug 修复状态',
        );
      } catch (requestError) {
        setError(messageOf(requestError, '无法更新 Bug 状态'));
      }
    });
  }

  function dropBug(event: DragEvent<HTMLElement>, status: BugStatus) {
    event.preventDefault();
    const bugId = event.dataTransfer.getData('application/x-bug-id');
    setDraggingBugId(null);
    setDropTargetStatus(null);
    if (bugId) moveBug(bugId, status);
  }

  function updateDropTarget(status: BugStatus) {
    const bug = bugs.find((item) => item.id === draggingBugId);
    const isValid = bug ? boardActionForMove(bug, status) !== null : false;
    const nextStatus = isValid ? status : null;
    setDropTargetStatus((current) =>
      current === nextStatus ? current : nextStatus,
    );
    return isValid;
  }

  function closeDispatch(dispatchId: string) {
    startBoardTransition(async () => {
      try {
        await mutation(
          `/api/control-plane/repair-dispatches/${dispatchId}/close`,
          {
            method: 'POST',
            headers: {
              'idempotency-key': `web-dispatch-close:${crypto.randomUUID()}`,
            },
          },
          '无法立即开始修复',
        );
      } catch (requestError) {
        setError(messageOf(requestError, '无法立即开始修复'));
      }
    });
  }

  function closeDeployment(batchId: string) {
    startBoardTransition(async () => {
      try {
        await mutation(
          `/api/control-plane/deployment-batches/${batchId}/close`,
          {
            method: 'POST',
            headers: {
              'idempotency-key': `web-deployment-close:${crypto.randomUUID()}`,
            },
          },
          '无法立即开始部署',
        );
      } catch (requestError) {
        setError(messageOf(requestError, '无法立即开始部署'));
      }
    });
  }

  async function openPromptViewer() {
    setPromptViewerOpen(true);
    if (promptTemplates) return;
    try {
      const response = await fetch('/api/control-plane/prompt-templates', {
        cache: 'no-store',
      });
      const result =
        (await response.json()) as ListResponse<PromptTemplateSummary>;
      if (!response.ok) throw new Error(result.error ?? '无法读取提示词模板');
      setPromptTemplates(result.items ?? []);
    } catch (requestError) {
      setError(messageOf(requestError, '无法读取提示词模板'));
      setPromptViewerOpen(false);
    }
  }

  const activeDeploymentBatches = deploymentBatches.filter((batch) =>
    [
      'collecting',
      'queued',
      'running',
      'blocked',
      'failed',
      'unknown',
    ].includes(batch.state),
  );

  return (
    <main className="party-shell repair-workspace">
      <header className="topbar">
        <div className="brand-lockup">
          <Link className="brand" href="/">
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
        <div className="repair-topbar__end">
          <nav aria-label="场景" className="scene-links">
            <span aria-current="page">缺陷修复</span>
            {canManageProjects ? <Link href="/">频道现场</Link> : null}
          </nav>
          <AccountBadge user={currentUser} />
        </div>
      </header>

      <section className="repair-toolbar">
        <div>
          <h1 className="repair-title">
            <span>智能体正在</span>
            <strong>修复</strong>
          </h1>
        </div>
        <div className="repair-toolbar__actions">
          {canManageProjects ? (
            <button
              className="repair-secondary project-inbox-trigger"
              onClick={() => setInvitationInboxOpen(true)}
              type="button"
            >
              项目邀请
            </button>
          ) : null}
          <button
            className="repair-secondary"
            onClick={() => void openPromptViewer()}
            type="button"
          >
            执行规则
          </button>
          <div className="project-picker">
            <label>
              <span>项目</span>
              <select
                disabled={projects.length === 0}
                onChange={(event) => setProjectId(event.target.value)}
                value={projectId}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title ?? project.slug}
                  </option>
                ))}
              </select>
            </label>
            {selectedProject?.memberRole === 'OWNER' ? (
              <button
                aria-label="修改项目名称"
                className="project-name-action"
                disabled={!selectedProject}
                onClick={() =>
                  selectedProject && setRenamingProject(selectedProject)
                }
                title="修改项目名称"
                type="button"
              >
                ✎
              </button>
            ) : null}
          </div>
          {selectedProject ? (
            <button
              className="repair-secondary"
              onClick={() => setEngineeringProject(selectedProject)}
              type="button"
            >
              工程目录
            </button>
          ) : null}
          {selectedProject ? (
            <button
              className="repair-secondary"
              onClick={() => setCollaborationProject(selectedProject)}
              type="button"
            >
              项目成员
            </button>
          ) : null}
          <button
            className="repair-primary"
            disabled={!projectId}
            onClick={() => setCreateOpen(true)}
            type="button"
          >
            + 新建 Bug
          </button>
        </div>
      </section>

      {error ? (
        <div className="repair-alert" role="alert">
          {error}
          <button onClick={() => setError(null)} type="button">
            ×
          </button>
        </div>
      ) : null}

      <StatusNotices
        bugs={bugs}
        dismissed={dismissedNotices}
        onDismiss={(key) =>
          setDismissedNotices((current) => new Set(current).add(key))
        }
      />

      {loading ? (
        <p className="repair-loading">正在读取控制平面…</p>
      ) : projects.length === 0 && canManageProjects ? (
        <EmptyProject onCreated={refreshProjects} />
      ) : projects.length === 0 ? (
        <section className="empty-project empty-project--readonly">
          <div>
            <p className="repair-kicker">暂无提测单</p>
            <h2>等待开发人员准备现场</h2>
            <p>项目和提测环境准备完成后，你可以在这里新建并跟踪 Bug。</p>
          </div>
        </section>
      ) : (
        <section aria-label="Bug 状态看板" className="bug-board">
          {COLUMNS.map((column) => (
            <section
              className={`bug-column${dropTargetStatus === column.status ? ' bug-column--drop-target' : ''}`}
              key={column.status}
              onDragEnter={() => updateDropTarget(column.status)}
              onDragOver={(event) => {
                if (updateDropTarget(column.status)) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={(event) => dropBug(event, column.status)}
            >
              <header className="bug-column__header">
                <span className="status-mark" aria-hidden="true">
                  {column.mark}
                </span>
                <strong>{column.label}</strong>
                <span>{grouped[column.status].length}</span>
              </header>
              {column.status === 'repairing' && repairDispatches.length > 0 ? (
                <RepairDispatchQueue
                  dispatches={repairDispatches}
                  nowMs={nowMs}
                  onClose={closeDispatch}
                  pending={boardPending}
                />
              ) : null}
              {column.status === 'deploying' &&
              activeDeploymentBatches.length > 0 ? (
                <DeploymentBatchQueue
                  batches={activeDeploymentBatches}
                  nowMs={nowMs}
                  onClose={closeDeployment}
                  pending={boardPending}
                />
              ) : null}
              <div className="bug-column__body">
                {grouped[column.status].map((bug) => (
                  <button
                    className={`bug-card${canDragBug(bug, repairDispatches) ? ' bug-card--draggable' : ''}`}
                    draggable={canDragBug(bug, repairDispatches)}
                    key={bug.id}
                    onClick={() => void openDetail(bug.id)}
                    onDragStart={(event) => {
                      setDraggingBugId(bug.id);
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData(
                        'application/x-bug-id',
                        bug.id,
                      );
                    }}
                    onDragEnd={() => {
                      setDraggingBugId(null);
                      setDropTargetStatus(null);
                    }}
                    type="button"
                  >
                    <span className="bug-card__mark" aria-hidden="true">
                      {column.mark}
                    </span>
                    <span className="bug-card__copy">
                      <small>{bug.shortId}</small>
                      <strong>{bug.title}</strong>
                    </span>
                    <span className="bug-card__status">
                      {bugStateLabel(bug) ?? column.label}
                    </span>
                    {isBugExecuting(bug) ? (
                      <span
                        aria-label={
                          bug.status === 'repairing'
                            ? 'Codex 正在修复'
                            : 'Codex 正在部署'
                        }
                        className="bug-card__progress"
                        role="progressbar"
                      >
                        <span />
                      </span>
                    ) : null}
                  </button>
                ))}
                {grouped[column.status].length === 0 ? (
                  <p className="bug-column__empty">暂无缺陷</p>
                ) : null}
              </div>
            </section>
          ))}
        </section>
      )}

      {createOpen ? (
        <BugCreateDialog
          onClose={() => setCreateOpen(false)}
          onCreated={async (bug) => {
            setCreateOpen(false);
            await refreshBoard(projectId);
            setDetail(bug);
          }}
          projectId={projectId}
        />
      ) : null}

      {renamingProject && canManageProjects ? (
        <ProjectNameDialog
          onClose={() => setRenamingProject(null)}
          onRenamed={async () => {
            setRenamingProject(null);
            await refreshProjects();
          }}
          project={renamingProject}
        />
      ) : null}

      {collaborationProject ? (
        <ProjectCollaborationDialog
          currentUser={currentUser}
          developers={registeredDevelopers}
          onChanged={refreshProjects}
          onClose={() => setCollaborationProject(null)}
          project={collaborationProject}
        />
      ) : null}

      {engineeringProject ? (
        <EngineeringCatalogDialog
          currentUser={currentUser}
          onClose={() => setEngineeringProject(null)}
          project={engineeringProject}
        />
      ) : null}

      {invitationInboxOpen ? (
        <ProjectInvitationInbox
          onChanged={refreshProjects}
          onClose={() => setInvitationInboxOpen(false)}
        />
      ) : null}

      {detail || detailLoading ? (
        <BugDrawer
          batch={
            detail?.deploymentBatchId
              ? (deploymentById.get(detail.deploymentBatchId) ?? null)
              : null
          }
          bug={detail}
          loading={detailLoading}
          onCancelDeployment={async (batchId, bugId) =>
            mutation(
              `/api/control-plane/deployment-batches/${batchId}/cancel`,
              {
                method: 'POST',
                headers: {
                  'idempotency-key': `web-deployment-cancel:${crypto.randomUUID()}`,
                },
              },
              '无法取消部署批次',
              bugId,
            )
          }
          onCancelRepair={async (bugId) =>
            mutation(
              `/api/control-plane/bugs/${bugId}/repair/cancel`,
              {
                method: 'POST',
                headers: {
                  'idempotency-key': `web-repair-cancel:${crypto.randomUUID()}`,
                },
              },
              '无法取消修复',
              bugId,
            )
          }
          onClose={closeDetail}
          onContinueDeployment={async (batchId, bugId, feedback) =>
            mutation(
              `/api/control-plane/deployment-batches/${batchId}/continue`,
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'idempotency-key': `web-deployment-continue:${crypto.randomUUID()}`,
                },
                body: JSON.stringify({ feedback }),
              },
              '无法继续部署',
              bugId,
            )
          }
          onContinueRepair={async (bugId, feedback, reassign) =>
            mutation(
              `/api/control-plane/bugs/${bugId}/repair/continue`,
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'idempotency-key': `web-repair-continue:${crypto.randomUUID()}`,
                },
                body: JSON.stringify({ feedback, reassign }),
              },
              '无法继续修复',
              bugId,
            )
          }
          onVerifyFailed={async (bugId, form) =>
            mutation(
              `/api/control-plane/bugs/${bugId}/verify`,
              {
                method: 'POST',
                headers: {
                  'idempotency-key': `web-verify-fail:${crypto.randomUUID()}`,
                },
                body: form,
              },
              '无法提交验证失败',
              bugId,
            )
          }
          onVerifyPassed={async (bugId) =>
            mutation(
              `/api/control-plane/bugs/${bugId}/verify`,
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'idempotency-key': `web-verify-pass:${crypto.randomUUID()}`,
                },
                body: JSON.stringify({ action: 'pass' }),
              },
              '无法确认验证通过',
              bugId,
            )
          }
        />
      ) : null}

      {promptViewerOpen ? (
        <PromptTemplateViewer
          onClose={() => setPromptViewerOpen(false)}
          templates={promptTemplates}
        />
      ) : null}
    </main>
  );
}

function StatusNotices({
  bugs,
  dismissed,
  onDismiss,
}: {
  bugs: BugSummary[];
  dismissed: Set<string>;
  onDismiss: (key: string) => void;
}) {
  const notices = [
    bugs.some((bug) => bug.repairState === 'needs_input')
      ? {
          key: 'needs-input',
          mark: '?',
          text: '有修复等待补充信息。打开 Bug 详情后可继续原修复脉络。',
        }
      : null,
    bugs.some((bug) => bug.status === 'repair_ready')
      ? {
          key: 'repair-ready',
          mark: '✓',
          text: '候选修复已就绪。拖入“部署处理中”并确认，即完成部署授权。',
        }
      : null,
    bugs.some((bug) =>
      ['failed', 'unknown'].includes(bug.deploymentState ?? ''),
    )
      ? {
          key: 'deployment-attention',
          mark: '!',
          text: '有部署失败或结果未知。请在详情中确认原因，补充后整批继续。',
        }
      : null,
    bugs.some((bug) => bug.status === 'waiting_for_verification')
      ? {
          key: 'deployment-complete',
          mark: '◇',
          text: '部署已完成，成员 Bug 可分别验证通过或提交失败反馈。',
        }
      : null,
  ].filter((notice): notice is NonNullable<typeof notice> => Boolean(notice));

  const visible = notices.filter((notice) => !dismissed.has(notice.key));
  if (!visible.length) return null;
  return (
    <section aria-label="状态提示" className="repair-notices">
      {visible.map((notice) => (
        <div key={notice.key}>
          <b aria-hidden="true">{notice.mark}</b>
          <span>{notice.text}</span>
          <button
            aria-label="确认并关闭提示"
            onClick={() => onDismiss(notice.key)}
            type="button"
          >
            知道了
          </button>
        </div>
      ))}
    </section>
  );
}

function RepairDispatchQueue({
  dispatches,
  nowMs,
  pending,
  onClose,
}: {
  dispatches: RepairDispatchSummary[];
  nowMs: number;
  pending: boolean;
  onClose: (dispatchId: string) => void;
}) {
  let queuedPosition = 0;
  return (
    <div className="repair-dispatches" aria-label="修复收集队列">
      {dispatches.map((dispatch) => {
        if (dispatch.state === 'queued') queuedPosition += 1;
        const status =
          dispatch.state === 'collecting'
            ? formatCountdown(dispatch.closesAt, nowMs)
            : dispatch.state === 'claimed'
              ? 'Agent 已领取'
              : `排队 ${String(queuedPosition).padStart(2, '0')}`;
        return (
          <section className="repair-dispatch" key={dispatch.id}>
            <div>
              <strong>{status}</strong>
              <span>
                {dispatch.members.length} / {dispatch.config.maxBugs}
              </span>
            </div>
            {dispatch.state === 'collecting' ? (
              <button
                disabled={pending}
                onClick={() => onClose(dispatch.id)}
                type="button"
              >
                立即修复
              </button>
            ) : (
              <small>
                {dispatch.state === 'claimed' ? '等待执行' : '等待 Agent'}
              </small>
            )}
          </section>
        );
      })}
    </div>
  );
}

function DeploymentBatchQueue({
  batches,
  nowMs,
  pending,
  onClose,
}: {
  batches: PublicDeploymentBatch[];
  nowMs: number;
  pending: boolean;
  onClose: (batchId: string) => void;
}) {
  return (
    <div className="repair-dispatches deployment-batches" aria-label="部署批次">
      {batches.map((batch) => (
        <section className="repair-dispatch deployment-batch" key={batch.id}>
          <div>
            <strong>
              {batch.state === 'collecting'
                ? formatCountdown(batch.closesAt, nowMs)
                : deploymentBatchStateLabel(batch.state)}
            </strong>
            <span>
              {batch.members.length} / {batch.config.maxBugs}
            </span>
          </div>
          {batch.state === 'collecting' ? (
            <button
              disabled={pending}
              onClick={() => onClose(batch.id)}
              type="button"
            >
              立即部署
            </button>
          ) : (
            <small>
              {batch.state === 'running'
                ? 'Codex 执行中'
                : (batch.reason ?? '整批保持原子状态')}
            </small>
          )}
        </section>
      ))}
    </div>
  );
}

function canDragBug(bug: BugSummary, dispatches: RepairDispatchSummary[]) {
  if (bug.status === 'waiting_for_repair' || bug.status === 'repair_ready')
    return true;
  if (
    bug.status !== 'repairing' ||
    (bug.repairState !== 'collecting' && bug.repairState !== 'queued')
  )
    return false;
  return !dispatches.some(
    (dispatch) =>
      dispatch.id === bug.repairDispatchId && dispatch.state === 'claimed',
  );
}

function boardActionForMove(bug: BugSummary, targetStatus: BugStatus) {
  if (bug.status === 'waiting_for_repair' && targetStatus === 'repairing')
    return 'enqueue-repair' as const;
  if (
    bug.status === 'repairing' &&
    targetStatus === 'waiting_for_repair' &&
    (bug.repairState === 'collecting' || bug.repairState === 'queued')
  )
    return 'return-repair' as const;
  if (bug.status === 'repair_ready' && targetStatus === 'deploying')
    return 'enqueue-deployment' as const;
  return null;
}

function bugStateLabel(bug: BugSummary) {
  if (bug.status === 'repairing' && bug.repairState)
    return {
      collecting: '修复收集中',
      queued: '修复排队中',
      running: 'Codex 修复中',
      retrying: '基础设施重试中',
      needs_input: '等待补充',
      blocked: '修复受阻',
      failed: '修复失败',
      cancelled: '修复已取消',
    }[bug.repairState];
  if (bug.status === 'deploying' && bug.deploymentState)
    return deploymentBatchStateLabel(bug.deploymentState);
  return null;
}

function isBugExecuting(bug: BugSummary) {
  return (
    (bug.status === 'repairing' && bug.repairState === 'running') ||
    (bug.status === 'deploying' && bug.deploymentState === 'running')
  );
}

function deploymentBatchStateLabel(state: PublicDeploymentBatch['state']) {
  return {
    collecting: '部署收集中',
    queued: '部署排队中',
    running: 'Codex 部署中',
    blocked: '部署受阻',
    failed: '部署失败',
    unknown: '部署结果未知',
    deployed: '部署完成',
    cancelled: '部署已取消',
  }[state];
}

function formatCountdown(closesAt: string, nowMs: number) {
  const remainingSeconds = Math.max(
    0,
    Math.ceil((new Date(closesAt).getTime() - nowMs) / 1_000),
  );
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function EmptyProject({ onCreated }: { onCreated: () => Promise<void> }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      const response = await fetch('/api/control-plane/projects', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `web-project:${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          slug: String(form.get('slug') ?? ''),
          title: String(form.get('title') ?? '') || null,
        }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(result.error ?? '项目创建失败');
        return;
      }
      await onCreated();
    });
  }

  return (
    <section className="empty-project">
      <div>
        <p className="repair-kicker">私密项目</p>
        <h2>创建一个私密项目</h2>
        <p>
          项目代表产品或业务协作边界。创建后你会成为项目负责人，再邀请开发人员加入。
        </p>
      </div>
      <form onSubmit={submit}>
        <label>
          <span>项目标识</span>
          <input name="slug" placeholder="settlement-platform" required />
        </label>
        <label>
          <span>标题 / 选填</span>
          <input name="title" placeholder="结算服务" />
        </label>
        <button className="repair-primary" disabled={pending} type="submit">
          {pending ? '创建中…' : '创建项目'}
        </button>
        {error ? <p className="form-error">{error}</p> : null}
      </form>
    </section>
  );
}

function BugCreateDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (bug: PublicBugDetail) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const files = [...(fileInput.current?.files ?? [])];
    const validationError = validateFiles(files);
    if (validationError) {
      setError(validationError);
      return;
    }
    const data = new FormData(formElement);
    data.set('projectId', projectId);
    data.delete('attachments');
    for (const file of files) data.append('attachments', file);
    startTransition(async () => {
      try {
        const response = await fetch('/api/control-plane/bugs', {
          method: 'POST',
          headers: { 'idempotency-key': `web-bug:${crypto.randomUUID()}` },
          body: data,
        });
        const result = (await response.json()) as {
          bug?: PublicBugDetail;
          error?: string;
        };
        if (!response.ok || !result.bug)
          throw new Error(result.error ?? 'Bug 创建失败');
        await onCreated(result.bug);
      } catch (requestError) {
        setError(messageOf(requestError, 'Bug 创建失败'));
      }
    });
  }

  return (
    <div className="repair-overlay" role="presentation">
      <section
        aria-labelledby="create-bug-title"
        aria-modal="true"
        className="bug-dialog"
        role="dialog"
      >
        <header>
          <div>
            <p className="repair-kicker">新建缺陷</p>
            <h2 id="create-bug-title">记录一个 Bug</h2>
          </div>
          <button aria-label="关闭" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <form onSubmit={submit}>
          <label className="field-wide">
            <span>标题</span>
            <input maxLength={160} name="title" required />
          </label>
          <label>
            <span>操作 / 复现路径</span>
            <textarea name="operationPath" required rows={3} />
          </label>
          <label>
            <span>实际结果</span>
            <textarea name="actualResult" required rows={3} />
          </label>
          <label>
            <span>预期结果</span>
            <textarea name="expectedResult" required rows={3} />
          </label>
          <label className="field-wide">
            <span>补充描述 / 选填</span>
            <textarea name="supplementalDescription" rows={3} />
          </label>
          <label className="field-wide file-field">
            <span>附件 / 最多 5 个</span>
            <input
              accept=".png,.jpg,.jpeg,.webp,.txt,.log,.json"
              multiple
              name="attachments"
              ref={fileInput}
              type="file"
            />
            <small>图片每个 ≤ 10MB；TXT / LOG / JSON 每个 ≤ 2MB</small>
          </label>
          {error ? <p className="form-error field-wide">{error}</p> : null}
          <div className="dialog-actions field-wide">
            <button onClick={onClose} type="button">
              取消
            </button>
            <button className="repair-primary" disabled={pending} type="submit">
              {pending ? '写入中…' : '创建 Bug'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ProjectBindingDialog({
  project,
  onClose,
  onBound,
}: {
  project: ProjectSummary;
  onClose: () => void;
  onBound: () => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      try {
        const baseBranch = String(form.get('baseBranch') ?? '').trim();
        const response = await fetch('/api/runner/project-bindings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project: project.id,
            repositoryPath: String(form.get('repositoryPath') ?? '').trim(),
            ...(baseBranch ? { baseBranch } : {}),
          }),
        });
        const result = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(result.error ?? '项目绑定失败');
        await onBound();
      } catch (requestError) {
        setError(messageOf(requestError, '项目绑定失败'));
      }
    });
  }

  return (
    <div className="repair-overlay" role="presentation">
      <section
        aria-labelledby="project-binding-title"
        aria-modal="true"
        className="bug-dialog project-binding-dialog"
        role="dialog"
      >
        <header>
          <div>
            <p className="repair-kicker">Agent / 项目绑定</p>
            <h2 id="project-binding-title">绑定本机项目</h2>
          </div>
          <button aria-label="关闭" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <div className="binding-project">
          <strong>{project.title ?? project.slug}</strong>
          <span>/{project.slug}</span>
        </div>
        <form onSubmit={submit}>
          <label>
            <span>本机 Git 仓库路径</span>
            <input
              autoComplete="off"
              name="repositoryPath"
              placeholder="/Users/name/work/project"
              required
            />
          </label>
          <label>
            <span>基准分支 / 可选</span>
            <input
              autoComplete="off"
              maxLength={240}
              name="baseBranch"
              placeholder="自动使用当前分支"
            />
          </label>
          <p className="binding-hint">
            路径仅保存在本机 Agent；绑定成功后，该项目即可接收修复任务。
          </p>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="dialog-actions">
            <button onClick={onClose} type="button">
              取消
            </button>
            <button className="repair-primary" disabled={pending} type="submit">
              {pending ? '绑定中…' : '绑定 Agent'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ProjectNameDialog({
  project,
  onClose,
  onRenamed,
}: {
  project: ProjectSummary;
  onClose: () => void;
  onRenamed: () => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      try {
        const response = await fetch('/api/control-plane/projects', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId: project.id,
            title: String(form.get('title') ?? '').trim(),
          }),
        });
        const result = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(result.error ?? '项目名称修改失败');
        await onRenamed();
      } catch (requestError) {
        setError(messageOf(requestError, '项目名称修改失败'));
      }
    });
  }

  return (
    <div className="repair-overlay" role="presentation">
      <section
        aria-labelledby="project-name-title"
        aria-modal="true"
        className="bug-dialog project-name-dialog"
        role="dialog"
      >
        <header>
          <div>
            <p className="repair-kicker">项目 / 显示名称</p>
            <h2 id="project-name-title">修改项目名称</h2>
          </div>
          <button aria-label="关闭" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <form onSubmit={submit}>
          <label>
            <span>项目名称</span>
            <input
              autoFocus
              defaultValue={project.title ?? project.slug}
              maxLength={120}
              name="title"
              required
            />
          </label>
          <p className="binding-hint">项目标识 /{project.slug} 保持不变。</p>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="dialog-actions">
            <button onClick={onClose} type="button">
              取消
            </button>
            <button className="repair-primary" disabled={pending} type="submit">
              {pending ? '保存中…' : '保存名称'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function BugDrawer({
  bug,
  batch,
  loading,
  onClose,
  onContinueRepair,
  onCancelRepair,
  onContinueDeployment,
  onCancelDeployment,
  onVerifyPassed,
  onVerifyFailed,
}: {
  bug: PublicBugDetail | null;
  batch: PublicDeploymentBatch | null;
  loading: boolean;
  onClose: () => void;
  onContinueRepair: (
    bugId: string,
    feedback: string,
    reassign: boolean,
  ) => Promise<void>;
  onCancelRepair: (bugId: string) => Promise<void>;
  onContinueDeployment: (
    batchId: string,
    bugId: string,
    feedback: string,
  ) => Promise<void>;
  onCancelDeployment: (batchId: string, bugId: string) => Promise<void>;
  onVerifyPassed: (bugId: string) => Promise<void>;
  onVerifyFailed: (bugId: string, form: FormData) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const verificationFiles = useRef<HTMLInputElement>(null);
  const column = bug
    ? COLUMNS.find((item) => item.status === bug.status)
    : undefined;

  function run(action: () => Promise<void>, fallback: string) {
    setActionError(null);
    startTransition(async () => {
      try {
        await action();
      } catch (requestError) {
        setActionError(messageOf(requestError, fallback));
      }
    });
  }

  function submitRepairContinuation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bug) return;
    const form = new FormData(event.currentTarget);
    run(
      () =>
        onContinueRepair(
          bug.id,
          String(form.get('feedback') ?? '').trim(),
          form.get('reassign') === 'on',
        ),
      '无法继续修复',
    );
  }

  function submitDeploymentContinuation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bug || !batch) return;
    const form = new FormData(event.currentTarget);
    run(
      () =>
        onContinueDeployment(
          batch.id,
          bug.id,
          String(form.get('feedback') ?? '').trim(),
        ),
      '无法继续部署',
    );
  }

  function submitVerificationFailure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bug) return;
    const files = [...(verificationFiles.current?.files ?? [])];
    const validationError = validateFiles(files);
    if (validationError) {
      setActionError(validationError);
      return;
    }
    const form = new FormData(event.currentTarget);
    form.delete('attachments');
    for (const file of files) form.append('attachments', file);
    run(() => onVerifyFailed(bug.id, form), '无法提交验证失败');
  }

  return (
    <div className="drawer-scrim" onMouseDown={onClose} role="presentation">
      <aside
        aria-label="Bug 详情"
        className="bug-drawer"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <small>{bug?.shortId ?? '读取中'}</small>
            <h2>{bug?.title ?? '正在读取…'}</h2>
          </div>
          <button aria-label="关闭详情" onClick={onClose} type="button">
            ×
          </button>
        </header>
        {loading || !bug ? (
          <p className="repair-loading">读取详情中…</p>
        ) : (
          <div className="bug-detail">
            <div className="bug-detail__status">
              <span>{column?.mark}</span>
              {column?.label}
              {bugStateLabel(bug) ? <b>{bugStateLabel(bug)}</b> : null}
            </div>

            <BugActionPanel
              batch={batch}
              bug={bug}
              error={actionError}
              onCancelDeployment={() => {
                if (
                  batch &&
                  window.confirm(
                    '确认取消整个部署批次？所有成员将回到“修复就绪”，候选修复会保留。',
                  )
                )
                  run(
                    () => onCancelDeployment(batch.id, bug.id),
                    '无法取消部署批次',
                  );
              }}
              onCancelRepair={() => {
                if (
                  window.confirm(
                    '确认取消当前修复进程？本地上下文会保留，之后仍可继续修复。',
                  )
                )
                  run(() => onCancelRepair(bug.id), '无法取消修复');
              }}
              onVerifyPassed={() => {
                if (window.confirm(`确认 ${bug.shortId} 验证通过并完成？`))
                  run(() => onVerifyPassed(bug.id), '无法确认验证通过');
              }}
              pending={pending}
              submitDeploymentContinuation={submitDeploymentContinuation}
              submitRepairContinuation={submitRepairContinuation}
              submitVerificationFailure={submitVerificationFailure}
              verificationFiles={verificationFiles}
            />

            <DetailBlock label="操作 / 复现路径" value={bug.operationPath} />
            <DetailBlock label="实际结果" value={bug.actualResult} />
            <DetailBlock label="预期结果" value={bug.expectedResult} />
            {bug.supplementalDescription ? (
              <DetailBlock
                label="补充描述"
                value={bug.supplementalDescription}
              />
            ) : null}

            {bug.repairAttempt ? (
              <RepairAttemptDetail attempt={bug.repairAttempt} latest />
            ) : null}

            {batch ? <DeploymentBatchDetail batch={batch} /> : null}

            {bug.repairAttempts.length > 1 ? (
              <section className="detail-block execution-history">
                <h3>修复尝试历史 / {bug.repairAttempts.length}</h3>
                <div>
                  {bug.repairAttempts.map((attempt, index) => (
                    <RepairAttemptDetail
                      attempt={attempt}
                      key={attempt.id}
                      latest={index === 0}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {bug.verificationFeedbacks.length ? (
              <section className="detail-block verification-history">
                <h3>验证失败反馈 / {bug.verificationFeedbacks.length}</h3>
                <ol>
                  {bug.verificationFeedbacks.map((feedback) => (
                    <li key={feedback.id}>
                      <time>{formatDateTime(feedback.createdAt)}</time>
                      <p>{feedback.feedback}</p>
                      {feedback.attachments.length ? (
                        <small>{feedback.attachments.length} 个证据附件</small>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            <section className="detail-block">
              <h3>附件 / {bug.attachments.length}</h3>
              {bug.attachments.length ? (
                <ul className="attachment-list">
                  {bug.attachments.map((attachment) => (
                    <li key={attachment.id}>
                      <a
                        href={`/api/control-plane/attachments/${attachment.id}`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <span>
                          {attachment.mediaType.startsWith('image/')
                            ? '▧'
                            : '≡'}
                        </span>
                        <strong>{attachment.fileName}</strong>
                        <small>{formatBytes(attachment.sizeBytes)}</small>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>无附件</p>
              )}
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

function BugActionPanel({
  bug,
  batch,
  pending,
  error,
  onCancelRepair,
  onCancelDeployment,
  onVerifyPassed,
  submitRepairContinuation,
  submitDeploymentContinuation,
  submitVerificationFailure,
  verificationFiles,
}: {
  bug: PublicBugDetail;
  batch: PublicDeploymentBatch | null;
  pending: boolean;
  error: string | null;
  onCancelRepair: () => void;
  onCancelDeployment: () => void;
  onVerifyPassed: () => void;
  submitRepairContinuation: (event: FormEvent<HTMLFormElement>) => void;
  submitDeploymentContinuation: (event: FormEvent<HTMLFormElement>) => void;
  submitVerificationFailure: (event: FormEvent<HTMLFormElement>) => void;
  verificationFiles: RefObject<HTMLInputElement | null>;
}) {
  const canContinueRepair =
    bug.canReopenRepair ||
    (bug.status === 'repairing' &&
      ['needs_input', 'blocked', 'failed', 'cancelled'].includes(
        bug.repairState ?? '',
      ));
  const canContinueDeployment =
    bug.status === 'deploying' &&
    batch !== null &&
    ['blocked', 'failed', 'unknown'].includes(batch.state);

  if (
    !canContinueRepair &&
    bug.repairState !== 'running' &&
    !canContinueDeployment &&
    batch?.state !== 'running' &&
    bug.status !== 'waiting_for_verification'
  )
    return null;

  return (
    <section className="bug-action-panel" aria-label="可执行操作">
      <p className="repair-kicker">下一步操作</p>
      {canContinueRepair ? (
        <form onSubmit={submitRepairContinuation}>
          <label>
            <span>
              {bug.status === 'done'
                ? '补充信息 / 重开修复'
                : '补充信息 / 继续修复'}
            </span>
            <textarea
              name="feedback"
              placeholder="补充复现条件、期望或阻塞所需信息"
              required
              rows={4}
            />
          </label>
          <label className="inline-check">
            <input name="reassign" type="checkbox" />
            <span>原会话不可用，显式换新执行上下文</span>
          </label>
          <button className="repair-primary" disabled={pending} type="submit">
            {pending
              ? '提交中…'
              : bug.status === 'done'
                ? '重开修复'
                : '继续修复'}
          </button>
        </form>
      ) : null}

      {bug.repairState === 'running' ? (
        <div className="action-row">
          <p>Codex 正在修复。取消会终止当前进程，但保留可继续的本地上下文。</p>
          <button disabled={pending} onClick={onCancelRepair} type="button">
            取消当前修复
          </button>
        </div>
      ) : null}

      {canContinueDeployment ? (
        <form onSubmit={submitDeploymentContinuation}>
          <label>
            <span>补充信息 / 整批继续</span>
            <textarea
              name="feedback"
              placeholder="补充部署条件、人工确认结果或失败处理信息"
              required
              rows={4}
            />
          </label>
          <button className="repair-primary" disabled={pending} type="submit">
            {pending ? '提交中…' : '继续整个部署批次'}
          </button>
        </form>
      ) : null}

      {batch?.state === 'running' ? (
        <div className="action-row">
          <p>Codex 正在执行原子部署批次。只能整批取消，不能取消单个成员。</p>
          <button disabled={pending} onClick={onCancelDeployment} type="button">
            取消整个部署批次
          </button>
        </div>
      ) : null}

      {bug.status === 'waiting_for_verification' ? (
        <div className="verification-actions">
          <button
            className="repair-primary"
            disabled={pending}
            onClick={onVerifyPassed}
            type="button"
          >
            验证通过
          </button>
          <form onSubmit={submitVerificationFailure}>
            <label>
              <span>验证失败反馈 / 必填</span>
              <textarea
                name="feedback"
                placeholder="说明仍存在的症状、复现方式或新观察"
                required
                rows={4}
              />
            </label>
            <label>
              <span>新证据 / 可选，最多 5 个</span>
              <input
                accept=".png,.jpg,.jpeg,.webp,.txt,.log,.json"
                multiple
                name="attachments"
                ref={verificationFiles}
                type="file"
              />
            </label>
            <button disabled={pending} type="submit">
              {pending ? '提交中…' : '验证失败并重新修复'}
            </button>
          </form>
        </div>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </section>
  );
}

function RepairAttemptDetail({
  attempt,
  latest = false,
}: {
  attempt: PublicRepairAttempt;
  latest?: boolean;
}) {
  const result = attempt.result;
  return (
    <section
      className={`repair-attempt-detail${latest ? ' repair-attempt-detail--latest' : ''}`}
    >
      <div className="repair-attempt-detail__heading">
        <strong>
          {latest ? '最新修复尝试' : formatDateTime(attempt.createdAt)}
        </strong>
        <span>{repairAttemptStateLabel(attempt.state)}</span>
      </div>
      <dl>
        <div>
          <dt>模板</dt>
          <dd>
            {attempt.templateName} / {attempt.templateVersion}
          </dd>
        </div>
        <div>
          <dt>重试</dt>
          <dd>
            {attempt.retryNumber} / {attempt.maxInfrastructureRetries}
          </dd>
        </div>
      </dl>
      {result ? (
        <p className="repair-attempt-detail__summary">{result.summary}</p>
      ) : null}
      {result?.reason ? (
        <p className="repair-attempt-detail__failure">{result.reason}</p>
      ) : attempt.failureMessage ? (
        <p className="repair-attempt-detail__failure">
          {attempt.failureMessage}
        </p>
      ) : null}
      {result?.changes.length ? (
        <div className="repair-result-list">
          <h4>修改摘要</h4>
          <ul>
            {result.changes.map((change) => (
              <li key={`${change.path}:${change.summary}`}>
                <strong>{change.path}</strong>
                <span>{change.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {result?.checks.length ? (
        <div className="repair-result-list">
          <h4>检查</h4>
          <ul>
            {result.checks.map((check) => (
              <li key={`${check.name}:${check.summary}`}>
                <strong>
                  {repairCheckStatusMark(check.status)} {check.name}
                </strong>
                <span>{check.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function DeploymentBatchDetail({ batch }: { batch: PublicDeploymentBatch }) {
  return (
    <section className="detail-block deployment-detail">
      <h3>部署批次</h3>
      <dl>
        <div>
          <dt>状态</dt>
          <dd>{deploymentBatchStateLabel(batch.state)}</dd>
        </div>
        <div>
          <dt>成员</dt>
          <dd>
            {batch.members.map((member) => member.bug.shortId).join('、')}
          </dd>
        </div>
        {batch.templateName && batch.templateVersion ? (
          <div>
            <dt>模板</dt>
            <dd>
              {batch.templateName} / {batch.templateVersion}
            </dd>
          </div>
        ) : null}
      </dl>
      {batch.summary ? <p>{batch.summary}</p> : null}
      {batch.reason ? (
        <p className="repair-attempt-detail__failure">{batch.reason}</p>
      ) : null}
    </section>
  );
}

function PromptTemplateViewer({
  templates,
  onClose,
}: {
  templates: PromptTemplateSummary[] | null;
  onClose: () => void;
}) {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected =
    templates?.find((template) => template.name === selectedName) ??
    templates?.[0] ??
    null;
  return (
    <div className="repair-overlay" role="presentation">
      <section
        aria-labelledby="prompt-viewer-title"
        aria-modal="true"
        className="prompt-viewer"
        role="dialog"
      >
        <header>
          <div>
            <p className="repair-kicker">只读 / 执行规则</p>
            <h2 id="prompt-viewer-title">提示词模板</h2>
          </div>
          <button aria-label="关闭" onClick={onClose} type="button">
            ×
          </button>
        </header>
        {!templates ? (
          <p className="repair-loading">正在读取原始模板…</p>
        ) : templates.length === 0 ? (
          <p className="repair-loading">暂无模板</p>
        ) : (
          <div className="prompt-viewer__layout">
            <nav aria-label="模板列表">
              {templates.map((template) => (
                <button
                  aria-current={selected?.name === template.name}
                  key={template.name}
                  onClick={() => setSelectedName(template.name)}
                  type="button"
                >
                  <strong>{template.name}</strong>
                  <span>{template.version}</span>
                </button>
              ))}
            </nav>
            {selected ? (
              <article>
                <header>
                  <div>
                    <h3>{selected.name}</h3>
                    <span>版本 {selected.version} · 只读</span>
                  </div>
                  <p>{selected.purpose}</p>
                </header>
                <section>
                  <h4>变量</h4>
                  <p>
                    {selected.variables
                      .map((item) => `{{${item}}}`)
                      .join(' · ')}
                  </p>
                </section>
                <section>
                  <h4>原始模板</h4>
                  <pre>{selected.text}</pre>
                </section>
                <section>
                  <h4>输出结构</h4>
                  <pre>{JSON.stringify(selected.outputSchema, null, 2)}</pre>
                </section>
              </article>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function repairAttemptStateLabel(state: PublicRepairAttempt['state']) {
  return {
    pending: '等待执行',
    running: 'Codex 修复中',
    ready: '修复就绪',
    needs_input: '等待补充',
    blocked: '修复受阻',
    failed: '修复失败',
    cancelled: '已取消',
  }[state];
}

function repairCheckStatusMark(status: 'passed' | 'failed' | 'not_run') {
  return { passed: '✓', failed: '×', not_run: '—' }[status];
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  return (
    <section className="detail-block">
      <h3>{label}</h3>
      <p>{value}</p>
    </section>
  );
}

function validateFiles(files: File[]) {
  if (files.length > 5) return '附件最多 5 个';
  for (const file of files) {
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (
      !['png', 'jpg', 'jpeg', 'webp', 'txt', 'log', 'json'].includes(
        extension ?? '',
      )
    )
      return `${file.name} 的类型不受支持`;
    const image = ['png', 'jpg', 'jpeg', 'webp'].includes(extension!);
    if (file.size > (image ? 10 : 2) * 1024 * 1024)
      return `${file.name} 超过大小限制`;
  }
  return null;
}

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
