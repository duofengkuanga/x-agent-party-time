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
  try {
    bindingService().createBinding(
      user.id,
      engineeringId,
      field(formData, 'runnerId'),
      field(formData, 'mutationId'),
    );
    revalidatePath(`/cooking/engineering/${engineeringId}`);
    redirect(
      messageRedirectPath(
        `/cooking/engineering/${engineeringId}`,
        'success',
        '工程绑定已创建，请在本机 Runner 中登记路径',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirect(
      messageRedirectPath(
        `/cooking/engineering/${encodeURIComponent(engineeringId)}`,
        'error',
        publicError(error).message,
      ),
    );
  }
}

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '');
}
