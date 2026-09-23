'use client';
import {
  ProgressTimeline,
  ProgressAttachments,
  type ProgressHeading,
} from './progress-timeline';
import { ValidationResults } from './validation-results';

import type { BugRepairView } from '@/cooking/repair/contract';
import {
  resolveRepairInteractionAction,
  synchronizeRepairSessionAction,
} from '@/cooking/repair/server/actions';
import { createClientId } from '@/cooking/shared/ui/client-id';
import type { BugProgressTimelineNode } from '@/cooking/workspace/contract';
import { useState } from 'react';
import type { BugView } from '../contract';
import type { StoredAttachment } from './attachments';
import { AttachmentLink } from './attachments';
import type { WorkspaceActionResult } from './board-model';
import { formatDateTime, repairStateLabel } from './board-model';
import { Detail, TimelineList } from './detail-fields';
import { CookingInteractionRecord } from './interaction-record';

type RunWorkspaceAction = (
  command: () => Promise<WorkspaceActionResult>,
  message: string,
  afterSuccess?: () => void,
) => void;

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

type RepairProgressContext = {
  bug: BugView;
  pending: boolean;
  repair: BugRepairView | null;
  run: RunWorkspaceAction;
};

export function RepairAttemptDetails({
  timeline,
  summaryOnly,
  ...context
}: RepairProgressContext & {
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
    <ProgressTimeline
      nodes={timeline}
      title={isUpdateTimeline ? '更新进展' : '修复进展'}
      description={
        isUpdateTimeline
          ? '按批次从旧到新记录。'
          : '按修复生命周期从旧到新记录。'
      }
      summaryOnly={summaryOnly}
    >
      {(node) => describeBugProgress(node, context, latestRepairAttemptId)}
    </ProgressTimeline>
  );
}

function SynchronizationCorrection({
  correction,
}: {
  correction: NonNullable<BugRepairView['synchronizationCorrection']>;
}) {
  const [copied, setCopied] = useState(false);
  const text = correction.schema
    ? `${correction.instruction}\n\n结果约束：\n${correction.schema}`
    : correction.instruction;
  return (
    <aside className="collab-sync-correction" aria-label="同步补正指引">
      <p>{correction.instruction}</p>
      {correction.schema ? (
        <details>
          <summary>本次结果约束</summary>
          <pre>{correction.schema}</pre>
        </details>
      ) : null}
      <button
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        }}
        type="button"
      >
        {copied ? '已复制补正指引' : '复制补正指引'}
      </button>
    </aside>
  );
}

function describeBugProgress(
  node: BugProgressTimelineNode,
  context: RepairProgressContext,
  latestRepairAttemptId: string | undefined,
): ProgressHeading {
  switch (node.kind) {
    case 'BUG_REGISTERED':
      return {
        title: '缺陷已登记',
        occurredAt: node.occurredAt,
        content: <p>原始报告已进入待修复阶段。</p>,
      };
    case 'UPDATE_BATCH':
      return {
        title: '已进入统一更新批次',
        summaryTitle: `统一更新 · ${node.visual.label}`,
        occurredAt: node.occurredAt,
        content: (
          <>
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
          </>
        ),
      };
    case 'VERIFICATION': {
      const title = `第 ${node.round} 轮验证${node.result === 'PASSED' ? '已通过' : '未通过'}`;
      return {
        title,
        summaryTitle: title + (node.result === 'FAILED' ? '，已返修' : ''),
        occurredAt: node.createdAt,
        content: (
          <>
            <p>{node.comment || '测试负责人未补充说明。'}</p>
            {node.result === 'FAILED' && node.repairAttempt ? (
              <strong>已进入第 {node.repairAttempt} 轮修复</strong>
            ) : null}
            <ProgressAttachments attachments={node.attachments} />
          </>
        ),
      };
    }
    case 'REOPEN':
      return {
        title: `第 ${node.round} 次重新打开`,
        summaryTitle: `第 ${node.round} 次重新打开，已返修`,
        occurredAt: node.createdAt,
        content: (
          <>
            <p>{node.feedback}</p>
            <strong>已进入第 {node.repairAttempt} 轮修复</strong>
            <ProgressAttachments attachments={node.attachments} />
          </>
        ),
      };
    case 'CANCELLED':
    case 'RESTORED':
      return {
        title: node.kind === 'CANCELLED' ? '缺陷已取消' : '缺陷已恢复到待修复',
        occurredAt: node.createdAt,
        content: (
          <p>
            {node.kind === 'CANCELLED'
              ? '缺陷已移出主看板，可从已取消缺陷中恢复。'
              : '原始资料已重新开放编辑，尚未自动开始修复。'}
          </p>
        ),
      };
    case 'REPAIR_ATTEMPT':
      return {
        title: `第 ${node.attempt} 轮修复${node.result?.outcome === 'COMPLETED' ? '已完成' : node.result?.outcome === 'FAILED' ? '未完成' : '进行中'}`,
        occurredAt: node.finishedAt ?? node.startedAt ?? node.queuedAt,
        content: (
          <RepairAttemptTimelineArticle
            {...context}
            isLatestRepairAttempt={node.id === latestRepairAttemptId}
            node={node}
          />
        ),
      };
  }
}

function RepairAttemptTimelineArticle({
  bug,
  isLatestRepairAttempt,
  node,
  pending,
  repair,
  run,
}: RepairProgressContext & {
  isLatestRepairAttempt: boolean;
  node: Extract<BugProgressTimelineNode, { kind: 'REPAIR_ATTEMPT' }>;
}) {
  return (
    <>
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
          <ValidationResults
            statusLabel={validationStatusLabel}
            items={node.result.validations}
            title="检查结果"
            emptyLabel="Codex 未报告检查项"
          />
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
              <code>{node.result.failureCode}</code>
            </details>
          ) : null}
          {isLatestRepairAttempt &&
          repair?.availableActions.includes('SYNC_SESSION') ? (
            <>
              {repair.synchronizationError ? (
                <p>{repair.synchronizationError}</p>
              ) : null}
              {repair.synchronizationCorrection ? (
                <SynchronizationCorrection
                  correction={repair.synchronizationCorrection}
                />
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
    </>
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
