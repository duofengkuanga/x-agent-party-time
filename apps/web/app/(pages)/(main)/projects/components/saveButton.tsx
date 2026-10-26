'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

export function SaveButton({
  children,
  className,
  pendingLabel = '正在保存…',
}: {
  children: ReactNode;
  className?: string;
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button className={className} disabled={pending} type="submit">
      {pending ? pendingLabel : children}
    </button>
  );
}
