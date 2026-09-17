'use client';

import type { DragEvent } from 'react';
import type { BugView } from '../contract';
import { bugLabel, formatDateTime } from './board-model';

export type BugStorageKind = 'cancelled' | 'archived';
const storage = {
  cancelled: {
    title: '已取消缺陷',
    state: '已取消',
    verb: '取消',
    action: 'CANCEL',
    glyph: '🗑',
  },
  archived: {
    title: '归档缺陷',
    state: '已归档',
    verb: '归档',
    action: 'ARCHIVE',
    glyph: '🗄',
  },
} as const;

export function BugStorageButton({
  kind,
  count,
  draggingBug,
  active,
  setActive,
  draggedBugFrom,
  clearDraggingBug,
  onOpen,
  onStore,
}: {
  kind: BugStorageKind;
  count: number;
  draggingBug: BugView | undefined;
  active: boolean;
  setActive: (active: boolean) => void;
  draggedBugFrom: (event: DragEvent<HTMLElement>) => BugView | undefined;
  clearDraggingBug: () => void;
  onOpen: () => void;
  onStore: (bug: BugView) => void;
}) {
  const info = storage[kind];
  const eligible = draggingBug?.availableActions.includes(info.action) ?? false;
  function accepts(event: DragEvent<HTMLElement>) {
    const bug = draggedBugFrom(event);
    return bug?.availableActions.includes(info.action) ? bug : undefined;
  }
  return (
    <button
      aria-label={
        eligible && draggingBug
          ? `拖到这里${info.verb} ${bugLabel(draggingBug)}，当前共 ${count} 条${info.title}`
          : `查看${info.title}，共 ${count} 条`
      }
      className={`collab-storage-button collab-storage-button--icon collab-storage-button--${kind}${eligible ? ' is-active' : ''}`}
      data-drop-eligible={eligible ? 'true' : undefined}
      data-drop-target={active ? 'true' : undefined}
      onClick={onOpen}
      onDragEnter={(event) => {
        if (accepts(event)) setActive(true);
      }}
      onDragLeave={() => setActive(false)}
      onDragOver={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setActive(true);
      }}
      onDrop={(event) => {
        const bug = accepts(event);
        if (!bug) return;
        event.preventDefault();
        clearDraggingBug();
        onStore(bug);
      }}
      title={info.title}
      type="button"
    >
      <span aria-hidden="true" className="collab-storage-button__glyph">
        {info.glyph}
      </span>
      <span aria-hidden="true" className="collab-storage-button__drop-label">
        {active ? `🖐 松开即可${info.verb}` : `拖到这里${info.verb}`}
      </span>
      {count ? <sup aria-hidden="true">{count}</sup> : null}
    </button>
  );
}

export function StoredBugList({
  kind,
  bugs,
  onClose,
  onOpen,
}: {
  kind: BugStorageKind;
  bugs: BugView[];
  onClose: () => void;
  onOpen: (bugId: string) => void;
}) {
  const info = storage[kind];
  return (
    <div
      className="collab-dialog-backdrop collab-drawer-scrim"
      role="presentation"
    >
      <section
        aria-label={info.title}
        aria-modal="true"
        className="collab-dialog collab-bug-drawer"
        role="dialog"
      >
        <header>
          <div>
            {kind === 'archived' ? <small>完成整理</small> : null}
            <h2>{info.title}</h2>
          </div>
          <button
            aria-label={`关闭${info.title}列表`}
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="collab-dialog__body collab-bug-drawer__body">
          {bugs.length ? (
            <ul className="collab-stored-bug-list">
              {bugs.map((bug) => (
                <li key={bug.id}>
                  <button
                    onClick={() => {
                      onClose();
                      onOpen(bug.id);
                    }}
                    type="button"
                  >
                    <strong>
                      {bugLabel(bug)} · {bug.report.title}
                    </strong>
                    <small>
                      {bug.presentation.assignmentLabel} · {info.state}
                    </small>
                    <small>
                      {formatDateTime(
                        kind === 'archived'
                          ? (bug.archivedAt ?? bug.updatedAt)
                          : bug.updatedAt,
                      )}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="collab-bug-detail-empty">暂无{info.title}</p>
          )}
        </div>
      </section>
    </div>
  );
}
