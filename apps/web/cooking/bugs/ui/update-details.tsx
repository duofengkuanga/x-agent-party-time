'use client';

import { useRef, useState, useTransition } from 'react';
import { createClientId } from '@/cooking/shared/ui/client-id';
import type { UpdateBatchView } from '@/cooking/update/contract';
import {
  reportExternalDeploymentAction,
  resolveUpdateInteractionAction,
  synchronizeUpdateSessionAction,
} from '@/cooking/update/server/actions';
import type { WorkspaceActionResult } from './board-model';
import {
  messageOf,
  deploymentLabel,
  formatDateTime,
  updateAttemptLabel,
  validationLabel,
  repairStateLabel,
} from './board-model';
import { Detail, DetailList } from './detail-fields';

import { AttachmentLink, AttachmentPicker } from './attachments';

import { CookingInteractionRecord } from './interaction-record';

export function UpdateBatchDetails({
  batch,
  embedded = false,
  onChanged,
  summaryOnly = false,
}: {
  batch: UpdateBatchView;
  embedded?: boolean;
  onChanged: (revision: number, message: string) => void;
  summaryOnly?: boolean;
}) {
  const [externalOutcome, setExternalOutcome] = useState<
    'SUCCEEDED' | 'FAILED'
  >('SUCCEEDED');
  const [externalSummary, setExternalSummary] = useState('');
  const [externalFiles, setExternalFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const externalFileInput = useRef<HTMLInputElement>(null);

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

  const batchFacts = (
    <dl>
      <Detail label="批次状态">{batch.presentation.statusLabel}</Detail>
      <Detail label="当前状态">
        <span
          aria-label={batch.presentation.visual.label}
          className="collab-current-visual"
          data-visual-state={batch.presentation.visual.state}
        >
          <span aria-hidden="true">{batch.presentation.visual.symbol}</span>
          {batch.presentation.visual.label}
        </span>
      </Detail>
      <Detail label="目标分支">{batch.targetBranch}</Detail>
      <Detail label="部署方式">{deploymentLabel(batch.deploymentKind)}</Detail>
      <Detail label="环境">{batch.environmentName}</Detail>
      {batch.hasManualDatabaseOperation ? (
        <Detail label="数据库操作">请人工执行代码仓库中的 SQL</Detail>
      ) : null}
    </dl>
  );

  return (
    <div
      className={`collab-update-batch-detail${embedded ? ' collab-update-batch-detail--embedded' : ' collab-dialog__body collab-bug-drawer__body'}`}
    >
      {!embedded && !summaryOnly ? (
        <header className="collab-bug-detail-hero">
          <div>
            <small>共享更新对象</small>
            <h2>{batch.engineeringName} · 统一更新批次</h2>
          </div>
          {batchFacts}
        </header>
      ) : null}
      {error ? (
        <p className="collab-form__error" role="alert">
          {error}
        </p>
      ) : null}
      {!embedded && !summaryOnly ? (
        <section className="collab-bug-detail-section">
          <h3>冻结范围</h3>
          <p>
            {formatDateTime(batch.frozenAt)} 冻结，共 {batch.entries.length}{' '}
            条缺陷。批次完成后会分别回到待验证。
          </p>
          <UpdateBatchEntries batch={batch} embedded={false} />
        </section>
      ) : null}
      <section
        className="collab-bug-detail-section collab-progress-timeline collab-update-batch-progress"
        data-summary-only={summaryOnly ? 'true' : undefined}
      >
        <header>
          <div>
            <h3>{embedded || summaryOnly ? '更新进展' : '批次进展'}</h3>
            <p>
              {embedded || summaryOnly
                ? '按批次从旧到新记录。'
                : `${batch.engineeringName} 的统一更新执行记录。`}
            </p>
          </div>
        </header>
        <ol className="collab-repair-timeline collab-update-timeline">
          {batch.timeline.map((node) => {
            if (summaryOnly)
              return <UpdateProgressSummaryNode key={node.id} node={node} />;
            if (node.kind === 'BATCH_FORMED')
              return (
                <li data-node-kind={node.kind} key={node.id}>
                  <span
                    aria-hidden="true"
                    className="collab-repair-timeline__mark"
                  />
                  <article>
                    <header>
                      <strong>统一更新批次已形成</strong>
                      <time>{formatDateTime(node.occurredAt)}</time>
                    </header>
                    {embedded ? (
                      <>
                        <p>
                          已冻结 {node.bugCount}{' '}
                          条缺陷，更新完成后分别回到待验证。
                        </p>
                        <details className="collab-update-scope">
                          <summary>
                            冻结范围 · {batch.entries.length} 条缺陷
                          </summary>
                          <UpdateBatchEntries batch={batch} embedded />
                        </details>
                      </>
                    ) : (
                      <p>已冻结 {node.bugCount} 条缺陷。</p>
                    )}
                  </article>
                </li>
              );
            if (node.kind === 'EXTERNAL_REPORT')
              return (
                <li data-node-kind={node.kind} key={node.id}>
                  <span
                    aria-hidden="true"
                    className="collab-repair-timeline__mark"
                    data-outcome={node.outcome}
                  />
                  <article>
                    <header>
                      <strong>
                        第 {node.round} 轮外部部署
                        {node.outcome === 'SUCCEEDED' ? '成功' : '失败'}
                      </strong>
                      <time>{formatDateTime(node.occurredAt)}</time>
                    </header>
                    {node.summary ? <p>{node.summary}</p> : null}
                    {node.attachments.length ? (
                      <ul className="collab-attachments collab-bug-attachments">
                        {node.attachments.map((attachment) => (
                          <li key={attachment.id}>
                            <AttachmentLink attachment={attachment} />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                </li>
              );
            return (
              <li data-node-kind={node.kind} key={node.id}>
                <span
                  aria-hidden="true"
                  className="collab-repair-timeline__mark"
                  data-outcome={node.result?.outcome}
                />
                <article>
                  <header>
                    <strong>{updateAttemptLabel(node)}</strong>
                    <time>{formatDateTime(node.queuedAt)}</time>
                  </header>
                  {node.sessionId ? (
                    <dl className="collab-bug-detail-list collab-session-facts">
                      <Detail label="更新会话 ID">{node.sessionId}</Detail>
                    </dl>
                  ) : null}
                  {node.result?.outcome === 'FAILED' ? (
                    <>
                      <div className="collab-structured-failure">
                        <header>
                          <span>本轮中断</span>
                          <strong>{node.result.failedStep}</strong>
                        </header>
                        <p>
                          <span>失败原因</span>
                          {node.result.reason}
                        </p>
                      </div>
                      <div className="collab-update-attempt-results">
                        <DetailList
                          kind="completed"
                          items={node.result.completedActions}
                          title="已完成操作"
                        />
                        <div
                          className="collab-repair-validations"
                          data-result-kind="validation"
                        >
                          <h4>验证结果</h4>
                          {node.result.validations.length ? (
                            <ul>
                              {node.result.validations.map(
                                (validation, index) => (
                                  <li
                                    data-validation-status={validation.status}
                                    key={`${validation.name}:${index}`}
                                  >
                                    <strong>
                                      {validationLabel(validation.status)}
                                    </strong>
                                    <span>{validation.name}</span>
                                    {validation.detail ? (
                                      <small>{validation.detail}</small>
                                    ) : null}
                                  </li>
                                ),
                              )}
                            </ul>
                          ) : (
                            <p>Codex 未报告验证项</p>
                          )}
                        </div>
                        {node.result.warnings.length ? (
                          <DetailList
                            kind="warning"
                            items={node.result.warnings}
                            title="提醒"
                          />
                        ) : null}
                        <DetailList
                          kind="pending"
                          items={node.result.pendingActions}
                          title="待处理事项"
                        />
                      </div>
                    </>
                  ) : node.result ? (
                    <>
                      <div className="collab-update-attempt-results">
                        <DetailList
                          kind="completed"
                          items={node.result.completedActions}
                          title="已完成操作"
                        />
                        <div
                          className="collab-repair-validations"
                          data-result-kind="validation"
                        >
                          <h4>验证结果</h4>
                          {node.result.validations.length ? (
                            <ul>
                              {node.result.validations.map(
                                (validation, index) => (
                                  <li
                                    data-validation-status={validation.status}
                                    key={`${validation.name}:${index}`}
                                  >
                                    <strong>
                                      {validationLabel(validation.status)}
                                    </strong>
                                    <span>{validation.name}</span>
                                    {validation.detail ? (
                                      <small>{validation.detail}</small>
                                    ) : null}
                                  </li>
                                ),
                              )}
                            </ul>
                          ) : (
                            <p>Codex 未报告验证项</p>
                          )}
                        </div>
                        {node.result.warnings.length ? (
                          <DetailList
                            kind="warning"
                            items={node.result.warnings}
                            title="提醒"
                          />
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <dl className="collab-bug-detail-list">
                      <Detail label="处理状态">
                        {repairStateLabel(node.executionState)}
                      </Detail>
                    </dl>
                  )}
                  {node.interactions.length ? (
                    <ol className="collab-update-interactions">
                      {node.interactions.map((interaction) => (
                        <li key={interaction.id}>
                          <CookingInteractionRecord
                            interaction={interaction}
                            onResolve={(resolution) =>
                              resolveUpdateInteractionAction(interaction.id, {
                                mutationId: createClientId(),
                                expectedVersion: batch.version,
                                resolution,
                              })
                            }
                            pending={pending}
                            run={run}
                          />
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {node.result?.outcome === 'FAILED' &&
                  node.result.failureCode ? (
                    <details className="collab-technical-details">
                      <summary>技术详情</summary>
                      {node.result.outcome === 'FAILED' &&
                      node.result.failureCode ? (
                        <code>{node.result.failureCode}</code>
                      ) : null}
                    </details>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ol>
      </section>
      {!summaryOnly && batch.availableActions.length ? (
        <section className="collab-bug-detail-section">
          <h3>批次操作</h3>
          {batch.availableActions.includes('SYNC_SESSION') ? (
            <>
              {batch.synchronizationError ? (
                <p>{batch.synchronizationError}</p>
              ) : null}
              <button
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
                type="button"
              >
                同步状态
              </button>
            </>
          ) : null}
          {batch.availableActions.includes('REPORT_EXTERNAL') ? (
            <div className="collab-form collab-bug-verification">
              <label>
                <span>外部更新结果</span>
                <select
                  onChange={(event) =>
                    setExternalOutcome(
                      event.target.value as 'SUCCEEDED' | 'FAILED',
                    )
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
                      : '外部更新失败记录已追加，可重新执行原批次。',
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
      ) : null}
    </div>
  );
}

function UpdateProgressSummaryNode({
  node,
}: {
  node: UpdateBatchView['timeline'][number];
}) {
  const title =
    node.kind === 'BATCH_FORMED'
      ? '统一更新批次已形成'
      : node.kind === 'EXTERNAL_REPORT'
        ? `第 ${node.round} 轮外部部署${node.outcome === 'SUCCEEDED' ? '成功' : '失败'}`
        : updateAttemptLabel(node);
  const occurredAt =
    node.kind === 'UPDATE_ATTEMPT' ? node.queuedAt : node.occurredAt;
  const outcome =
    node.kind === 'EXTERNAL_REPORT'
      ? node.outcome
      : node.kind === 'UPDATE_ATTEMPT'
        ? node.result?.outcome
        : undefined;
  return (
    <li data-node-kind={node.kind}>
      <span
        aria-hidden="true"
        className="collab-repair-timeline__mark"
        data-outcome={outcome}
      />
      <article className="collab-progress-summary">
        <header>
          <strong>{title}</strong>
          <time>{formatDateTime(occurredAt)}</time>
        </header>
      </article>
    </li>
  );
}

function UpdateBatchEntries({
  batch,
  embedded,
}: {
  batch: UpdateBatchView;
  embedded: boolean;
}) {
  return (
    <ol className="collab-repair-records collab-update-scope__entries">
      {batch.entries.map((entry) => (
        <li key={entry.bugId}>
          <strong>
            {embedded ? (
              entry.bugTitle
            ) : (
              <>
                缺陷-{String(entry.bugShortId).padStart(3, '0')} ·{' '}
                {entry.bugTitle}
              </>
            )}
          </strong>
          {entry.commits?.length ? (
            <details>
              <summary>{entry.commits.length} 个候选 Commit</summary>
              <ol className="collab-repair-records">
                {entry.commits.map((commit) => (
                  <li key={commit}>
                    <code>{commit}</code>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
