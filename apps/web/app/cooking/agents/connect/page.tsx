import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/server/auth/server';
import { publicError } from '@/server/errors';
import { runnerService } from '@/server/runner/server';
import {
  approveAgentAuthorizationAction,
  rejectAgentAuthorizationAction,
} from './actions';

export const metadata: Metadata = {
  title: '连接 Agent — Agent Party Time',
  description: '确认并连接当前本机 Agent。',
};

export default async function AgentConnectPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    request?: string;
    success?: string;
  }>;
}) {
  const params = await searchParams;
  const requestId = params.request ?? '';
  const returnPath = `/cooking/agents/connect?request=${encodeURIComponent(requestId)}`;
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(returnPath)}`);

  let approval: ReturnType<
    ReturnType<typeof runnerService>['prepareAuthorizationApproval']
  > | null = null;
  let loadError: string | null = null;
  try {
    approval = runnerService().prepareAuthorizationApproval(user.id, requestId);
  } catch (error) {
    loadError = publicError(error).message;
  }

  return (
    <main className="agent-connect">
      <header>
        <span>本机连接请求</span>
        <h1>连接 Agent</h1>
        <p>确认是你刚刚启动的本机 Agent，再建立长期连接。</p>
      </header>

      {params.error || loadError ? (
        <p className="agent-settings__notice agent-settings__notice--error">
          {params.error ?? loadError}
        </p>
      ) : null}
      {params.success ? (
        <p className="agent-settings__notice agent-settings__notice--success">
          {params.success}
        </p>
      ) : null}

      {approval?.state === 'PENDING' && approval.approvalToken ? (
        <section className="agent-connect__request">
          <dl>
            <div>
              <dt>短指纹</dt>
              <dd>{approval.fingerprint}</dd>
            </div>
            <div>
              <dt>请求时间</dt>
              <dd>{formatTime(approval.createdAt)}</dd>
            </div>
            <div>
              <dt>有效期至</dt>
              <dd>{formatTime(approval.expiresAt)}</dd>
            </div>
          </dl>
          <form action={approveAgentAuthorizationAction}>
            <input
              name="approvalToken"
              type="hidden"
              value={approval.approvalToken}
            />
            <input name="requestId" type="hidden" value={approval.requestId} />
            <label>
              <span>Agent 名称</span>
              <input
                defaultValue={approval.suggestedName}
                maxLength={120}
                name="name"
                required
              />
            </label>
            <div className="agent-connect__actions">
              <button formAction={rejectAgentAuthorizationAction} type="submit">
                暂不连接
              </button>
              <button className="repair-primary" type="submit">
                连接 Agent
              </button>
            </div>
          </form>
        </section>
      ) : approval ? (
        <section className="agent-connect__result">
          <strong>{authorizationStateLabel(approval.state)}</strong>
          <p>
            {approval.state === 'CONSUMED'
              ? '这台 Agent 已领取凭据，可以返回 Agent 管理查看连接状态。'
              : approval.state === 'APPROVED'
                ? '浏览器确认已完成，正在等待本机 Agent 建立连接。'
                : '如需连接，请重新启动本机 Agent 发起新的授权。'}
          </p>
          <Link href="/cooking/agents">返回 Agent 管理</Link>
        </section>
      ) : (
        <Link className="agent-connect__back" href="/cooking/agents">
          返回 Agent 管理
        </Link>
      )}
    </main>
  );
}

function authorizationStateLabel(
  state: 'PENDING' | 'APPROVED' | 'CONSUMED' | 'EXPIRED' | 'REJECTED',
): string {
  return {
    APPROVED: '等待 Agent 连接',
    PENDING: '等待确认',
    CONSUMED: 'Agent 已连接',
    EXPIRED: '授权请求已过期',
    REJECTED: '已暂不连接',
  }[state];
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
