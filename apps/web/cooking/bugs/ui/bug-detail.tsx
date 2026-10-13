'use client';

import type { CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import { createClientId } from '@/cooking/shared/ui/client-id';
import { freezeUpdateNowAction } from '@/cooking/update/server/actions';
import type { BugView } from '../contract';
import { requestRepairAction } from '../server/actions';
import { pendingDeliveryFor } from './board-model';
import { useWorkspaceMutation } from './use-workspace-mutation';
import { Detail } from './detail-fields';
import { BugResultDetail } from './repair-timeline';
import { BugRouting } from './bug-routing';
import { DeveloperTimeline } from './developer-timeline';
import { developerTimeline } from './developer-detail-model';
import { ExecutionIdentity } from './execution-round';

export function BugDetail({
  bug,
  onChanged,
  onEdit,
  onOpen,
  onOpenBatch,
  snapshot,
}: {
  bug: BugView;
  onChanged: (revision: number, message: string) => void;
  onEdit: (() => void) | null;
  onOpen: (bugId: string) => void;
  onOpenBatch: (batchId: string) => void;
  snapshot: CookingWorkspaceSnapshot;
}) {
  const { error, pending, run } = useWorkspaceMutation(onChanged);
  const entries = developerTimeline(bug.id, snapshot);
  const repair = entries.find((entry) => entry.kind === 'repair');
  const update = entries.find((entry) => entry.kind === 'update');
  const visual = snapshot.visualByBug[bug.id]!;
  const pendingDelivery = pendingDeliveryFor(bug, snapshot);
  return (
    <div className="collab-dialog__body collab-bug-drawer__body collab-developer-detail">
      <section
        className="collab-developer-status"
        aria-live="polite"
        data-visual-state={visual.state}
      >
        <strong>{visual.label}</strong>
        {bug.assignment ? (
          <span>
            {bug.assignment.engineeringName} ·{' '}
            {bug.assignment.responsibleUser.displayName}
          </span>
        ) : null}
      </section>
      <div className="collab-execution-identities">
        <ExecutionIdentity label="缺陷 ID" value={bug.id} />
        <ExecutionIdentity
          label="修复会话 ID"
          value={repair?.kind === 'repair' ? repair.node.sessionId : null}
          session
        />
        <ExecutionIdentity
          label="更新会话 ID"
          value={update?.kind === 'update' ? update.node.sessionId : null}
          session
        />
      </div>
      {error ? (
        <p className="collab-form__error" role="alert">
          {error}
        </p>
      ) : null}
      {pendingDelivery && bug.stage === 'WAITING_FOR_UPDATE' ? (
        <section className="collab-developer-next" aria-label="待更新操作">
          <p>修复提交等待统一更新。</p>
          {pendingDelivery.availableActions.includes('FREEZE_NOW') ? (
            <button
              disabled={pending}
              type="button"
              onClick={() =>
                run(
                  () =>
                    freezeUpdateNowAction(pendingDelivery.submissionItemId, {
                      mutationId: createClientId(),
                    }),
                  '当前待更新缺陷已冻结为统一更新批次。',
                )
              }
            >
              立即统一更新
            </button>
          ) : null}
        </section>
      ) : null}
      {bug.availableActions.includes('REQUEST_REPAIR') ? (
        <button
          disabled={pending}
          type="button"
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
        >
          开始自动修复
        </button>
      ) : null}
      <DeveloperTimeline
        entries={entries}
        bug={bug}
        snapshot={snapshot}
        pending={pending}
        run={run}
        onOpenBatch={onOpenBatch}
      />
      <BugRouting bug={bug} onChanged={onChanged} />
      {bug.relatedBugs.length ? (
        <section className="collab-bug-detail-section" aria-label="关联缺陷">
          <h3>关联缺陷</h3>
          {bug.transferredAt ? (
            <p>本单已关闭，原因：转交其他工程。此关闭不代表验收通过。</p>
          ) : null}
          {bug.collaborationLocked ? (
            <p>前后端关联单分别处理与验收，不再转交或增加协作。</p>
          ) : null}
          {bug.relatedBugs.map((related, index) => (
            <div key={related.id ?? `deleted-${index}`}>
              {related.id ? (
                <button type="button" onClick={() => onOpen(related.id!)}>
                  缺陷-{String(related.shortId).padStart(3, '0')} ·{' '}
                  {related.title}
                </button>
              ) : (
                <p>{related.title}（已删除）</p>
              )}
              <p>
                {related.engineeringName ?? '历史工程'} · {related.stageLabel}
              </p>
              {related.handoffText ? (
                <details>
                  <summary>原单排查结果</summary>
                  <p className="collab-handoff-text">{related.handoffText}</p>
                </details>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <details className="collab-developer-source">
        <summary>查看原始缺陷资料</summary>
        <aside className="collab-bug-detail-context" aria-label="缺陷资料">
          <div className="collab-bug-detail-context__actions">
            {onEdit ? (
              <button onClick={onEdit} type="button">
                {bug.availableActions.includes('EDIT_REPORT')
                  ? '编辑资料'
                  : '调整归属'}
              </button>
            ) : null}
          </div>
          <dl>
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
          </dl>
        </aside>
      </details>
    </div>
  );
}
