'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import type {
  CollaborativeCommand,
  TestSubmissionSummary,
} from '@agent-party-time/shared/control-plane';
import type { CurrentUser } from '@/lib/auth/core';
import { CookingAccountMenu } from '@/components/cooking-account-menu';
import { collaborativeCommand, collaborativeQuery, messageOf } from './client';
import {
  BugBoard,
  DeveloperOperations,
  SubmissionHeader,
  SubmissionRail,
} from './board';
import { BugComposer, SubmissionComposer } from './dialogs';
import type { Theme, WorkspaceSnapshot } from './model';

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
  const [showCreateBug, setShowCreateBug] = useState(false);
  const [includeClosed, setIncludeClosed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const refreshInFlight = useRef(false);
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
              collaborativeQuery({
                kind: 'interactions.list',
                submissionItemId: item.id,
                pendingOnly: true,
              }),
            ]);
          return {
            itemId: item.id,
            repairTasks: repairResult?.repairTasks ?? [],
            updateBatches: updateResult.updateBatches ?? [],
            interactions: interactionResult.interactions ?? [],
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
    (command: CollaborativeCommand, successMessage: string) =>
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

      <div className="collab-layout">
        <SubmissionRail
          currentUser={currentUser}
          includeClosed={includeClosed}
          loading={loading}
          onCreate={() => setShowCreateSubmission(true)}
          onIncludeClosedChange={setIncludeClosed}
          onRefresh={() => void refresh(selectedId)}
          onSelect={setSelectedId}
          refreshing={refreshing}
          selectedId={selectedId}
          submissions={submissions}
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
            <>
              <SubmissionHeader
                currentUser={currentUser}
                onClose={() =>
                  mutate(
                    {
                      kind: 'submission.close',
                      submissionId: snapshot.submission.id,
                    },
                    '提测单已关闭，环境锁已释放，清理任务已排队。',
                  )
                }
                onCreateBug={() => setShowCreateBug(true)}
                pending={pending}
                snapshot={snapshot}
              />
              {isDeveloper ? (
                <DeveloperOperations
                  currentUser={currentUser}
                  mutate={mutate}
                  pending={pending}
                  snapshot={snapshot}
                />
              ) : null}
              <BugBoard
                currentUser={currentUser}
                mutate={mutate}
                pending={pending}
                snapshot={snapshot}
              />
            </>
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

      {showCreateBug && snapshot ? (
        <BugComposer
          items={snapshot.submission.items}
          onClose={() => setShowCreateBug(false)}
          onCreated={async () => {
            setShowCreateBug(false);
            setNotice('缺陷已登记，技术配置已锁定。');
            await refresh(snapshot.submission.id);
          }}
          submissionId={snapshot.submission.id}
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
