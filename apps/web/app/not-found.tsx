import Link from 'next/link';

export default function NotFoundPage() {
  return (
    <main className="placeholder-page">
      <section className="placeholder-card">
        <span className="eyebrow">未找到页面</span>
        <h1>页面不存在或你无权访问</h1>
        <p>为了保护私密项目，这里不会说明资源是否真实存在。</p>
        <Link className="button-link" href="/cooking">
          返回项目工作台
        </Link>
      </section>
    </main>
  );
}
