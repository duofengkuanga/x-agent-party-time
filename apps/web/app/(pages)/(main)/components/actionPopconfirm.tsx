'use client';

import { useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import type { InteractiveActionResult } from '@/app/actions/actionTransport';
import { Popconfirm, type PopconfirmProps } from './popconfirm';

export function ActionPopconfirm({
  action,
  children,
  className,
  confirmLabel,
  description,
  label,
  pendingLabel,
  successPath,
  title,
  triggerClassName,
}: {
  action: (data: FormData) => Promise<InteractiveActionResult<unknown>>;
  children: ReactNode;
  className: string;
  confirmLabel: string;
  description: string;
  label: string;
  pendingLabel: string;
  successPath?: string;
  title: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <form
      action={async (data) => {
        setError(null);
        try {
          const result = await action(data);
          if (!result.ok) {
            setError(result.error.message);
            setOpen(true);
            return;
          }
          setOpen(false);
          if (successPath) router.replace(successPath);
          else router.refresh();
        } catch {
          setError('操作未完成，请检查连接后重试。');
          setOpen(true);
        }
      }}
      className={className}
    >
      {children}
      <FormConfirmation
        confirmLabel={confirmLabel}
        description={description}
        error={error}
        label={label}
        pendingLabel={pendingLabel}
        open={open}
        onOpenChange={setOpen}
        title={title}
        triggerClassName={triggerClassName}
      />
    </form>
  );
}

function FormConfirmation(
  props: Omit<PopconfirmProps, 'submit' | 'onConfirm' | 'pending'>,
) {
  const { pending } = useFormStatus();
  return <Popconfirm {...props} pending={pending} submit />;
}
