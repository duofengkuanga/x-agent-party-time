import Link from 'next/link';
import { requireCurrentUser } from '@/platform/auth/server';
import { PairingCodeForm } from '@/platform/runner/pairing-code-form';
import { revokeRunnerAction } from '@/platform/runner/actions';
import { runnerService } from '@/platform/runner/server';

export default async function RunnersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const user = await requireCurrentUser();
  const runners = runnerService().listRunners(user.id);
  const message = await searchParams;
  return (
    <main className="workspace-page">
      <header className="workspace-header">
        <div>
          <Link className="back-link" href="/cooking">
            返回项目工作台
          </Link>
          <span className="eyebrow">本机执行节点</span>
          <h1>Runner 管理</h1>
          <p>Runner 使用独立凭据，不使用你的浏览器会话或登录密码。</p>
        </div>
      </header>

      {message.error ? (
        <p className="notice notice-error">{message.error}</p>
      ) : null}
      {message.success ? (
        <p className="notice notice-success">{message.success}</p>
      ) : null}

      <div className="workspace-grid">
        <section className="panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">我的 Runner</span>
              <h2>连接状态</h2>
            </div>
            <span className="count-badge">{runners.length}</span>
          </div>
          {runners.length ? (
            <ul className="card-list">
              {runners.map(({ runner, online }) => (
                <li className="list-card" key={runner.id}>
                  <div>
                    <h3>{runner.name}</h3>
                    <p>
                      {runner.revokedAt ? '已撤销' : online ? '在线' : '离线'}
                      {' · '}
                      {runner.lastSeenAt
                        ? `最后心跳 ${formatTime(runner.lastSeenAt)}`
                        : '尚未发送心跳'}
                    </p>
                    <small className="logical-id">
                      Runner 标识：{runner.id}
                    </small>
                  </div>
                  <form action={revokeRunnerAction}>
                    <input name="runnerId" type="hidden" value={runner.id} />
                    <input
                      name="expectedVersion"
                      type="hidden"
                      value={runner.version}
                    />
                    <button disabled={Boolean(runner.revokedAt)} type="submit">
                      {runner.revokedAt ? '已撤销' : '撤销 Runner'}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">还没有配对 Runner。</p>
          )}
        </section>

        <aside className="panel compact-panel">
          <span className="eyebrow">安全配对</span>
          <h2>连接本机 Runner</h2>
          <p className="empty-state">
            配对码短时有效且只能使用一次。长期凭据只返回给本机 Runner。
          </p>
          <PairingCodeForm />
        </aside>
      </div>
    </main>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
}
