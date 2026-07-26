import { logoutAction } from '@/app/logout/action';
import { requireCurrentUser } from '@/platform/auth/server';

export default async function CookingPlaceholderPage() {
  const user = await requireCurrentUser();
  return (
    <main className="placeholder-page">
      <header>
        <div>
          <span className="eyebrow">协作提测</span>
          <h1>协作提测工作台</h1>
        </div>
        <form action={logoutAction}>
          <button type="submit">退出登录</button>
        </form>
      </header>
      <section className="placeholder-card">
        <p>你好，{user.displayName}。</p>
        <h2>新的协作提测工作台正在按绿色重建规格实现</h2>
        <p>
          当前服务端、SQLite 用户与会话已启用。项目、工程、提测单和缺陷
          将由后续纵向任务接入。
        </p>
      </section>
    </main>
  );
}
