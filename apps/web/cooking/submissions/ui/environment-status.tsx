'use client';

import { useState } from 'react';
import type { SubmissionItemView } from '../contract';
import { changeSubmissionEnvironmentAction } from '../server/actions';
import { createClientId } from '@/cooking/shared/ui/client-id';
import {
  EnvironmentConfirmation,
  EnvironmentConflicts,
} from './environment-confirmation';

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
      setError(error instanceof Error ? error.message : '操作失败，请稍后重试');
    } finally {
      setPending(false);
      setConfirm(false);
      setConfirmDeployment(false);
    }
  }
  if (access.owned && access.deploymentConfirmed) return null;
  return (
    <section
      className="collab-environment-notice"
      aria-label={`${item.engineering.name}环境使用情况`}
    >
      <h3>
        {item.engineering.name}：
        {access.owned ? '等待确认部署' : '已暂停使用环境'}
      </h3>
      <p>
        {access.owned
          ? '请工程负责人确认当前提测版本已部署，再进行测试验证。取得使用权不会自动更换环境中的代码。'
          : '缺陷与进度已保留，更新和测试验证已暂停。重新取得环境并确认部署后可继续。'}
      </p>
      {access.conflict ? (
        <EnvironmentConflicts conflicts={[access.conflict]} />
      ) : null}
      {error ? (
        <p className="collab-form__error" role="alert">
          {error}
        </p>
      ) : null}
      {access.canAcquire ? (
        <button
          type="button"
          disabled={pending || Boolean(access.conflict?.blockedReason)}
          onClick={() => setConfirm(true)}
        >
          重新取得环境
        </button>
      ) : null}
      {access.canConfirmDeployment ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirmDeployment(true)}
        >
          确认当前版本已部署
        </button>
      ) : null}
      {confirmDeployment ? (
        <div
          className="collab-environment-confirm-deployment"
          role="group"
          aria-label="确认部署"
        >
          <p>
            请确认「{item.environment.name}」已经部署本提测单的「
            {item.targetBranch}」版本。确认后将允许测试负责人提交验证结果。
          </p>
          <div className="collab-dialog__actions">
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirmDeployment(false)}
            >
              返回
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => void change('CONFIRM_DEPLOYMENT')}
            >
              {pending ? '正在确认…' : '已核对，确认部署'}
            </button>
          </div>
        </div>
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
