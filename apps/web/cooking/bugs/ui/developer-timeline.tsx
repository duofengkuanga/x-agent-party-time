import type { BugView } from '../contract';
import type { CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import type { DeveloperTimelineEntry } from './developer-detail-model';
import {
  RepairAttemptDetails,
  type RunWorkspaceAction,
} from './repair-timeline';
import { ExternalUpdateReport, UpdateAttemptDetails } from './update-details';
import { ProgressAttachments } from './progress-timeline';
import { formatDateTime } from './board-model';

export function DeveloperTimeline({
  entries,
  bug,
  snapshot,
  pending,
  run,
  onOpenBatch,
}: {
  entries: DeveloperTimelineEntry[];
  bug: BugView;
  snapshot: CookingWorkspaceSnapshot;
  pending: boolean;
  run: RunWorkspaceAction;
  onOpenBatch: (batchId: string) => void;
}) {
  const current = entries.find(
    (entry) => entry.kind === 'repair' || entry.kind === 'update',
  );
  const latestRepair = entries.find((entry) => entry.kind === 'repair');
  const latestUpdate = entries.find((entry) => entry.kind === 'update');
  return (
    <ol className="collab-developer-timeline" aria-label="修复与更新记录">
      {entries.map((entry) => (
        <li key={entry.id}>
          {entry.kind === 'repair' ? (
            <RepairAttemptDetails
              bug={bug}
              node={entry.node}
              repair={snapshot.repairByBug[bug.id] ?? null}
              latest={entry.id === latestRepair?.id}
              current={entry.id === current?.id}
              pending={pending}
              run={run}
              currentSessionId={
                latestRepair?.kind === 'repair'
                  ? latestRepair.node.sessionId
                  : null
              }
            />
          ) : entry.kind === 'update' ? (
            <UpdateAttemptDetails
              batch={entry.batch}
              node={entry.node}
              round={entry.round}
              latest={
                entry.batch.timeline
                  .filter((node) => node.kind === 'UPDATE_ATTEMPT')
                  .at(-1)?.id === entry.id
              }
              current={entry.id === current?.id}
              pending={pending}
              run={run}
              onOpenBatch={onOpenBatch}
              currentSessionId={
                latestUpdate?.kind === 'update'
                  ? latestUpdate.node.sessionId
                  : null
              }
            />
          ) : entry.kind === 'report' ? (
            <ExternalUpdateReport node={entry.node} />
          ) : (
            <section className="collab-developer-event">
              <header>
                <strong>
                  {entry.node.kind === 'BUG_REGISTERED'
                    ? '缺陷已登记'
                    : entry.node.kind === 'VERIFICATION'
                      ? entry.node.result === 'PASSED'
                        ? '测试验收通过'
                        : '测试反馈：还有问题'
                      : entry.node.kind === 'REOPEN'
                        ? '测试重新打开缺陷'
                        : entry.node.kind === 'CANCELLED'
                          ? '缺陷已关闭'
                          : '缺陷已恢复'}
                </strong>
                <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
              </header>
              {entry.node.kind === 'VERIFICATION' ||
              entry.node.kind === 'REOPEN' ? (
                <>
                  <p>
                    {entry.node.kind === 'VERIFICATION'
                      ? entry.node.comment
                      : entry.node.feedback}
                  </p>
                  <ProgressAttachments attachments={entry.node.attachments} />
                </>
              ) : null}
            </section>
          )}
        </li>
      ))}
    </ol>
  );
}
