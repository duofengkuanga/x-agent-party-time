import Link from 'next/link';
import { ProjectDialogEffects } from './project-dialog-effects';

export function Dialog({
  children,
  className = 'engineering-catalog-dialog',
  kicker,
  overlayClassName = 'engineering-catalog-overlay',
  title,
}: {
  children: React.ReactNode;
  className?: string;
  kicker: string;
  overlayClassName?: string;
  title: string;
}) {
  return (
    <div className={`repair-overlay ${overlayClassName}`} role="presentation">
      <ProjectDialogEffects closeHref="/cooking/projects" />
      <section
        aria-labelledby="project-dialog-title"
        aria-modal="true"
        className={`bug-dialog ${className}`}
        role="dialog"
        tabIndex={-1}
      >
        <header className="engineering-dialog__header">
          <div>
            <p className="repair-kicker">{kicker}</p>
            <h2 id="project-dialog-title">{title}</h2>
          </div>
          <Link
            aria-label={`关闭${title}`}
            className="engineering-dialog__close"
            href="/cooking/projects"
            replace
          >
            ×
          </Link>
        </header>
        {children}
      </section>
    </div>
  );
}
