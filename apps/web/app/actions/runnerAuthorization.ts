'use server';

import { redirect } from 'next/navigation';
import { requireCurrentUser } from '@/app/auth';
import { publicError } from '@/server/platform/errors/index';
import {
  messageRedirectPath,
  rethrowRedirectError,
} from '@/server/platform/http/messageRedirect';
import { runnerService } from '@/server/runtime/runner';

export async function approveAgentAuthorizationAction(
  formData: FormData,
): Promise<never> {
  return authorizationDecision(formData, 'approve');
}

export async function rejectAgentAuthorizationAction(formData: FormData): Promise<never> {
  return authorizationDecision(formData, 'reject');
}

async function authorizationDecision(
  formData: FormData,
  decision: 'approve' | 'reject',
): Promise<never> {
  const user = await requireCurrentUser();
  const requestId = field(formData, 'requestId');
  try {
    const runners = runnerService();
    const approvalToken = field(formData, 'approvalToken');
    if (decision === 'approve')
      runners.approveAuthorization(
        user.id,
        requestId,
        approvalToken,
        field(formData, 'name'),
      );
    else runners.rejectAuthorization(user.id, requestId, approvalToken);
    redirect(
      messageRedirectPath(
        connectPath(requestId),
        'success',
        decision === 'approve' ? 'Agent 已确认，正在建立连接' : '已暂不连接这台 Agent',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirect(
      messageRedirectPath(connectPath(requestId), 'error', publicError(error).message),
    );
  }
}

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '');
}

function connectPath(requestId: string): string {
  return `/agents/connect?request=${encodeURIComponent(requestId)}`;
}
