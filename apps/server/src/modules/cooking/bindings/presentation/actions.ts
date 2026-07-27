'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireCurrentUser } from '@/platform/auth/server';
import { publicError } from '@/platform/errors';
import { bindingService } from '@/modules/cooking/application/server';
import {
  messageRedirectPath,
  rethrowRedirectError,
} from '@/platform/http/message-redirect';

export async function createEngineeringBindingAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const engineeringId = field(formData, 'engineeringId');
  const projectId = field(formData, 'projectId');
  try {
    bindingService().createBinding(
      user.id,
      engineeringId,
      field(formData, 'runnerId'),
      field(formData, 'mutationId'),
    );
    revalidatePath('/cooking/projects');
    redirect(
      messageRedirectPath(
        settingsPath(projectId, engineeringId),
        'success',
        '工程绑定已创建，请在本机 Runner 中登记路径',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirect(
      messageRedirectPath(
        settingsPath(projectId, engineeringId),
        'error',
        publicError(error).message,
      ),
    );
  }
}

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '');
}

function settingsPath(projectId: string, engineeringId: string): string {
  return `/cooking/projects?project=${encodeURIComponent(projectId)}&panel=engineering&engineering=${encodeURIComponent(engineeringId)}`;
}
