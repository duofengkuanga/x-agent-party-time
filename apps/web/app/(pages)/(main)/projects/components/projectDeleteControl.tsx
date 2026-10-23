'use client';

import { useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { Project } from '../../../../../contracts/projects/project';
import { deleteProjectAction } from '../../../../actions/projects/projects';

export function ProjectDeleteControl({
  mutationId,
  project,
}: {
  mutationId: string;
  project: Project;
}) {
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <section className="project-delete-control" aria-label="删除项目">
      <h3>删除项目</h3>
      <p>永久删除项目及其成员、邀请、工程、绑定和全部提测记录，无法恢复。</p>
      <p>删除前需关闭所有活动提测单，并完成本机任务与善后。</p>
      {confirming ? (
        <form action={deleteProjectAction} className="project-delete-form">
          <input name="projectId" type="hidden" value={project.id} />
          <input name="mutationId" type="hidden" value={mutationId} />
          <input name="expectedVersion" type="hidden" value={project.version} />
          <ProjectDeleteConfirmation
            name={project.name}
            onCancel={() => {
              setConfirming(false);
              window.requestAnimationFrame(() => trigger.current?.focus());
            }}
          />
        </form>
      ) : (
        <button
          ref={trigger}
          aria-expanded={false}
          onClick={() => setConfirming(true)}
          type="button"
        >
          删除项目
        </button>
      )}
    </section>
  );
}

function ProjectDeleteConfirmation({
  name,
  onCancel,
}: {
  name: string;
  onCancel: () => void;
}) {
  const [confirmationName, setConfirmationName] = useState('');
  const { pending } = useFormStatus();
  return (
    <div className="project-delete-confirmation" aria-busy={pending}>
      <label>
        <span>输入项目名称“{name}”以确认删除</span>
        <input
          autoComplete="off"
          autoFocus
          disabled={pending}
          maxLength={120}
          name="confirmationName"
          onChange={(event) => setConfirmationName(event.target.value)}
          required
          value={confirmationName}
        />
      </label>
      {pending ? <p role="status">正在删除项目…</p> : null}
      <div className="dialog-actions" role="group" aria-label="确认删除项目">
        <button disabled={pending} onClick={onCancel} type="button">
          取消删除
        </button>
        <button
          disabled={pending || confirmationName.trim() !== name}
          type="submit"
        >
          {pending ? '正在删除…' : '确认删除项目'}
        </button>
      </div>
    </div>
  );
}
