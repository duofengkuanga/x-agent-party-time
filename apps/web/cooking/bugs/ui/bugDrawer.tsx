'use client';

import { useState } from 'react';
import type {
  BugFormDraft,
  BugOwnershipDraft,
  BugRegistration,
} from './bugFormDraft';
import type { CookingWorkspaceSnapshot } from '@/cooking/submissions/workspace';
import type { Drawer } from './boardModel';
import { drawerTitle, bugLabel } from './boardModel';

import { UpdateBatchDetails } from './updateDetails';
import { BugDetail } from './bugDetail';
import { BugForm } from './bugEditor';
import { BugDeleteControl } from './bugDeleteControl';
import { TesterBugDetail, type RunTesterAction } from './testerBugDetail';
import { linkedReviewPairFor } from './testerDetailModel';

export function BugDrawer({
  drawer,
  error,
  onChanged,
  onClose,
  onEdit,
  onOpen,
  onOpenBatch,
  onClearError,
  run,
  pending,
  snapshot,
  savedDraft,
  preferredOwnership,
  onDraftChange,
}: {
  drawer: Drawer;
  error: string | null;
  onChanged: (
    revision: number,
    message: string,
    registration?: BugRegistration,
  ) => void;
  onClose: () => void;
  onEdit: (bugId: string) => void;
  onOpen: (bugId: string) => void;
  onOpenBatch: (batchId: string) => void;
  onClearError: () => void;
  run: RunTesterAction;
  pending: boolean;
  snapshot: CookingWorkspaceSnapshot;
  savedDraft: BugFormDraft | null;
  preferredOwnership: BugOwnershipDraft | null;
  onDraftChange: (draft: BugFormDraft) => void;
}) {
  const [formSaving, setFormSaving] = useState(false);
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
  const pair =
    summaryOnly && bug ? linkedReviewPairFor(bug, snapshot.bugs) : null;
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
        className={`collab-dialog collab-bug-drawer${drawer.mode === 'view' ? (summaryOnly ? ' collab-bug-drawer--tester' : ' collab-bug-drawer--developer') : drawer.mode === 'batch' ? ' collab-bug-drawer--developer' : ''}`}
        role="dialog"
      >
        <header className={viewing ? 'collab-bug-drawer__chrome' : undefined}>
          {drawer.mode === 'view' && bug ? (
            <div className="collab-bug-drawer__heading">
              <h2>{bug.report.title}</h2>
              {summaryOnly ? (
                <div className="collab-tester-detail__meta">
                  {pair?.ready ? (
                    <span>前端＋后端 · 同一问题</span>
                  ) : (
                    <span>{bugLabel(bug)}</span>
                  )}
                  {!pair?.ready && bug.assignment ? (
                    <>
                      <span>
                        {bug.assignment.engineeringType === 'FRONTEND'
                          ? '前端'
                          : '后端'}{' '}
                        · {bug.assignment.engineeringName}
                      </span>
                      <span>
                        负责人：{bug.assignment.responsibleUser.displayName}
                      </span>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : viewing ? (
            <div className="collab-bug-drawer__heading">
              <h2>{batch!.engineeringName} · 统一更新</h2>
            </div>
          ) : (
            <div>
              <small>{bug ? bugLabel(bug) : '新缺陷'}</small>
              <h2>{drawerTitle(drawer.mode, bug)}</h2>
            </div>
          )}
          <div className="collab-bug-drawer__chrome-actions">
            <button
              aria-label="关闭详情抽屉"
              disabled={pending || formSaving}
              onClick={onClose}
              type="button"
            >
              ×
            </button>
          </div>
        </header>
        {drawer.mode === 'view' && bug ? (
          <BugDeleteControl
            key={`delete-${bug.id}`}
            bug={bug}
            error={error}
            pending={pending}
            run={run}
            onClearError={onClearError}
            onDeleted={onClose}
          />
        ) : null}
        {drawer.mode === 'batch' ? (
          <UpdateBatchDetails
            batch={batch!}
            onChanged={onChanged}
            onOpen={onOpen}
          />
        ) : drawer.mode === 'view' && summaryOnly ? (
          <TesterBugDetail
            key={bug!.id}
            bug={bug!}
            error={error}
            onClearError={onClearError}
            onEdit={() => onEdit(bug!.id)}
            onOpen={onOpen}
            pending={pending}
            run={run}
            snapshot={snapshot}
          />
        ) : drawer.mode === 'view' ? (
          <BugDetail
            key={bug!.id}
            bug={bug!}
            onOpen={onOpen}
            onChanged={onChanged}
            onOpenBatch={onOpenBatch}
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
            key={bug?.id ?? 'create'}
            bug={bug}
            onCancel={onClose}
            onChanged={onChanged}
            snapshot={snapshot}
            savedDraft={savedDraft}
            preferredOwnership={preferredOwnership}
            onDraftChange={onDraftChange}
            onSavingChange={setFormSaving}
          />
        )}
      </section>
    </div>
  );
}
