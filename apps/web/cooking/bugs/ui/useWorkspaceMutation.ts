'use client';

import { useState, useTransition } from 'react';
import { type WorkspaceActionResult } from './boardModel';
import { messageOf } from '@/cooking/shared/ui/actionError';

export function useWorkspaceMutation<Notice extends string | null>(
  onChanged: (revision: number, message: Notice) => void,
) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  function run(
    command: () => Promise<WorkspaceActionResult>,
    message: Notice,
    onSuccess?: (result: WorkspaceActionResult) => void,
  ): void {
    startTransition(async () => {
      try {
        const result = await command();
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setError(null);
        onSuccess?.(result);
        onChanged(result.result.revision, message);
      } catch (error) {
        setError(messageOf(error, '操作失败，请稍后重试。'));
      }
    });
  }
  return { error, setError, pending, run };
}
