'use client';

import type { CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import type { Drawer } from './board-model';
import { drawerTitle, bugLabel } from './board-model';

import { UpdateBatchDetails } from './update-details';
import { BugDetail } from './bug-detail';
import { BugForm } from './bug-editor';
import { BugIdentity } from './bug-identity';

export function BugDrawer({
  drawer,
  error,
  onChanged,
  onClose,
  onEdit,
  onOpen,
  onRequestRework,
  onVerifyPass,
  pending,
  snapshot,
}: {
  drawer: Drawer;
  error: string | null;
  onChanged: (revision: number, message: string) => void;
  onClose: () => void;
  onEdit: (bugId: string) => void;
  onOpen: (bugId: string) => void;
  onRequestRework: (bugId: string) => void;
  onVerifyPass: (bugId: string) => void;
  pending: boolean;
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
        className={`collab-dialog collab-bug-drawer${drawer.mode === 'view' ? ' collab-bug-drawer--split' : ''}`}
        role="dialog"
      >
        <header className={viewing ? 'collab-bug-drawer__chrome' : undefined}>
          {drawer.mode === 'view' && bug ? (
            <div className="collab-bug-drawer__heading">
              <h2>{bug.report.title}</h2>
              <BugIdentity key={bug.id} bugId={bug.id} />
            </div>
          ) : viewing ? (
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
            key={bug!.id}
            bug={bug!}
            onOpen={onOpen}
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
        {drawer.mode === 'view' &&
        bug?.availableActions.some((action) =>
          ['VERIFY_PASS', 'VERIFY_FAIL'].includes(action),
        ) ? (
          <footer
            aria-busy={pending}
            aria-label="缺陷验收"
            className="collab-bug-drawer__verification"
          >
            <div className="collab-bug-drawer__verification-note">
              <strong>{pending ? '正在提交验收结果…' : '确认修复结果'}</strong>
              {error ? (
                <p className="collab-form__error" role="alert">
                  {error}
                </p>
              ) : (
                <p>仍有问题时，补充反馈后继续修复。</p>
              )}
            </div>
            <div className="collab-bug-drawer__verification-buttons">
              {bug.availableActions.includes('VERIFY_PASS') ? (
                <button
                  disabled={pending}
                  onClick={() => onVerifyPass(bug.id)}
                  type="button"
                >
                  通过
                </button>
              ) : null}
              {bug.availableActions.includes('VERIFY_FAIL') ? (
                <button
                  disabled={pending}
                  onClick={() => onRequestRework(bug.id)}
                  type="button"
                >
                  还有问题
                </button>
              ) : null}
            </div>
          </footer>
        ) : null}
      </section>
    </div>
  );
}
