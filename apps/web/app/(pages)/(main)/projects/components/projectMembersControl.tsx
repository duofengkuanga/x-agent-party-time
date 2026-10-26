'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { ProjectRouteFeedback } from './engineeringTabs';

export function ProjectMembersControl({
  children,
  count,
  projectName,
}: {
  children: ReactNode;
  count: number;
  projectName: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="project-members-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          dialog.current?.showModal();
          setOpen(true);
          title.current?.focus();
        }}
        ref={trigger}
        type="button"
      >
        项目成员 <span>{count}</span>
      </button>
      <dialog
        aria-labelledby={titleId}
        className="project-members-modal"
        ref={dialog}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            event.currentTarget.close();
        }}
      >
        <header>
          <div>
            <p>{projectName}</p>
            <h2 id={titleId} ref={title} tabIndex={-1}>
              项目成员 <small>{count}</small>
            </h2>
          </div>
          <button
            aria-label="关闭项目成员"
            onClick={() => dialog.current?.close()}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="project-members-modal__body">
          <ProjectRouteFeedback />
          {children}
        </div>
      </dialog>
    </>
  );
}
