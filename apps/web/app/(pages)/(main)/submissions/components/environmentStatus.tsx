'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { SubmissionItemView } from '../../../../../contracts/submissions/submission';
import { changeSubmissionEnvironmentAction } from '../../../../actions/submissions/submissions';
import { createClientId } from '@/app/(pages)/(main)/components/clientId';
import { messageOf } from '@/app/(pages)/(main)/components/actionError';
import { Popconfirm } from '@/app/(pages)/(main)/components/popconfirm';
import { EnvironmentConfirmation } from './environmentConfirmation';

export function EnvironmentStatus({
  item,
  title,
  revision,
  onChanged,
}: {
  item: SubmissionItemView;
  title: string;
  revision: number;
  onChanged: (revision: number) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [confirmDeployment, setConfirmDeployment] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const access = item.environmentAccess;
  async function change(action: 'ACQUIRE' | 'CONFIRM_DEPLOYMENT') {
    setPending(true);
    setError(null);
    try {
      const result = await changeSubmissionEnvironmentAction(item.id, {
        mutationId: createClientId(),
        expectedRevision: revision,
        action,
        ...(action === 'ACQUIRE' && access.conflict
          ? { takeover: access.conflict }
          : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        onChanged(revision);
        return;
      }
      onChanged(result.result.workspaceRevision);
    } catch (error) {
      setError(messageOf(error, '无法更新环境状态。'));
    } finally {
      setPending(false);
      setConfirm(false);
      setConfirmDeployment(false);
    }
  }
  if (access.owned && access.deploymentConfirmed) return null;
  return (
    <section
      className="collab-environment-status"
      aria-label={`${item.engineering.name}环境使用情况`}
      aria-busy={pending}
    >
      <div className="collab-environment-status__row">
        <strong>
          {item.engineering.name} / {item.environment.name}
        </strong>
        <span className="collab-environment-status__state">
          {access.owned ? '等待确认部署' : '已暂停使用环境'}
        </span>
        <span>
          占用方：
          {access.owned ? (
            <span title={title}>本提测单</span>
          ) : access.conflict ? (
            <Link
              href={`/submissions/${access.conflict.submissionId}`}
              target="_blank"
              rel="noreferrer"
            >
              {access.conflict.submissionTitle}
            </Link>
          ) : (
            '无，环境空闲'
          )}
        </span>
        <span className="collab-environment-status__next">
          {access.owned
            ? `待${item.responsibleUser.displayName}确认部署`
            : access.conflict
              ? `待${access.conflict.testerName}或项目所有者交接环境`
              : `待${item.responsibleUser.displayName}取得环境`}
        </span>
        {access.canAcquire || access.canConfirmDeployment ? (
          <div className="collab-environment-status__actions">
            {access.canAcquire ? (
              <button
                type="button"
                disabled={pending || Boolean(access.conflict?.blockedReason)}
                onClick={() => setConfirm(true)}
              >
                {pending ? '正在取得环境…' : '重新取得环境'}
              </button>
            ) : null}
            {access.canConfirmDeployment ? (
              <Popconfirm
                label="确认部署"
                title="确认当前版本已部署？"
                description={`请核对「${item.environment.name}」已部署本提测单的「${item.targetBranch}」版本。此操作不会部署代码，确认后将允许测试验证。`}
                confirmLabel="已核对，确认部署"
                pendingLabel="正在确认…"
                open={confirmDeployment}
                onOpenChange={setConfirmDeployment}
                pending={pending}
                onConfirm={() => void change('CONFIRM_DEPLOYMENT')}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {access.conflict?.blockedReason ? (
        <p className="collab-environment-status__hint" role="status">
          {access.conflict.blockedReason}
        </p>
      ) : null}
      {error ? (
        <p className="collab-form__error" role="alert">
          {error}
        </p>
      ) : null}
      {confirm ? (
        <EnvironmentConfirmation
          title={title}
          conflicts={access.conflict ? [access.conflict] : []}
          pending={pending}
          confirmLabel="确认取得环境"
          onClose={() => setConfirm(false)}
          onConfirm={() => void change('ACQUIRE')}
        />
      ) : null}
    </section>
  );
}
