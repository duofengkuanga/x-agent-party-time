'use server';

import { PlatformError } from '@/platform/errors';
import {
  bindingRequestService,
  bindingService,
} from '@/cooking/runtime/services';
import {
  formField,
  runRedirectMutation,
} from '@/cooking/shared/server/action-transport';
import { bindingSettingsPath } from '@/cooking/projects/ui/route-state';

export async function createEngineeringBindingAction(
  formData: FormData,
): Promise<never> {
  const projectId = formField(formData, 'projectId');
  const engineeringId = formField(formData, 'engineeringId');
  return runRedirectMutation({
    formData,
    errorPath: () => bindingSettingsPath(projectId, engineeringId),
    command: (userId) => {
      const request = bindingRequestService().createRequest(
        userId,
        engineeringId,
        formField(formData, 'runnerId'),
        formField(formData, 'mutationId'),
      );
      return {
        path: bindingSettingsPath(projectId, engineeringId, request.id),
        message: '已发送到本机 Agent，请选择仓库目录',
        refreshPaths: ['/cooking/projects'],
      };
    },
  });
}

export async function deleteEngineeringBindingAction(
  formData: FormData,
): Promise<never> {
  const projectId = formField(formData, 'projectId');
  const engineeringId = formField(formData, 'engineeringId');
  const path = bindingSettingsPath(projectId, engineeringId);
  return runRedirectMutation({
    formData,
    errorPath: () => path,
    command: (userId) => {
      if (formField(formData, 'confirmed') !== 'yes')
        throw new PlatformError('VALIDATION_FAILED', '请先确认删除影响');
      bindingService().deleteBinding(
        userId,
        formField(formData, 'bindingId'),
        formField(formData, 'mutationId'),
      );
      return {
        path,
        message: '工程绑定已删除',
        refreshPaths: ['/cooking/projects'],
      };
    },
  });
}
