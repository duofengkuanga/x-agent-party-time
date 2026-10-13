'use client';

import { useRef, useState } from 'react';
import type { UpdateBatchView } from '@/cooking/update/contract';
import {
  reportExternalDeploymentAction,
  resolveUpdateInteractionAction,
  synchronizeUpdateSessionAction,
} from '@/cooking/update/server/actions';
import { createClientId } from '@/cooking/shared/ui/client-id';
import { AttachmentPicker } from './attachments';
import { useWorkspaceMutation } from './use-workspace-mutation';
import { ManualHandoff } from './manual-handoff';
import { CookingInteractionRecord } from './interaction-record';
import { ProgressAttachments } from './progress-timeline';
import {
  ExecutionIdentity,
  ExecutionRound,
  ExecutionRoundTabs,
  RoundChecks,
  RoundLines,
} from './execution-round';
import {
  executionRoundProgress,
  executionRoundStatus,
  type UpdateRound,
} from './developer-detail-model';
import type { RunWorkspaceAction } from './repair-timeline';
import { formatDateTime } from './board-model';

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
            <CookingInteractionRecord
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
      checks={<RoundChecks items={work?.validations ?? []} />}
      delivery={
        <>
          <p>
            {work?.outcome === 'COMPLETED'
              ? '本轮已完成推送和环境更新。'
              : work?.outcome === 'PUSHED'
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
          {work?.warnings.length ? (
            <RoundLines items={work.warnings} empty="" label="提醒" />
          ) : null}
          {latest && batch.availableActions.includes('REPORT_EXTERNAL') ? (
            <>
              {batch.hasManualDatabaseOperation ? (
                <p>请先人工执行代码仓库中的 SQL，并确认本批环境更新结果。</p>
              ) : null}
              <UpdateBatchActions batch={batch} pending={pending} run={run} />
            </>
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
    { kind: 'EXTERNAL_REPORT' }
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
            node.kind === 'EXTERNAL_REPORT' ? (
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

function UpdateBatchActions({
  batch,
  pending,
  run,
}: {
  batch: UpdateBatchView;
  pending: boolean;
  run: RunWorkspaceAction;
}) {
  const [externalOutcome, setExternalOutcome] = useState<
    'SUCCEEDED' | 'FAILED'
  >('SUCCEEDED');
  const [externalSummary, setExternalSummary] = useState('');
  const [externalFiles, setExternalFiles] = useState<File[]>([]);
  const externalFileInput = useRef<HTMLInputElement>(null);

  return (
    <section className="collab-batch-actions" aria-label="确认整批更新结果">
      <p>本次确认将作用于本批全部 {batch.entries.length} 条缺陷。</p>
      {batch.availableActions.includes('REPORT_EXTERNAL') ? (
        <div className="collab-form collab-bug-verification">
          <label>
            <span>外部更新结果</span>
            <select
              onChange={(event) =>
                setExternalOutcome(event.target.value as 'SUCCEEDED' | 'FAILED')
              }
              value={externalOutcome}
            >
              <option value="SUCCEEDED">外部更新成功</option>
              <option value="FAILED">外部更新失败</option>
            </select>
          </label>
          <textarea
            maxLength={8_000}
            onChange={(event) => setExternalSummary(event.target.value)}
            placeholder={
              externalOutcome === 'FAILED'
                ? '说明持续集成或部署失败原因'
                : '可补充外部更新结果'
            }
            rows={3}
            value={externalSummary}
          />
          <AttachmentPicker
            files={externalFiles}
            inputRef={externalFileInput}
            onChange={setExternalFiles}
          />
          <button
            disabled={
              pending ||
              (externalOutcome === 'FAILED' && !externalSummary.trim())
            }
            onClick={() => {
              const formData = new FormData();
              formData.set('mutationId', createClientId());
              formData.set('expectedVersion', String(batch.version));
              formData.set('outcome', externalOutcome);
              formData.set('summary', externalSummary);
              externalFiles.forEach((file) =>
                formData.append('attachments', file),
              );
              run(
                () => reportExternalDeploymentAction(batch.id, formData),
                externalOutcome === 'SUCCEEDED'
                  ? '外部更新已确认成功，缺陷进入待验证。'
                  : '外部更新失败记录已追加。',
                () => {
                  setExternalSummary('');
                  setExternalFiles([]);
                  if (externalFileInput.current)
                    externalFileInput.current.value = '';
                },
              );
            }}
            type="button"
          >
            提交外部结果
          </button>
        </div>
      ) : null}
    </section>
  );
}
