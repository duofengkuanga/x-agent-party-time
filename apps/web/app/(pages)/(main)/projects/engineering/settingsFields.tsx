import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { engineeringSettingsPath } from '../components/routeState';

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
  engineeringId,
  projectId,
}: {
  label: string;
  engineeringId: string;
  projectId: string;
}) {
  return (
    <div className="engineering-task__heading">
      <strong>{label}</strong>
      <Link
        href={engineeringSettingsPath(projectId, engineeringId)}
        replace
        scroll={false}
      >
        取消编辑
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
