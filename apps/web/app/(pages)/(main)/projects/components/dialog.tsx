import Link from 'next/link';

export function Dialog({
  children,
  className = 'project-engineering-create',
  closeHref,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  closeHref: string;
  title: string;
}) {
  return (
    <section
      aria-label={title}
      className={`project-inline-settings ${className}`}
    >
      <header className="project-inline-settings__heading">
        <h3>{title}</h3>
        <Link
          aria-label={`收起${title}`}
          className="project-inline-settings__close"
          href={closeHref}
          replace
          scroll={false}
        >
          收起
        </Link>
      </header>
      {children}
    </section>
  );
}
