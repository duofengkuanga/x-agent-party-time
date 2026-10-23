'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireCurrentUser } from '@/app/auth';
import { publicError } from '@/server/platform/errors/index';
import {
  messageRedirectPath,
  rethrowRedirectError,
} from '@/server/platform/http/messageRedirect';
import { runnerService } from '../../server/runtime/runner';

export async function revokeRunnerAction(formData: FormData): Promise<never> {
  return changeRunnerState(formData, 'revoke');
}

export async function reactivateRunnerAction(formData: FormData): Promise<never> {
  return changeRunnerState(formData, 'reactivate');
}

async function changeRunnerState(
  formData: FormData,
  action: 'revoke' | 'reactivate',
): Promise<never> {
  const user = await requireCurrentUser();
  try {
    if (action === 'revoke' && formData.get('confirmed') !== 'yes')
      redirect(
        messageRedirectPath('/agents', 'error', '请先确认已经了解停用 Agent 的影响'),
      );
    const runners = runnerService();
    const runnerId = String(formData.get('runnerId') ?? '');
    const version = Number(formData.get('expectedVersion'));
    if (action === 'revoke') runners.revokeRunner(user.id, runnerId, version);
    else runners.reactivateRunner(user.id, runnerId, version);
    revalidatePath('/agents');
    redirect(
      messageRedirectPath(
        '/agents',
        'success',
        action === 'revoke' ? 'Agent 已停用' : 'Agent 已重新启用，等待本机重新连接',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirect(messageRedirectPath('/agents', 'error', publicError(error).message));
  }
}
