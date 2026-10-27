'use server';

import {
  engineeringService,
  bindingRequestService,
  bindingService,
} from '@/server/runtime/services';
import {
  formField,
  formStringList,
  integerFormField,
  optionalFormField,
  runRedirectMutation,
  runInteractiveMutation,
} from '@/app/actions/actionTransport';
import {
  engineeringCreatePath,
  engineeringSettingsPath,
  bindingSettingsPath,
} from '@/app/(pages)/(main)/projects/components/routeState';
import {
  DeploymentMethodSchema,
  EngineeringTypeSchema,
  type DeploymentMethod,
} from '../../../contracts/projects/engineering';
import { engineeringActionError } from '../../../server/platform/projects/engineering/actionError';

import { PlatformError } from '@/server/platform/errors/index';

const REFRESH_PATHS = ['/submissions', '/projects'];

export async function createEngineeringAction(formData: FormData): Promise<never> {
  const projectId = formField(formData, 'projectId');
  return runEngineeringRedirect(formData, engineeringCreatePath(projectId), (userId) => {
    const engineering = engineeringService().createEngineeringSetup(userId, projectId, {
      mutationId: formField(formData, 'mutationId'),
      name: formField(formData, 'name'),
      type: EngineeringTypeSchema.parse(formField(formData, 'type')),
      identifier: formField(formData, 'identifier'),
      creatorMembershipMutationId: formField(formData, 'creatorMembershipMutationId'),
      members: formStringList(formData, 'memberUserId').map((memberId) => ({
        userId: memberId,
        mutationId: formField(formData, `memberMutationId:${memberId}`),
      })),
      environments: formStringList(formData, 'environmentKey').map((key) => ({
        mutationId: formField(formData, `environmentMutationId:${key}`),
        name: formField(formData, `environmentName:${key}`),
        deployment: deploymentField(formData, key),
        scriptCommand: optionalFormField(formData, `scriptCommand:${key}`),
      })),
    });
    return {
      path: engineeringSettingsPath(projectId, engineering.id),
      message: '工程已加入',
    };
  });
}

export async function updateEngineeringAction(formData: FormData) {
  return runInteractiveMutation({
    validationEvent: 'engineering_autosave_validation_failed',
    command: ({ userId }) => ({
      result: engineeringService().updateEngineering(
        userId,
        formField(formData, 'engineeringId'),
        {
          mutationId: formField(formData, 'mutationId'),
          expectedVersion: integerFormField(formData, 'expectedVersion'),
          name: formField(formData, 'name'),
          type: EngineeringTypeSchema.parse(formField(formData, 'type')),
          identifier: formField(formData, 'identifier'),
        },
      ),
      refreshPaths: REFRESH_PATHS,
    }),
  });
}

export async function archiveEngineeringAction(formData: FormData) {
  return runInteractiveMutation({
    validationEvent: 'engineering_archive_validation_failed',
    command: ({ userId }) => ({
      result: engineeringService().archiveEngineering(
        userId,
        formField(formData, 'engineeringId'),
        {
          mutationId: formField(formData, 'mutationId'),
          expectedVersion: integerFormField(formData, 'expectedVersion'),
        },
      ),
      refreshPaths: REFRESH_PATHS,
    }),
  });
}

export async function addEngineeringMemberAction(formData: FormData) {
  return runInteractiveMutation({
    validationEvent: 'engineering_member_add_validation_failed',
    command: ({ userId }) => ({
      result: engineeringService().addMember(
        userId,
        formField(formData, 'engineeringId'),
        formField(formData, 'userId'),
        {
          mutationId: formField(formData, 'mutationId'),
        },
      ),
      refreshPaths: REFRESH_PATHS,
    }),
  });
}

export async function removeEngineeringMemberAction(formData: FormData) {
  return runInteractiveMutation({
    validationEvent: 'engineering_member_remove_validation_failed',
    command: ({ userId }) => ({
      result: engineeringService().removeMember(
        userId,
        formField(formData, 'engineeringId'),
        formField(formData, 'userId'),
        {
          mutationId: formField(formData, 'mutationId'),
          expectedVersion: integerFormField(formData, 'expectedVersion'),
        },
      ),
      refreshPaths: REFRESH_PATHS,
    }),
  });
}

export async function createEnvironmentAction(formData: FormData) {
  return runInteractiveMutation({
    validationEvent: 'environment_create_validation_failed',
    command: ({ userId }) => ({
      result: engineeringService().createEnvironment(
        userId,
        formField(formData, 'engineeringId'),
        {
          mutationId: formField(formData, 'mutationId'),
          name: formField(formData, 'name'),
          deployment: deploymentField(formData),
          scriptCommand: optionalFormField(formData, 'scriptCommand'),
        },
      ),
      refreshPaths: REFRESH_PATHS,
    }),
  });
}

export async function updateEnvironmentAction(formData: FormData) {
  return runInteractiveMutation({
    validationEvent: 'environment_autosave_validation_failed',
    command: ({ userId }) => ({
      result: engineeringService().updateEnvironment(
        userId,
        formField(formData, 'environmentId'),
        {
          mutationId: formField(formData, 'mutationId'),
          expectedVersion: integerFormField(formData, 'expectedVersion'),
          name: formField(formData, 'name'),
          deployment: deploymentField(formData),
          scriptCommand: optionalFormField(formData, 'scriptCommand'),
        },
      ),
      refreshPaths: REFRESH_PATHS,
    }),
  });
}

export async function deleteEnvironmentAction(formData: FormData) {
  return runInteractiveMutation({
    validationEvent: 'environment_delete_validation_failed',
    command: ({ userId }) => ({
      result: engineeringService().deleteEnvironment(
        userId,
        formField(formData, 'environmentId'),
        {
          mutationId: formField(formData, 'mutationId'),
          expectedVersion: integerFormField(formData, 'expectedVersion'),
        },
      ),
      refreshPaths: REFRESH_PATHS,
    }),
  });
}

function runEngineeringRedirect(
  formData: FormData,
  errorPath: string,
  command: (userId: string) => { path: string; message: string },
): Promise<never> {
  return runRedirectMutation({
    formData,
    errorPath: () => errorPath,
    mapError: engineeringActionError,
    command: (userId) => ({
      ...command(userId),
      refreshPaths: REFRESH_PATHS,
    }),
  });
}

function deploymentField(formData: FormData, key?: string): DeploymentMethod {
  const suffix = key === undefined ? '' : `:${key}`;
  const kind = formField(formData, `deploymentKind${suffix}`);
  const command = formField(formData, `command${suffix}`).trim();
  return DeploymentMethodSchema.parse(command ? { kind, command } : { kind });
}

export async function createEngineeringBindingAction(formData: FormData): Promise<never> {
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
        refreshPaths: ['/projects'],
      };
    },
  });
}

export async function deleteEngineeringBindingAction(formData: FormData): Promise<never> {
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
        refreshPaths: ['/projects'],
      };
    },
  });
}
