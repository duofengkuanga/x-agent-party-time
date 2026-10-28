import type { Project } from '../../../../../contracts/projects/project';
import { deleteProjectAction } from '../../../../actions/projects/projects';
import { ActionPopconfirm } from '../../components/actionPopconfirm';

export function ProjectDeleteControl({
  mutationId,
  project,
}: {
  mutationId: string;
  project: Project;
}) {
  return (
    <ActionPopconfirm
      action={deleteProjectAction}
      className="project-delete-control"
      confirmLabel="确认删除"
      label="删除项目"
      pendingLabel="正在删除…"
      title={`删除“${project.name}”？`}
      description="永久删除项目、成员、工程、绑定和全部提测记录，无法恢复。"
      successPath="/projects?success=项目已删除"
    >
      <input name="projectId" type="hidden" value={project.id} />
      <input name="mutationId" type="hidden" value={mutationId} />
      <input name="expectedVersion" type="hidden" value={project.version} />
      <input name="confirmationName" type="hidden" value={project.name} />
    </ActionPopconfirm>
  );
}
