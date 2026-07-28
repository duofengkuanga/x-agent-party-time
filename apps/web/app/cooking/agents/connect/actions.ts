'use server';

import { redirect } from 'next/navigation';
import { requireCurrentUser } from '@/server/auth/server';
import { publicError } from '@/server/errors';
import {
  messageRedirectPath,
  rethrowRedirectError,
} from '@/server/http/message-redirect';
import { runnerService } from '@/server/runner/server';

export async function approveAgentAuthorizationAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const requestId = field(formData, 'requestId');
  try {
    runnerService().approveAuthorization(
      user.id,
      requestId,
      field(formData, 'approvalToken'),
      field(formData, 'name'),
    );
    redirect(
      messageRedirectPath(
        connectPath(requestId),
        'success',
        'Agent 已确认，正在建立连接',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirect(
      messageRedirectPath(
        connectPath(requestId),
        'error',
        publicError(error).message,
      ),
    );
  }
}

export async function rejectAgentAuthorizationAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const requestId = field(formData, 'requestId');
  try {
    runnerService().rejectAuthorization(
      user.id,
      requestId,
      field(formData, 'approvalToken'),
    );
    redirect(
      messageRedirectPath(
        connectPath(requestId),
        'success',
        '已暂不连接这台 Agent',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirect(
      messageRedirectPath(
        connectPath(requestId),
        'error',
        publicError(error).message,
      ),
    );
  }
}

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '');
}

function connectPath(requestId: string): string {
  return `/cooking/agents/connect?request=${encodeURIComponent(requestId)}`;
}
