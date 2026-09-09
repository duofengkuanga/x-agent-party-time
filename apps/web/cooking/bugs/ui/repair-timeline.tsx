'use client';

import { createClientId } from '@/cooking/shared/ui/client-id';
import type { BugProgressTimelineNode } from '@/cooking/workspace/contract';
import type { BugRepairView } from '@/cooking/repair/contract';
import {
  resolveRepairInteractionAction,
  synchronizeRepairSessionAction,
} from '@/cooking/repair/server/actions';
import type { BugView } from '../contract';
import type { StoredAttachment } from './attachments';
import { AttachmentLink } from './attachments';
import type { WorkspaceActionResult } from './board-model';
import { formatDateTime, repairStateLabel } from './board-model';
import { Detail, TimelineList } from './detail-fields';
import { CookingInteractionRecord } from './interaction-record';

export function BugResultDetail({
  attachments,
  text,
}: {
  attachments: StoredAttachment[];
  text?: string;
}) {
  return (
    <div className="collab-bug-result-detail">
      {text ? (
        <span className="collab-bug-detail-fact" title={text}>
          {text}
        </span>
      ) : null}
      {attachments.length ? (
        <ul className="collab-bug-detail-attachments">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <AttachmentLink attachment={attachment} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function RepairAttemptDetails({
  bug,
  pending,
  repair,
  run,
  summaryOnly,
  timeline,
}: {
  bug: BugView;
  pending: boolean;
  repair: BugRepairView | null;
  run: (
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) => void;
  summaryOnly: boolean;
  timeline: BugProgressTimelineNode[];
}) {
  const latestRepairAttemptId = [...timeline]
    .reverse()
    .find((node) => node.kind === 'REPAIR_ATTEMPT')?.id;
  const isUpdateTimeline = timeline.every(
    (node) => node.kind === 'UPDATE_BATCH',
  );
  return (
    <section
      className="collab-bug-detail-section collab-progress-timeline"
      data-summary-only={summaryOnly ? 'true' : undefined}
    >
      <header>
        <div>
          <h3>{isUpdateTimeline ? '更新进展' : '修复进展'}</h3>
          <p>
            {isUpdateTimeline
              ? '按批次从旧到新记录。'
              : '按修复生命周期从旧到新记录。'}
          </p>
        </div>
      </header>
      <ol className="collab-repair-timeline">
        {timeline.map((node) => (
          <li data-node-kind={node.kind} key={node.id}>
            <span aria-hidden="true" className="collab-repair-timeline__mark" />
            <BugProgressNode
              bug={bug}
              latestRepairAttemptId={latestRepairAttemptId}
              node={node}
              pending={pending}
              repair={repair}
              run={run}
              summaryOnly={summaryOnly}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function BugProgressNode({
  bug,
  latestRepairAttemptId,
  node,
  pending,
  repair,
  run,
  summaryOnly,
}: {
  bug: BugView;
  latestRepairAttemptId: string | undefined;
  node: BugProgressTimelineNode;
  pending: boolean;
  repair: BugRepairView | null;
  run: (
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) => void;
  summaryOnly: boolean;
}) {
  if (summaryOnly) return <BugProgressSummaryNode node={node} />;
  if (node.kind === 'BUG_REGISTERED')
    return (
      <article>
        <header>
          <strong>缺陷已登记</strong>
          <time>{formatDateTime(node.occurredAt)}</time>
        </header>
        <p>原始报告已进入待修复阶段。</p>
      </article>
    );
  if (node.kind === 'UPDATE_BATCH')
    return (
      <article>
        <header>
          <strong>已进入统一更新批次</strong>
          <time>{formatDateTime(node.occurredAt)}</time>
        </header>
        <p>
          {node.statusLabel} · 共 {node.bugCount} 条缺陷
        </p>
        <span
          aria-label={node.visual.label}
          className="collab-current-visual collab-progress-visual"
          data-visual-state={node.visual.state}
        >
          <span aria-hidden="true">{node.visual.symbol}</span>
          {node.visual.label}
        </span>
      </article>
    );
  if (node.kind === 'VERIFICATION')
    return (
      <article>
        <header>
          <strong>
            第 {node.round} 轮验证
            {node.result === 'PASSED' ? '已通过' : '未通过'}
          </strong>
          <time>{formatDateTime(node.createdAt)}</time>
        </header>
        {node.comment ? <p>{node.comment}</p> : <p>测试负责人未补充说明。</p>}
        {node.result === 'FAILED' && node.repairAttempt ? (
          <strong>已进入第 {node.repairAttempt} 轮修复</strong>
        ) : null}
        <ProgressAttachments attachments={node.attachments} />
      </article>
    );
  if (node.kind === 'REOPEN')
    return (
      <article>
        <header>
          <strong>第 {node.round} 次重新打开</strong>
          <time>{formatDateTime(node.createdAt)}</time>
        </header>
        <p>{node.feedback}</p>
        <strong>已进入第 {node.repairAttempt} 轮修复</strong>
        <ProgressAttachments attachments={node.attachments} />
      </article>
    );
  if (node.kind === 'CANCELLED' || node.kind === 'RESTORED')
    return (
      <article>
        <header>
          <strong>
            {node.kind === 'CANCELLED' ? '缺陷已取消' : '缺陷已恢复到待修复'}
          </strong>
          <time>{formatDateTime(node.createdAt)}</time>
        </header>
        <p>
          {node.kind === 'CANCELLED'
            ? '缺陷已移出主看板，可从已取消缺陷中恢复。'
            : '原始资料已重新开放编辑，尚未自动开始修复。'}
        </p>
      </article>
    );
  if (node.kind !== 'REPAIR_ATTEMPT') return null;
  return (
    <RepairAttemptTimelineArticle
      bug={bug}
      isLatestRepairAttempt={node.id === latestRepairAttemptId}
      node={node}
      pending={pending}
      repair={repair}
      run={run}
    />
  );
}

function BugProgressSummaryNode({ node }: { node: BugProgressTimelineNode }) {
  let title: string;
  let occurredAt: string;
  if (node.kind === 'BUG_REGISTERED') {
    title = '缺陷已登记';
    occurredAt = node.occurredAt;
  } else if (node.kind === 'REPAIR_ATTEMPT') {
    title = `第 ${node.attempt} 轮修复${
      node.result?.outcome === 'COMPLETED'
        ? '已完成'
        : node.result?.outcome === 'FAILED'
          ? '未完成'
          : '进行中'
    }`;
    occurredAt = node.finishedAt ?? node.startedAt ?? node.queuedAt;
  } else if (node.kind === 'UPDATE_BATCH') {
    title = `统一更新 · ${node.visual.label}`;
    occurredAt = node.occurredAt;
  } else if (node.kind === 'VERIFICATION') {
    title = `第 ${node.round} 轮验证${
      node.result === 'PASSED' ? '已通过' : '未通过，已返修'
    }`;
    occurredAt = node.createdAt;
  } else if (node.kind === 'REOPEN') {
    title = `第 ${node.round} 次重新打开，已返修`;
    occurredAt = node.createdAt;
  } else {
    title = node.kind === 'CANCELLED' ? '缺陷已取消' : '缺陷已恢复到待修复';
    occurredAt = node.createdAt;
  }
  return (
    <article className="collab-progress-summary">
      <header>
        <strong>{title}</strong>
        <time>{formatDateTime(occurredAt)}</time>
      </header>
    </article>
  );
}

function RepairAttemptTimelineArticle({
  bug,
  isLatestRepairAttempt,
  node,
  pending,
  repair,
  run,
}: {
  bug: BugView;
  isLatestRepairAttempt: boolean;
  node: Extract<BugProgressTimelineNode, { kind: 'REPAIR_ATTEMPT' }>;
  pending: boolean;
  repair: BugRepairView | null;
  run: (
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) => void;
}) {
  return (
    <article>
      <header>
        <strong>
          第 {node.attempt} 轮修复
          {node.result?.outcome === 'COMPLETED'
            ? '已完成'
            : node.result?.outcome === 'FAILED'
              ? '未完成'
              : '进行中'}
        </strong>
        <time>
          {formatDateTime(node.finishedAt ?? node.startedAt ?? node.queuedAt)}
        </time>
      </header>
      <dl className="collab-bug-detail-list collab-session-facts">
        {node.sessionId ? (
          <Detail label="修复会话 ID">{node.sessionId}</Detail>
        ) : null}
        <Detail label="Agent">{node.agentName}</Detail>
      </dl>
      {node.interactions.map((interaction) => (
        <CookingInteractionRecord
          interaction={interaction}
          key={interaction.id}
          onResolve={(resolution) =>
            resolveRepairInteractionAction(interaction.id, {
              mutationId: createClientId(),
              expectedVersion: bug.version,
              resolution,
            })
          }
          pending={pending}
          run={run}
        />
      ))}
      {!node.result ? (
        <dl className="collab-bug-detail-list">
          <Detail label="处理状态">
            {['CLAIMED', 'RUNNING'].includes(node.executionState)
              ? '正在自动处理'
              : repairStateLabel(node.executionState)}
          </Detail>
          <Detail label="开始时间">
            {node.startedAt
              ? formatDateTime(node.startedAt)
              : '等待 Agent 开始'}
          </Detail>
        </dl>
      ) : node.result.outcome === 'COMPLETED' ? (
        <>
          <TimelineList
            emptyLabel="Codex 未报告具体修改"
            items={node.result.changes}
            title="修改内容"
          />
          <div className="collab-repair-validations">
            <h4>检查结果</h4>
            {node.result.validations.length ? (
              <ul>
                {node.result.validations.map((validation) => (
                  <li
                    data-validation-status={validation.status}
                    key={`${validation.name}:${validation.status}`}
                  >
                    <strong>{validationStatusLabel(validation.status)}</strong>
                    <span>{validation.name}</span>
                    {validation.detail ? (
                      <small>{validation.detail}</small>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Codex 未报告检查项</p>
            )}
          </div>
          {node.result.warnings.length ? (
            <TimelineList items={node.result.warnings} title="警告" />
          ) : null}
          <p className="collab-repair-commit-count">
            已记录 {node.result.commitCount} 个候选提交
          </p>
          {node.result.commits ? (
            <details>
              <summary>技术详情</summary>
              {node.result.commits?.length ? (
                <ol>
                  {node.result.commits.map((commit) => (
                    <li key={commit}>
                      <code>{commit}</code>
                    </li>
                  ))}
                </ol>
              ) : null}
            </details>
          ) : null}
        </>
      ) : (
        <>
          <dl className="collab-bug-detail-list">
            <Detail label="失败阶段">{node.result.failedStep}</Detail>
            <Detail label="失败原因">{node.result.reason}</Detail>
          </dl>
          <TimelineList
            emptyLabel="无"
            items={node.result.completedActions}
            title="已完成事项"
          />
          <TimelineList
            emptyLabel="无"
            items={node.result.pendingActions}
            title="未执行事项"
          />
          {node.result.failureCode ? (
            <details>
              <summary>技术详情</summary>
              {node.result.failureCode ? (
                <code>{node.result.failureCode}</code>
              ) : null}
            </details>
          ) : null}
          {isLatestRepairAttempt &&
          repair?.availableActions.includes('SYNC_SESSION') ? (
            <>
              {repair.synchronizationError ? (
                <p>{repair.synchronizationError}</p>
              ) : null}
              <button
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      synchronizeRepairSessionAction(bug.id, {
                        mutationId: createClientId(),
                        expectedVersion: bug.version,
                      }),
                    '正在同步原修复会话状态。',
                  )
                }
                type="button"
              >
                同步状态
              </button>
            </>
          ) : null}
        </>
      )}
    </article>
  );
}

function ProgressAttachments({
  attachments,
}: {
  attachments: StoredAttachment[];
}) {
  if (!attachments.length) return null;
  return (
    <ul className="collab-attachments collab-bug-attachments">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          <AttachmentLink attachment={attachment} />
        </li>
      ))}
    </ul>
  );
}

function validationStatusLabel(
  status: 'PASSED' | 'FAILED' | 'SKIPPED',
): string {
  return {
    PASSED: '通过',
    FAILED: '未通过',
    SKIPPED: '未执行',
  }[status];
}
