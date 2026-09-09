import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { settingsHref } from './settings-links';

export function DialogFeedback({
  error,
  success,
}: {
  error?: string;
  success?: string;
}) {
  if (error)
    return (
      <p
        className="project-dialog__feedback project-dialog__feedback--error"
        role="alert"
      >
        {error}
      </p>
    );
  if (success)
    return (
      <p className="project-dialog__feedback project-dialog__feedback--success">
        {success}
      </p>
    );
  return null;
}

export function EngineeringTaskHeading({
  label,
  name,
  projectId,
  status,
}: {
  label: string;
  name: string;
  projectId: string;
  status?: string;
}) {
  return (
    <div className="engineering-task__heading">
      <div>
        <span>
          {label}
          {status ? ` · ${status}` : ''}
        </span>
        <h3>{name}</h3>
      </div>
      <Link href={settingsHref(projectId, 'engineering')} replace>
        返回目录
      </Link>
    </div>
  );
}

export function ProjectFields({ projectId }: { projectId: string }) {
  return (
    <>
      <input name="mutationId" type="hidden" value={randomUUID()} />
      <input name="projectId" type="hidden" value={projectId} />
    </>
  );
}

export function EngineeringFields({
  engineeringId,
  projectId,
}: {
  engineeringId: string;
  projectId: string;
}) {
  return (
    <>
      <ProjectFields projectId={projectId} />
      <input name="engineeringId" type="hidden" value={engineeringId} />
    </>
  );
}
