'use client';

import { useRef, useState, useTransition } from 'react';
import { createClientId } from '@/cooking/shared/ui/client-id';
import type { CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import {
  reopenBugAction,
  restoreBugAction,
  unarchiveBugAction,
} from '@/cooking/lifecycle/server/actions';
import { freezeUpdateNowAction } from '@/cooking/update/server/actions';
import type { BugView } from '../contract';
import { requestRepairAction } from '../server/actions';
import { pendingDeliveryFor, messageOf, formatDateTime } from './board-model';
import type { WorkspaceActionResult } from './board-model';

import { Detail } from './detail-fields';
import { BugResultDetail, RepairAttemptDetails } from './repair-timeline';

import { UpdateBatchDetails } from './update-details';

import { UpdateCountdown } from './bug-card';
import { AttachmentPicker } from './attachments';

export function BugDetail({
  bug,
  onChanged,
  onEdit,
  snapshot,
}: {
  bug: BugView;
  onChanged: (revision: number, message: string) => void;
  onEdit: (() => void) | null;
  snapshot: CookingWorkspaceSnapshot;
}) {
  const [detailView, setDetailView] = useState<'repair' | 'update'>('repair');
  const [copied, setCopied] = useState(false);
  const [verificationFeedback, setVerificationFeedback] = useState('');
  const [verificationFiles, setVerificationFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const detailBodyRef = useRef<HTMLDivElement>(null);
  const verificationFileInput = useRef<HTMLInputElement>(null);
  const repair = snapshot.repairByBug[bug.id] ?? null;
  const progress = snapshot.progressByBug[bug.id] ?? [];
  const repairProgress = progress.filter(
    (node) => node.kind !== 'UPDATE_BATCH',
  );
  const updateProgress = progress.filter(
    (node) => node.kind === 'UPDATE_BATCH',
  );
  const visual = snapshot.visualByBug[bug.id]!;
  const submissionItemId = bug.assignment?.submissionItemId ?? null;
  const pendingDelivery = pendingDeliveryFor(bug, snapshot);
  const updateBatch = [...snapshot.updateBatches]
    .reverse()
    .find((candidate) =>
      candidate.entries.some((entry) => entry.bugId === bug.id),
    );
  const summaryOnly =
    snapshot.submission.submission.testerUserId === snapshot.currentUser.id;
  const canResolveInteraction = Boolean(
    repair?.timeline.some(
      (node) =>
        node.kind === 'REPAIR_ATTEMPT' &&
        node.interactions.some(
          (interaction) =>
            interaction.state === 'PENDING' && interaction.canResolve,
        ),
    ) ||
    updateBatch?.timeline.some(
      (node) =>
        node.kind === 'UPDATE_ATTEMPT' &&
        node.interactions.some(
          (interaction) =>
            interaction.state === 'PENDING' && interaction.canResolve,
        ),
    ),
  );
  const needsCurrentUserAction = Boolean(
    canResolveInteraction ||
    repair?.availableActions.includes('SYNC_SESSION') ||
    bug.availableActions.some((action) =>
      ['REQUEST_REPAIR', 'VERIFY_PASS', 'VERIFY_FAIL'].includes(action),
    ),
  );

  function showDetailView(view: 'repair' | 'update') {
    setDetailView(view);
    window.requestAnimationFrame(() => {
      if (!detailBodyRef.current) return;
      detailBodyRef.current
        .querySelector<HTMLElement>(`[data-progress-kind="${view}"]`)
        ?.scrollIntoView({ block: 'start' });
    });
  }

  function run(
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) {
    startTransition(async () => {
      try {
        const result = await command();
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setError(null);
        afterSuccess?.();
        onChanged(result.result.revision, message);
      } catch (actionError) {
        setError(messageOf(actionError, '操作失败，请稍后重试。'));
      }
    });
  }

  return (
    <div
      className="collab-dialog__body collab-bug-drawer__body"
      data-detail-view={detailView}
      ref={detailBodyRef}
    >
      <header className="collab-bug-detail-hero">
        <div className="collab-bug-detail-hero__title">
          <h2 title={bug.report.title}>{bug.report.title}</h2>
          {onEdit ? (
            <button onClick={onEdit} type="button">
              {bug.availableActions.includes('EDIT_REPORT')
                ? '编辑资料'
                : '调整归属'}
            </button>
          ) : null}
        </div>
        <dl>
          <Detail label="当前状态">
            <span
              aria-label={visual.label}
              className="collab-current-visual"
              data-visual-state={visual.state}
            >
              <span aria-hidden="true">{visual.symbol}</span>
              {visual.label}
            </span>
          </Detail>
          <Detail label="问题归属">
            {bug.assignment
              ? `${bug.assignment.engineeringType === 'FRONTEND' ? '前端' : '后端'} · ${bug.assignment.engineeringName}`
              : '暂未确定'}
          </Detail>
          {bug.assignment ? (
            <Detail label="负责人">
              {bug.assignment.responsibleUser.displayName}
            </Detail>
          ) : null}
          {needsCurrentUserAction ? (
            <Detail label="当前责任">
              <strong>需要你处理</strong>
            </Detail>
          ) : null}
          {bug.report.expectedResult ||
          bug.report.expectedResultAttachments.length ? (
            <Detail label="预期结果">
              <BugResultDetail
                attachments={bug.report.expectedResultAttachments}
                text={bug.report.expectedResult}
              />
            </Detail>
          ) : null}
          {bug.report.actualResult ||
          bug.report.actualResultAttachments.length ? (
            <Detail label="实际结果">
              <BugResultDetail
                attachments={bug.report.actualResultAttachments}
                text={bug.report.actualResult}
              />
            </Detail>
          ) : null}
          {bug.report.operationPath ? (
            <Detail label="操作路径">
              <span
                className="collab-bug-detail-fact"
                title={bug.report.operationPath}
              >
                {bug.report.operationPath}
              </span>
            </Detail>
          ) : null}
          <Detail label="缺陷 ID">
            <span className="collab-bug-id">
              <code>{bug.id}</code>
              <button
                aria-label="复制删除命令"
                onClick={() => {
                  void navigator.clipboard.writeText(
                    `xapt bugs delete ${bug.id}`,
                  );
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1600);
                }}
                type="button"
              >
                {copied ? '已复制' : '复制'}
              </button>
            </span>
          </Detail>
        </dl>
      </header>
      <nav aria-label="缺陷进展视图" className="collab-bug-detail-tabs">
        <button
          aria-current={detailView === 'repair' ? 'page' : undefined}
          onClick={() => showDetailView('repair')}
          type="button"
        >
          修复进展
        </button>
        <button
          aria-current={detailView === 'update' ? 'page' : undefined}
          onClick={() => showDetailView('update')}
          type="button"
        >
          更新进展
        </button>
      </nav>
      <div data-progress-kind="repair">
        {repairProgress.length ? (
          <RepairAttemptDetails
            bug={bug}
            pending={pending}
            repair={repair}
            run={run}
            summaryOnly={summaryOnly}
            timeline={repairProgress}
          />
        ) : (
          <section className="collab-bug-detail-section">
            <h3>修复进展</h3>
            <p className="collab-bug-detail-empty">暂无修复记录</p>
          </section>
        )}
      </div>
      <div data-progress-kind="update">
        {updateBatch ? (
          <UpdateBatchDetails
            batch={updateBatch}
            embedded
            onChanged={onChanged}
            summaryOnly={summaryOnly}
          />
        ) : updateProgress.length ? (
          <RepairAttemptDetails
            bug={bug}
            pending={pending}
            repair={repair}
            run={run}
            summaryOnly={summaryOnly}
            timeline={updateProgress}
          />
        ) : !pendingDelivery ? (
          <section className="collab-bug-detail-section">
            <h3>更新进展</h3>
            <p className="collab-bug-detail-empty">暂无更新记录</p>
          </section>
        ) : null}
      </div>
      {pendingDelivery ? (
        <section
          className="collab-bug-detail-section"
          data-progress-kind="update"
        >
          <h3>待统一更新</h3>
          <p>
            最新候选已记录；静默截止时间：
            {formatDateTime(pendingDelivery.eligibleAt)}
            （<UpdateCountdown eligibleAt={pendingDelivery.eligibleAt} />）
          </p>
        </section>
      ) : null}
      {bug.availableActions.includes('REQUEST_REPAIR') ? (
        <section
          className="collab-bug-detail-section"
          data-progress-kind="repair"
        >
          <h3>修复操作</h3>
          <button
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  requestRepairAction(bug.id, {
                    mutationId: createClientId(),
                    expectedVersion: bug.version,
                  }),
                '缺陷已提交自动修复。',
              )
            }
            type="button"
          >
            开始自动修复
          </button>
        </section>
      ) : null}
      {pendingDelivery?.availableActions.includes('FREEZE_NOW') ? (
        <section
          className="collab-bug-detail-section"
          data-progress-kind="update"
        >
          <h3>更新操作</h3>
          <button
            disabled={pending || !submissionItemId}
            onClick={() =>
              run(
                () =>
                  freezeUpdateNowAction(submissionItemId!, {
                    mutationId: createClientId(),
                  }),
                '当前待更新缺陷已冻结为统一更新批次。',
              )
            }
            type="button"
          >
            立即统一更新
          </button>
        </section>
      ) : null}
      {bug.availableActions.includes('REOPEN') ? (
        <section
          className="collab-bug-detail-section"
          data-progress-kind="repair"
        >
          <h3>重新打开</h3>
          <div className="collab-form collab-bug-verification">
            <textarea
              maxLength={8_000}
              onChange={(event) => setVerificationFeedback(event.target.value)}
              placeholder="描述重新出现的问题"
              rows={3}
              value={verificationFeedback}
            />
            <AttachmentPicker
              files={verificationFiles}
              inputRef={verificationFileInput}
              onChange={setVerificationFiles}
            />
            <button
              disabled={pending || !verificationFeedback.trim()}
              onClick={() => {
                const formData = new FormData();
                formData.set('mutationId', createClientId());
                formData.set('expectedVersion', String(bug.version));
                formData.set('feedback', verificationFeedback);
                verificationFiles.forEach((file) =>
                  formData.append('attachments', file),
                );
                run(
                  () => reopenBugAction(bug.id, formData),
                  '缺陷已重新打开并进入修复。',
                  () => {
                    setVerificationFeedback('');
                    setVerificationFiles([]);
                    if (verificationFileInput.current)
                      verificationFileInput.current.value = '';
                  },
                );
              }}
              type="button"
            >
              重新打开
            </button>
          </div>
        </section>
      ) : null}
      {bug.availableActions.includes('RESTORE') ? (
        <section
          className="collab-bug-detail-section"
          data-progress-kind="repair"
        >
          <h3>恢复缺陷</h3>
          <p>恢复后回到待修复，原始缺陷资料仍可继续编辑。</p>
          <button
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  restoreBugAction(bug.id, {
                    mutationId: createClientId(),
                    expectedVersion: bug.version,
                  }),
                '缺陷已恢复到待修复。',
              )
            }
            type="button"
          >
            恢复到待修复
          </button>
        </section>
      ) : null}
      {bug.availableActions.includes('UNARCHIVE') ? (
        <section
          className="collab-bug-detail-section"
          data-progress-kind="repair"
        >
          <h3>移出归档</h3>
          <p>移出后仍保持已完成，并重新显示在看板中。</p>
          <button
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  unarchiveBugAction(bug.id, {
                    mutationId: createClientId(),
                    expectedVersion: bug.version,
                  }),
                '缺陷已移出归档。',
              )
            }
            type="button"
          >
            移出归档
          </button>
        </section>
      ) : null}
      {error ? (
        <p className="collab-form__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
