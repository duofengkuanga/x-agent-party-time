'use client';

import { useState } from 'react';
import type { BugRepairView } from '@/contracts/submissions/repair';
import {
  resolveRepairInteractionAction,
  synchronizeRepairSessionAction,
} from '@/app/actions/submissions/repair';
import { createClientId } from '@/app/(pages)/(main)/components/clientId';
import type { BugView } from '../../../../../../contracts/submissions/bug';
import { AttachmentLink, type StoredAttachment } from './attachments';
import type { WorkspaceActionResult } from './boardModel';
import { ManualHandoff } from './manualHandoff';
import { SubmissionInteractionRecord } from './interactionRecord';
import { ObservationDetails } from './observationDetails';
import {
  ExecutionIdentity,
  ExecutionRound,
  RoundChecks,
  RoundLines,
} from './executionRound';
import {
  executionRoundProgress,
  executionRoundStatus,
  type RepairRound,
} from './developerDetailModel';

export type RunWorkspaceAction = (
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
        <section className="collab-round-detail">
          <h4>本次结果约束</h4>
          <pre>{correction.schema}</pre>
        </section>
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

export function RepairAttemptDetails({
  bug,
  node,
  repair,
  latest,
  current,
  pending,
  run,
  currentSessionId,
}: {
  bug: BugView;
  node: RepairRound;
  repair: BugRepairView | null;
  latest: boolean;
  current: boolean;
  pending: boolean;
  run: RunWorkspaceAction;
  currentSessionId: string | null;
}) {
  const result = node.result;
  const completed = result?.outcome === 'COMPLETED' ? result : null;
  const failed = result?.outcome === 'FAILED' ? result : null;
  return (
    <ExecutionRound
      title={`第 ${node.attempt} 轮修复`}
      kind="repair"
      analysis={
        node.canReadObservations ? (
          <ObservationDetails
            key={node.executionId}
            executionId={node.executionId}
          />
        ) : null
      }
      status={executionRoundStatus(node)}
      at={node.queuedAt}
      finishedAt={node.finishedAt}
      current={current}
      identity={
        <>
          <p className="collab-round-agent">Agent：{node.agentName}</p>
          {node.sessionId && node.sessionId !== currentSessionId ? (
            <ExecutionIdentity
              label="本轮修复会话 ID"
              value={node.sessionId}
              session
            />
          ) : null}
        </>
      }
      progress={
        <>
          {result?.outcome !== 'HANDED_OFF' ? (
            <p>{executionRoundProgress(node)}</p>
          ) : null}
          {result?.outcome === 'HANDED_OFF' ? (
            <ManualHandoff
              questions={result.questions}
              sessionId={node.sessionId}
            />
          ) : null}
          {node.interactions.map((interaction) => (
            <SubmissionInteractionRecord
              key={interaction.id}
              interaction={interaction}
              pending={pending}
              run={run}
              onResolve={(resolution) =>
                resolveRepairInteractionAction(interaction.id, {
                  mutationId: createClientId(),
                  expectedVersion: bug.version,
                  resolution,
                })
              }
            />
          ))}
          {failed?.pendingActions.length ? (
            <RoundLines
              items={failed.pendingActions}
              empty=""
              label="待处理事项"
            />
          ) : null}
          {failed?.failureCode ? (
            <section className="collab-round-detail">
              <h4>技术原因</h4>
              <code>{failed.failureCode}</code>
            </section>
          ) : null}
          {latest && repair?.availableActions.includes('SYNC_SESSION') ? (
            <>
              {repair.synchronizationError ? (
                <p role="alert">{repair.synchronizationError}</p>
              ) : null}
              {repair.synchronizationCorrection ? (
                <SynchronizationCorrection
                  correction={repair.synchronizationCorrection}
                />
              ) : null}
              <button
                disabled={pending}
                type="button"
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
              >
                同步状态
              </button>
            </>
          ) : null}
        </>
      }
      changes={
        <RoundLines
          items={completed?.changes ?? failed?.completedActions ?? []}
          empty="本轮尚未收到代码变更说明。"
        />
      }
      checks={<RoundChecks items={completed?.validations ?? []} />}
      delivery={
        <>
          <p>
            {completed
              ? completed.commitCount
                ? `本轮已记录 ${completed.commitCount} 个本地提交，后续更新单独记录。`
                : '本轮无需新增提交，目标分支已有修复。'
              : '本轮尚未确认完成交付。'}
          </p>
          {completed?.commits?.length ? (
            <section className="collab-round-detail">
              <h4>本轮提交</h4>
              <ul>
                {completed.commits.map((commit) => (
                  <li key={commit}>
                    <code>{commit}</code>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {completed?.warnings.length ? (
            <RoundLines items={completed.warnings} empty="" label="提醒" />
          ) : null}
        </>
      }
    />
  );
}
