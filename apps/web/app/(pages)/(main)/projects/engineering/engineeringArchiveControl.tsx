import type { Engineering } from '@/contracts/projects/engineering';
import { archiveEngineeringAction } from '@/app/actions/projects/engineering';
import { ActionPopconfirm } from '../../components/actionPopconfirm';

export function EngineeringArchiveControl({
  engineering,
  mutationId,
}: {
  engineering: Engineering;
  mutationId: string;
}) {
  if (engineering.archivedAt)
    return (
      <button className="engineering-archive-trigger" disabled type="button">
        已归档
      </button>
    );
  return (
    <ActionPopconfirm
      action={archiveEngineeringAction}
      className="engineering-archive-control"
      confirmLabel="确认归档"
      description="归档后停止使用此工程，保留配置和历史提测记录。活动提测中的工程不能归档。"
      label="归档工程"
      pendingLabel="正在归档…"
      title={`归档“${engineering.name}”？`}
      triggerClassName="engineering-archive-trigger"
    >
      <input name="engineeringId" type="hidden" value={engineering.id} />
      <input name="projectId" type="hidden" value={engineering.projectId} />
      <input name="expectedVersion" type="hidden" value={engineering.version} />
      <input name="mutationId" type="hidden" value={mutationId} />
    </ActionPopconfirm>
  );
}
