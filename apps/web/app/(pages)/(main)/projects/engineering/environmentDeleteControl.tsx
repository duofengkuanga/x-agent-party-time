import { deleteEnvironmentAction } from '@/app/actions/projects/engineering';
import { ActionPopconfirm } from '../../components/actionPopconfirm';

export function EnvironmentDeleteControl({
  engineeringId,
  environmentId,
  environmentName,
  expectedVersion,
  mutationId,
  projectId,
}: {
  engineeringId: string;
  environmentId: string;
  environmentName: string;
  expectedVersion: number;
  mutationId: string;
  projectId: string;
}) {
  return (
    <ActionPopconfirm
      action={deleteEnvironmentAction}
      className="environment-direct-delete"
      confirmLabel="确认删除"
      description="删除后无法恢复。已用于提测的环境不能删除。"
      label="删除环境"
      pendingLabel="正在删除…"
      title={`删除“${environmentName}”？`}
    >
      <input name="engineeringId" type="hidden" value={engineeringId} />
      <input name="environmentId" type="hidden" value={environmentId} />
      <input name="expectedVersion" type="hidden" value={expectedVersion} />
      <input name="mutationId" type="hidden" value={mutationId} />
      <input name="projectId" type="hidden" value={projectId} />
    </ActionPopconfirm>
  );
}
