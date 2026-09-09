'use client';

import { useEffect, useState } from 'react';
import type { JsonValue } from '@agent-party-time/execution-contract';
import { type CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import { CleanupInteractionPanel } from './cleanup-interaction';

export function SubmissionDetails({
  onResolveCleanupInteraction,
  onRetryCleanup,
  snapshot,
  updateDetails,
  updating,
}: {
  onResolveCleanupInteraction: (
    interactionId: string,
    expectedVersion: number,
    resolution: JsonValue,
  ) => void;
  onRetryCleanup: (cleanupId: string, expectedVersion: number) => void;
  snapshot: CookingWorkspaceSnapshot;
  updateDetails: (
    title: string,
    requirementDescription: string,
    targetBranches: Array<{
      submissionItemId: string;
      targetBranch: string;
    }>,
  ) => void;
  updating: boolean;
}) {
  const view = snapshot.submission;
  const submission = view.submission;
  const [title, setTitle] = useState(submission.title);
  const [requirementDescription, setRequirementDescription] = useState(
    submission.requirementDescription,
  );
  const [targetBranches, setTargetBranches] = useState<Record<string, string>>(
    () =>
      Object.fromEntries(
        view.items.map((item) => [item.id, item.targetBranch]),
      ),
  );
  const editable = view.availableActions.includes('EDIT_DETAILS');
  const editableTargetBranches = view.items.filter((item) =>
    item.availableActions.includes('EDIT_TARGET_BRANCH'),
  );
  const detailsChanged =
    title !== submission.title ||
    requirementDescription !== submission.requirementDescription;
  const targetBranchesChanged = editableTargetBranches.some(
    (item) => targetBranches[item.id] !== item.targetBranch,
  );
  const canSave = editable || editableTargetBranches.length > 0;
  useEffect(() => {
    setTitle(submission.title);
    setRequirementDescription(submission.requirementDescription);
    setTargetBranches(
      Object.fromEntries(
        view.items.map((item) => [item.id, item.targetBranch]),
      ),
    );
  }, [submission.id, submission.version, view.items]);
  return (
    <header className="collab-submission-header">
      <dl className="collab-submission-facts">
        <div>
          <dt>项目</dt>
          <dd>{view.projectName}</dd>
        </div>
        <div>
          <dt>提测状态</dt>
          <dd>{submission.status === 'ACTIVE' ? '进行中' : '已关闭'}</dd>
        </div>
        <div>
          <dt>需求说明</dt>
          <dd>{submission.requirementDescription}</dd>
        </div>
        <div>
          <dt>测试负责人</dt>
          <dd>{view.tester.displayName}</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{formatDateTime(submission.createdAt)}</dd>
        </div>
      </dl>
      <div className="collab-submission-projects">
        <table aria-label="提测工程配置">
          <thead>
            <tr>
              <th>工程</th>
              <th>开发负责人</th>
              <th>目标分支</th>
              <th>测试环境 / 部署方式</th>
            </tr>
          </thead>
          <tbody>
            {view.items.map((item) => {
              const cleanup = snapshot.cleanups.find(
                (candidate) =>
                  candidate.reason === 'SUBMISSION_CLOSED' &&
                  candidate.submissionItemId === item.id,
              );
              const cleanupInteraction = cleanup
                ? snapshot.cleanupInteractions.find(
                    (candidate) => candidate.cleanupId === cleanup.id,
                  )
                : undefined;
              return (
                <tr key={item.id}>
                  <td>{item.engineering.name}</td>
                  <td>{item.responsibleUser.displayName}</td>
                  <td>
                    {item.availableActions.includes('EDIT_TARGET_BRANCH') ? (
                      <input
                        aria-label={`${item.engineering.name}目标分支`}
                        className="collab-table-input"
                        disabled={updating}
                        form="collab-submission-details-form"
                        maxLength={240}
                        onChange={(event) =>
                          setTargetBranches((current) => ({
                            ...current,
                            [item.id]: event.target.value,
                          }))
                        }
                        required
                        value={targetBranches[item.id] ?? item.targetBranch}
                      />
                    ) : (
                      item.targetBranch
                    )}
                  </td>
                  <td>
                    <span>
                      {item.environment.name}
                      {item.technical
                        ? ` / ${
                            item.technical.deployment.kind === 'LOCAL_SCRIPT'
                              ? '本地脚本'
                              : '持续集成与部署'
                          }`
                        : ''}
                    </span>
                    {cleanup ? (
                      <small>清理：{cleanup.presentation.statusLabel}</small>
                    ) : null}
                    {cleanup && cleanupInteraction ? (
                      <CleanupInteractionPanel
                        cleanupVersion={cleanup.version}
                        interaction={cleanupInteraction}
                        onResolve={onResolveCleanupInteraction}
                        pending={updating}
                      />
                    ) : null}
                    {cleanup?.availableActions.includes('RETRY_CLEANUP') ? (
                      <button
                        disabled={updating}
                        onClick={() =>
                          onRetryCleanup(cleanup.id, cleanup.version)
                        }
                        type="button"
                      >
                        重试清理
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canSave ? (
        <form
          className="collab-form"
          id="collab-submission-details-form"
          onSubmit={(event) => {
            event.preventDefault();
            updateDetails(
              title,
              requirementDescription,
              editableTargetBranches.map((item) => ({
                submissionItemId: item.id,
                targetBranch: targetBranches[item.id] ?? item.targetBranch,
              })),
            );
          }}
        >
          {editable ? (
            <>
              <label>
                <span>提测标题</span>
                <input
                  maxLength={160}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  value={title}
                />
              </label>
              <label>
                <span>需求说明</span>
                <textarea
                  maxLength={8_000}
                  onChange={(event) =>
                    setRequirementDescription(event.target.value)
                  }
                  required
                  rows={4}
                  value={requirementDescription}
                />
              </label>
            </>
          ) : (
            <small>可以修改自己负责且尚未登记缺陷的目标分支。</small>
          )}
          <button
            disabled={updating || (!detailsChanged && !targetBranchesChanged)}
            type="submit"
          >
            {updating ? '正在保存…' : '保存提测信息'}
          </button>
        </form>
      ) : null}
    </header>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value));
}
