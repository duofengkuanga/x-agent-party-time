'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireCurrentUser } from '@/server/auth/server';
import { publicError } from '@/server/errors';
import {
  messageRedirectPath,
  rethrowRedirectError,
} from '@/server/http/message-redirect';
import { runnerService } from './server';

export type PairingCodeState = {
  code: string | null;
  expiresAt: string | null;
  error: string | null;
};

export async function issueRunnerPairingCodeAction(): Promise<PairingCodeState> {
  const user = await requireCurrentUser();
  try {
    const issue = runnerService().issuePairingCode(user.id);
    return { code: issue.code, expiresAt: issue.expiresAt, error: null };
  } catch (error) {
    return {
      code: null,
      expiresAt: null,
      error: publicError(error).message,
    };
  }
}

export async function revokeRunnerAction(formData: FormData): Promise<never> {
  const user = await requireCurrentUser();
  try {
    if (formData.get('confirmed') !== 'yes')
      redirect(
        messageRedirectPath(
          '/cooking/agents',
          'error',
          '请先确认已经了解停用 Agent 的影响',
        ),
      );
    runnerService().revokeRunner(
      user.id,
      String(formData.get('runnerId') ?? ''),
      Number(formData.get('expectedVersion')),
    );
    revalidatePath('/cooking/agents');
    redirect(messageRedirectPath('/cooking/agents', 'success', 'Agent 已停用'));
  } catch (error) {
    rethrowRedirectError(error);
    redirect(
      messageRedirectPath(
        '/cooking/agents',
        'error',
        publicError(error).message,
      ),
    );
  }
}

export async function reactivateRunnerAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  try {
    runnerService().reactivateRunner(
      user.id,
      String(formData.get('runnerId') ?? ''),
      Number(formData.get('expectedVersion')),
    );
    revalidatePath('/cooking/agents');
    redirect(
      messageRedirectPath(
        '/cooking/agents',
        'success',
        'Agent 已重新启用，等待本机重新连接',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirect(
      messageRedirectPath(
        '/cooking/agents',
        'error',
        publicError(error).message,
      ),
    );
  }
}
