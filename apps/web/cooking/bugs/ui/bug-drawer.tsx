'use client';

import type { CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import type { Drawer } from './board-model';
import { drawerTitle, bugLabel } from './board-model';

import { UpdateBatchDetails } from './update-details';
import { BugDetail } from './bug-detail';
import { BugForm } from './bug-editor';

export function BugDrawer({
  drawer,
  onChanged,
  onClose,
  onEdit,
  snapshot,
}: {
  drawer: Drawer;
  onChanged: (revision: number, message: string) => void;
  onClose: () => void;
  onEdit: (bugId: string) => void;
  snapshot: CookingWorkspaceSnapshot;
}) {
  const bug =
    drawer.mode === 'create' || drawer.mode === 'batch'
      ? null
      : (snapshot.bugs.find(({ id }) => id === drawer.bugId) ?? null);
  const batch =
    drawer.mode === 'batch'
      ? (snapshot.updateBatches.find(({ id }) => id === drawer.batchId) ?? null)
      : null;
  const summaryOnly =
    snapshot.submission.submission.testerUserId === snapshot.currentUser.id;
  if (drawer.mode !== 'create' && drawer.mode !== 'batch' && !bug) return null;
  if (drawer.mode === 'batch' && !batch) return null;
  const viewing = drawer.mode === 'view' || drawer.mode === 'batch';
  return (
    <div
      className="collab-dialog-backdrop collab-drawer-scrim"
      role="presentation"
    >
      <section
        aria-label={
          drawer.mode === 'batch'
            ? '统一更新批次详情'
            : drawerTitle(drawer.mode, bug)
        }
        aria-modal="true"
        className="collab-dialog collab-bug-drawer"
        role="dialog"
      >
        <header className={viewing ? 'collab-bug-drawer__chrome' : undefined}>
          {viewing ? (
            <small>
              {drawer.mode === 'batch' ? '统一更新批次详情' : '缺陷详情'}
            </small>
          ) : (
            <div>
              <small>{bug ? bugLabel(bug) : '新缺陷'}</small>
              <h2>{drawerTitle(drawer.mode, bug)}</h2>
            </div>
          )}
          <div className="collab-bug-drawer__chrome-actions">
            <button aria-label="关闭详情抽屉" onClick={onClose} type="button">
              ×
            </button>
          </div>
        </header>
        {drawer.mode === 'batch' ? (
          <UpdateBatchDetails
            batch={batch!}
            onChanged={onChanged}
            summaryOnly={summaryOnly}
          />
        ) : drawer.mode === 'view' ? (
          <BugDetail
            bug={bug!}
            onChanged={onChanged}
            onEdit={
              bug!.availableActions.some((action) =>
                ['EDIT_REPORT', 'ASSIGN'].includes(action),
              )
                ? () => onEdit(bug!.id)
                : null
            }
            snapshot={snapshot}
          />
        ) : (
          <BugForm
            bug={bug}
            onCancel={onClose}
            onChanged={onChanged}
            snapshot={snapshot}
          />
        )}
      </section>
    </div>
  );
}
