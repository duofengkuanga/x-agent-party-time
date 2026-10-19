'use client';

import { useState } from 'react';

export function DiscardDraft({
  disabled,
  onDiscard,
}: {
  disabled: boolean;
  onDiscard: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm)
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setConfirm(true)}
      >
        放弃草稿
      </button>
    );
  return (
    <div
      className="collab-discard-draft"
      role="group"
      aria-label="确认放弃草稿"
    >
      <span>放弃后将清空本次未保存内容和附件。</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setConfirm(false)}
      >
        继续填写
      </button>
      <button type="button" disabled={disabled} onClick={onDiscard}>
        确认放弃
      </button>
    </div>
  );
}
