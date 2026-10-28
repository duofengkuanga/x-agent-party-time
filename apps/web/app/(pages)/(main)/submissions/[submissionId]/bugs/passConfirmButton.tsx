'use client';

import { useState } from 'react';
import { Popconfirm } from '../../../components/popconfirm';

export function PassConfirmButton({
  disabled,
  message,
  onConfirm,
}: {
  disabled: boolean;
  message: string;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="collab-pass-confirm">
      <Popconfirm
        confirmLabel="确认通过"
        disabled={disabled}
        label="通过"
        onConfirm={() => {
          setOpen(false);
          onConfirm();
        }}
        onOpenChange={setOpen}
        open={open}
        pendingLabel="正在提交…"
        presentation="inline"
        title={message}
      />
    </span>
  );
}
