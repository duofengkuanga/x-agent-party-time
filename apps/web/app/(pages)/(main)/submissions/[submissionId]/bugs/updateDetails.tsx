'use client';

import type { UpdateBatchView } from '@/contracts/submissions/update';
import {
  resolveUpdateInteractionAction,
  retryUpdateAction,
  synchronizeUpdateSessionAction,
} from '@/app/actions/submissions/update';
import { createClientId } from '@/app/(pages)/(main)/components/clientId';
import { ProgressAttachments } from './attachments';
import { useWorkspaceMutation } from './useWorkspaceMutation';
import { ManualHandoff } from './manualHandoff';
import { SubmissionInteractionRecord } from './interactionRecord';

import {
  ExecutionIdentity,
  ExecutionRound,
  ExecutionRoundTabs,
  RoundChecks,
  RoundLines,
} from './executionRound';
import {
  executionRoundProgress,
  executionRoundStatus,
  type UpdateRound,
} from './developerDetailModel';
import type { RunWorkspaceAction } from './repairTimeline';
import { formatDateTime } from './boardModel';
import { HandoffUseDetails, RepairHandoffDetails } from './handoffDetails';
import { ObservationDetails } from './observationDetails';

export function UpdateAttemptDetails({
  batch,
  node,
  round,
  latest,
  current,
  pending,
  run,
  currentSessionId,
  onOpenBatch,
}: {
  batch: UpdateBatchView;
  node: UpdateRound;
  round: number;
  latest: boolean;
  current: boolean;
  pending: boolean;
  run: RunWorkspaceAction;
  currentSessionId: string | null;
  onOpenBatch?: (batchId: string) => void;
}) {
  const result = node.result;
  const work = result && result.outcome !== 'HANDED_OFF' ? result : null;
  return (
    <ExecutionRound
      kind="update"
      analysis={
        node.canReadObservations ? (
          <ObservationDetails
            key={node.executionId}
            executionId={node.executionId}
            shared
          />
        ) : null
      }
      title={`第 ${round} 轮更新`}
      status={executionRoundStatus(node)}
      at={node.queuedAt}
      finishedAt={node.finishedAt}
      current={current}
      identity={
        <>
          <p className="collab-round-agent">
            {batch.engineeringName} · {batch.targetBranch} ·{' '}
            {batch.environmentName} · 共 {batch.entries.length} 条缺陷
          </p>
          {node.sessionId && node.sessionId !== currentSessionId ? (
            <ExecutionIdentity
              label="本轮更新会话 ID"
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
              subject="UPDATE"
              key={interaction.id}
              interaction={interaction}
              pending={pending}
              run={run}
              onResolve={(resolution) =>
                resolveUpdateInteractionAction(interaction.id, {
                  mutationId: createClientId(),
                  expectedVersion: batch.version,
                  resolution,
                })
              }
            />
          ))}
          {work?.outcome === 'FAILED' ? (
            <>
              <RoundLines
                items={work.pendingActions}
                empty="未提供待处理事项。"
                label="待处理事项"
              />
              {work.failureCode ? (
                <section className="collab-round-detail">
                  <h4>技术原因</h4>
                  <code>{work.failureCode}</code>
                </section>
              ) : null}
            </>
          ) : null}
          {latest && batch.availableActions.includes('RETRY_UPDATE') ? (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    retryUpdateAction(batch.id, {
                      mutationId: createClientId(),
                      expectedVersion: batch.version,
                    }),
                  '原批次已重新排队。',
                )
              }
            >
              {node.sessionId ? '重试原批次' : '更新 Agent 规则后重试'}
            </button>
          ) : null}
          {latest && batch.availableActions.includes('SYNC_SESSION') ? (
            <div className="collab-batch-actions">
              <p>同步本批全部 {batch.entries.length} 条缺陷的更新结果。</p>
              {batch.synchronizationError ? (
                <p role="alert">{batch.synchronizationError}</p>
              ) : null}
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      synchronizeUpdateSessionAction(batch.id, {
                        mutationId: createClientId(),
                        expectedVersion: batch.version,
                      }),
                    '正在同步原统一更新会话状态。',
                  )
                }
              >
                同步状态
              </button>
            </div>
          ) : null}
        </>
      }
      changes={
        <>
          <p>本次更新包含 {batch.entries.length} 条缺陷的修复。</p>
          <section className="collab-round-detail">
            <h4>本批修复范围</h4>
            <ul>
              {batch.entries.map((entry) => (
                <li key={entry.bugId}>
                  <span>{entry.bugTitle}</span>
                  {entry.commits?.length ? (
                    <ul>
                      {entry.commits.map((commit) => (
                        <li key={commit}>
                          <code>{commit}</code>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {entry.repairHandoffs?.length ? (
                    <RepairHandoffDetails sources={entry.repairHandoffs} />
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
          {onOpenBatch ? (
            <button type="button" onClick={() => onOpenBatch(batch.id)}>
              查看批次详情
            </button>
          ) : null}
        </>
      }
      checks={
        <>
          <RoundChecks items={work?.validations ?? []} />
          {work?.handoffUse ? (
            <HandoffUseDetails
              use={work.handoffUse}
              validations={work.validations}
            />
          ) : null}
        </>
      }
      delivery={
        <>
          <p>
            {work?.outcome === 'COMPLETED'
              ? '本轮已完成推送和环境更新。'
              : work?.outcome === 'PUSH_CONFIRMED'
                ? '本轮已推送；环境更新结果以后续确认记录为准。'
                : work?.outcome === 'FAILED'
                  ? '本轮更新未完成。'
                  : '本轮尚未收到交付结果。'}
          </p>
          {work ? (
            <RoundLines
              items={work.completedActions}
              empty="未提供已完成操作。"
              label="已完成操作"
            />
          ) : null}
          {work?.engineeringDeliveries?.length ? (
            <section
              className="collab-round-detail"
              aria-label="各工程交付结果"
            >
              <h4>各工程交付结果</h4>
              <ul>
                {work.engineeringDeliveries.map((delivery) => (
                  <li key={delivery.alias}>
                    <strong>
                      {batch.engineeringNames?.[delivery.alias] ??
                        delivery.alias}{' '}
                      · {delivery.label}
                    </strong>
                    {delivery.evidence ? <p>{delivery.evidence}</p> : null}
                    {delivery.commit ? <code>{delivery.commit}</code> : null}
                    {delivery.convention ? (
                      <div className="collab-round-detail">
                        <p>
                          环境标识{' '}
                          <code>{delivery.convention.environmentKey}</code>
                        </p>
                        <p>
                          工程约定{' '}
                          <code>{delivery.convention.conventionPath}</code>
                        </p>
                        <p>
                          约定摘要{' '}
                          <code>{delivery.convention.conventionSha256}</code>
                        </p>
                        <p>
                          执行命令摘要{' '}
                          <code>{delivery.convention.commandSha256}</code>
                        </p>
                      </div>
                    ) : null}
                    {delivery.artifactSha256 ? (
                      <p>
                        验收摘要 <code>{delivery.artifactSha256}</code>
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {node.canReadObservations && batch.hasManualDatabaseOperation ? (
            <p>本批包含人工数据库交接。请在对应修复记录中查看 SQL 文件。</p>
          ) : null}
          {work?.warnings.length ? (
            <RoundLines items={work.warnings} empty="" label="提醒" />
          ) : null}
        </>
      }
    />
  );
}

export function ExternalUpdateReport({
  node,
}: {
  node: Extract<
    UpdateBatchView['timeline'][number],
    { kind: 'HISTORICAL_DEPLOYMENT' }
  >;
}) {
  return (
    <section className="collab-developer-event" aria-label="环境更新确认">
      <header>
        <strong>
          第 {node.round} 次环境更新确认：
          {node.outcome === 'SUCCEEDED' ? '成功' : '失败'}
        </strong>
        <time dateTime={node.occurredAt}>
          {formatDateTime(node.occurredAt)}
        </time>
      </header>
      {node.summary ? <p>{node.summary}</p> : null}
      <ProgressAttachments attachments={node.attachments} />
    </section>
  );
}

export function UpdateBatchDetails({
  batch,
  onChanged,
  onOpen,
}: {
  batch: UpdateBatchView;
  onChanged: (revision: number, message: string) => void;
  onOpen: (bugId: string) => void;
}) {
  const { error, pending, run } = useWorkspaceMutation(onChanged);
  const attempts = batch.timeline.filter(
    (node) => node.kind === 'UPDATE_ATTEMPT',
  );
  const latest = attempts.at(-1);
  return (
    <div className="collab-dialog__body collab-bug-drawer__body collab-developer-detail">
      <section className="collab-developer-status" aria-live="polite">
        <strong>{batch.presentation.visual.label}</strong>
        <span>
          {batch.targetBranch} · {batch.environmentName} · 共{' '}
          {batch.entries.length} 条缺陷
        </span>
      </section>
      <div className="collab-execution-identities">
        <ExecutionIdentity
          label="更新会话 ID"
          value={latest?.sessionId ?? null}
          session
        />
      </div>
      <section className="collab-batch-members" aria-label="批次内缺陷">
        <h3>本批 {batch.entries.length} 条缺陷</h3>
        <p>更新进展和操作由整批共享，点击缺陷查看各自的修复过程。</p>
        <ul>
          {batch.entries.map((entry) => (
            <li key={entry.bugId}>
              <button
                type="button"
                disabled={pending}
                onClick={() => onOpen(entry.bugId)}
              >
                缺陷-{String(entry.bugShortId).padStart(3, '0')} ·{' '}
                {entry.bugTitle}
              </button>
            </li>
          ))}
        </ul>
      </section>
      {error ? (
        <p className="collab-form__error" role="alert">
          {error}
        </p>
      ) : null}
      <section aria-label="批次更新记录">
        <ExecutionRoundTabs
          label="批次更新轮次"
          rounds={[...attempts].reverse().map((node) => ({
            id: node.id,
            label: `第 ${node.attempt} 轮更新`,
            content: (
              <UpdateAttemptDetails
                batch={batch}
                node={node}
                round={node.attempt}
                latest={node.id === latest?.id}
                current={node.id === latest?.id}
                pending={pending}
                run={run}
                currentSessionId={latest?.sessionId ?? null}
              />
            ),
          }))}
        />
        <ol className="collab-developer-timeline">
          {[...batch.timeline].reverse().map((node) =>
            node.kind === 'HISTORICAL_DEPLOYMENT' ? (
              <li key={node.id}>
                <ExternalUpdateReport node={node} />
              </li>
            ) : null,
          )}
        </ol>
      </section>
    </div>
  );
}
