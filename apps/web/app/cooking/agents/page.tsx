import type { Metadata } from 'next';
import Link from 'next/link';
import { requireCurrentUser } from '@/server/auth/server';
import { executionService } from '@/server/execution/server';
import { PairingCodeForm } from '@/server/runner/pairing-code-form';
import { runnerService } from '@/server/runner/server';
import { bindingService } from '@/features/cooking/application/server';
import { AgentRevokeForm } from './agent-revoke-form';

export const metadata: Metadata = {
  title: 'Agent 管理 — Agent Party Time',
  description: '查看本机 Agent 的连接状态和工程绑定。',
};

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const user = await requireCurrentUser();
  const executions = executionService();
  const bindings = bindingService();
  const agents = runnerService()
    .listRunners(user.id)
    .map((status) => ({
      ...status,
      activity: executions.activityForRunner(status.runner.id),
      bindingCount: bindings.listBindingsForRunner(status.runner.id).length,
    }));
  const message = await searchParams;
  return (
    <main className="agent-settings">
      <header className="agent-settings__hero">
        <Link className="agent-settings__back" href="/cooking">
          ← 返回工作台
        </Link>
        <span>本机协作能力</span>
        <h1>Agent 管理</h1>
        <p>查看连接状态和工程绑定。运行细节与停用操作只在需要时展开。</p>
      </header>

      {message.error ? (
        <p className="agent-settings__notice agent-settings__notice--error">
          {message.error}
        </p>
      ) : null}
      {message.success ? (
        <p className="agent-settings__notice agent-settings__notice--success">
          {message.success}
        </p>
      ) : null}

      <section aria-labelledby="agent-list-title" className="agent-ledger">
        <header className="agent-ledger__heading">
          <div>
            <span>我的 Agent</span>
            <h2 id="agent-list-title">连接台账</h2>
          </div>
          <b>{agents.length}</b>
        </header>

        {agents.length ? (
          <>
            <ol className="agent-list">
              {agents.map(
                ({ runner, online, activity, bindingCount }, index) => {
                  const needsAttention = activity.waitingInteractionCount > 0;
                  const state = runner.revokedAt
                    ? '已停用'
                    : online
                      ? '在线'
                      : '离线';
                  return (
                    <li className="agent-row" key={runner.id}>
                      <article>
                        <header className="agent-row__identity">
                          <span>{String(index + 1).padStart(2, '0')}</span>
                          <div>
                            <h3>{runner.name}</h3>
                            <p data-state={state}>{state}</p>
                          </div>
                        </header>

                        <dl className="agent-row__summary">
                          <div>
                            <dt>最近连接</dt>
                            <dd>
                              {runner.lastSeenAt
                                ? formatTime(runner.lastSeenAt)
                                : '尚未连接'}
                            </dd>
                          </div>
                          <div>
                            <dt>绑定工程</dt>
                            <dd>{bindingCount} 个</dd>
                          </div>
                          <div>
                            <dt>需要处理</dt>
                            <dd
                              className={
                                needsAttention
                                  ? 'agent-row__attention'
                                  : undefined
                              }
                            >
                              {needsAttention ? '有待处理事项' : '暂无'}
                            </dd>
                          </div>
                        </dl>

                        <details className="agent-row__details">
                          <summary>运行与管理详情</summary>
                          <div className="agent-row__details-body">
                            <dl>
                              <div>
                                <dt>活动执行</dt>
                                <dd>{activity.activeExecutionCount} 个</dd>
                              </div>
                              <div>
                                <dt>待处理交互</dt>
                                <dd>{activity.waitingInteractionCount} 个</dd>
                              </div>
                              <div>
                                <dt>首次连接</dt>
                                <dd>{formatTime(runner.createdAt)}</dd>
                              </div>
                            </dl>
                            <AgentRevokeForm
                              disabled={Boolean(runner.revokedAt)}
                              expectedVersion={runner.version}
                              runnerId={runner.id}
                            />
                          </div>
                        </details>
                      </article>
                    </li>
                  );
                },
              )}
            </ol>

            <details className="agent-connect">
              <summary>连接另一台 Agent</summary>
              <div>
                <p>连接码短时有效且只能使用一次，长期凭据只保存在本机。</p>
                <PairingCodeForm />
              </div>
            </details>
          </>
        ) : (
          <div className="agent-empty">
            <span>暂无 Agent</span>
            <h2>连接第一台本机 Agent。</h2>
            <p>生成一次性连接码，在本机完成首次连接。</p>
            <PairingCodeForm />
          </div>
        )}
      </section>
    </main>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
}
