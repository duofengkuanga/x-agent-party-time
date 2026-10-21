'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import type { EnvironmentConflict } from '../contract';

export function EnvironmentConflicts({
  conflicts,
}: {
  conflicts: EnvironmentConflict[];
}) {
  return (
    <div className="collab-environment-conflicts">
      {conflicts.map((conflict) => (
        <div
          className="collab-environment-conflict"
          key={conflict.environmentId}
        >
          <strong>
            {conflict.engineeringName} / {conflict.environmentName}
          </strong>
          <p>
            正在由{' '}
            <Link
              href={`/cooking/${conflict.submissionId}`}
              target="_blank"
              rel="noreferrer"
            >
              {conflict.submissionTitle}
            </Link>{' '}
            使用
          </p>
          <small>测试负责人：{conflict.testerName}</small>
          {conflict.blockedReason ? (
            <p role="status">{conflict.blockedReason}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function EnvironmentConfirmation({
  title,
  conflicts,
  pending,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  conflicts: EnvironmentConflict[];
  pending: boolean;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    cancelRef.current?.focus();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="collab-environment-dialog"
      aria-labelledby="environment-confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <h2 id="environment-confirm-title">优先使用此环境？</h2>
      <p>同一环境同时只供一张提测单使用。</p>
      <EnvironmentConflicts conflicts={conflicts} />
      <dl className="collab-environment-target">
        <dt>切换给</dt>
        <dd>{title}</dd>
      </dl>
      <p>
        原提测单中使用这些环境的提测项将暂停更新和测试验证，缺陷与进度保留，其他工程不受影响。
      </p>
      <p>
        切换不会自动部署。工程负责人确认当前版本已部署后，才能进行测试验证。
      </p>
      <div className="collab-dialog__actions">
        <button
          type="button"
          disabled={pending}
          onClick={onClose}
          ref={cancelRef}
        >
          返回
        </button>
        <button
          type="button"
          className="collab-primary"
          disabled={pending || conflicts.some((value) => value.blockedReason)}
          onClick={onConfirm}
        >
          {pending ? '正在切换…' : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
