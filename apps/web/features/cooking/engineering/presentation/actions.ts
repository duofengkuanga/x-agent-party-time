'use server';

import { engineeringService } from '@/features/cooking/application/server';
import {
  formField,
  formStringList,
  integerFormField,
  runRedirectMutation,
} from '@/features/cooking/shared/action-transport';
import {
  engineeringCreatePath,
  engineeringSettingsPath,
  engineeringViewPath,
} from '@/features/cooking/projects/presentation/route-state';
import {
  DeploymentMethodSchema,
  EngineeringTypeSchema,
  type DeploymentMethod,
} from '../contract';
import { engineeringActionError } from './action-error';

const REFRESH_PATHS = ['/cooking', '/cooking/projects'];

export async function createEngineeringAction(
  formData: FormData,
): Promise<never> {
  const projectId = formField(formData, 'projectId');
  return runEngineeringRedirect(
    formData,
    engineeringCreatePath(projectId),
    (userId) => {
      const engineering = engineeringService().createEngineeringSetup(
        userId,
        projectId,
        {
          mutationId: formField(formData, 'mutationId'),
          name: formField(formData, 'name'),
          type: EngineeringTypeSchema.parse(formField(formData, 'type')),
          identifier: formField(formData, 'identifier'),
          creatorMembershipMutationId: formField(
            formData,
            'creatorMembershipMutationId',
          ),
          members: formStringList(formData, 'memberUserId').map((memberId) => ({
            userId: memberId,
            mutationId: formField(formData, `memberMutationId:${memberId}`),
          })),
          environments: formStringList(formData, 'environmentKey').map(
            (key) => ({
              mutationId: formField(formData, `environmentMutationId:${key}`),
              name: formField(formData, `environmentName:${key}`),
              deployment: keyedDeploymentField(formData, key),
            }),
          ),
        },
      );
      return {
        path: engineeringSettingsPath(projectId, engineering.id),
        message: '工程已创建',
      };
    },
  );
}

export async function updateEngineeringAction(
  formData: FormData,
): Promise<never> {
  const ids = engineeringIds(formData);
  const path = engineeringViewPath(
    ids.projectId,
    ids.engineeringId,
    'information',
  );
  return runEngineeringRedirect(formData, path, (userId) => {
    engineeringService().updateEngineering(userId, ids.engineeringId, {
      mutationId: formField(formData, 'mutationId'),
      expectedVersion: integerFormField(formData, 'expectedVersion'),
      name: formField(formData, 'name'),
      type: EngineeringTypeSchema.parse(formField(formData, 'type')),
      identifier: formField(formData, 'identifier'),
    });
    return { path, message: '工程设置已更新' };
  });
}

export async function archiveEngineeringAction(
  formData: FormData,
): Promise<never> {
  const ids = engineeringIds(formData);
  const errorPath = engineeringViewPath(
    ids.projectId,
    ids.engineeringId,
    'information',
  );
  return runEngineeringRedirect(formData, errorPath, (userId) => {
    engineeringService().archiveEngineering(userId, ids.engineeringId, {
      mutationId: formField(formData, 'mutationId'),
      expectedVersion: integerFormField(formData, 'expectedVersion'),
    });
    return {
      path: engineeringSettingsPath(ids.projectId, ids.engineeringId),
      message: '工程已归档，历史数据仍然保留',
    };
  });
}

export async function addEngineeringMemberAction(
  formData: FormData,
): Promise<never> {
  const ids = engineeringIds(formData);
  const path = engineeringViewPath(ids.projectId, ids.engineeringId, 'members');
  return runEngineeringRedirect(formData, path, (userId) => {
    engineeringService().addMember(
      userId,
      ids.engineeringId,
      formField(formData, 'userId'),
      { mutationId: formField(formData, 'mutationId') },
    );
    return { path, message: '工程成员已添加' };
  });
}

export async function removeEngineeringMemberAction(
  formData: FormData,
): Promise<never> {
  const ids = engineeringIds(formData);
  const path = engineeringViewPath(ids.projectId, ids.engineeringId, 'members');
  return runEngineeringRedirect(formData, path, (userId) => {
    engineeringService().removeMember(
      userId,
      ids.engineeringId,
      formField(formData, 'userId'),
      {
        mutationId: formField(formData, 'mutationId'),
        expectedVersion: integerFormField(formData, 'expectedVersion'),
      },
    );
    return { path, message: '工程成员已移除' };
  });
}

export async function createEnvironmentAction(
  formData: FormData,
): Promise<never> {
  const ids = engineeringIds(formData);
  const path = engineeringViewPath(
    ids.projectId,
    ids.engineeringId,
    'environments',
  );
  return runEngineeringRedirect(formData, path, (userId) => {
    engineeringService().createEnvironments(
      userId,
      ids.engineeringId,
      formStringList(formData, 'environmentKey').map((key) => ({
        mutationId: formField(formData, `environmentMutationId:${key}`),
        name: formField(formData, `environmentName:${key}`),
        deployment: keyedDeploymentField(formData, key),
      })),
    );
    return { path, message: '测试环境已创建' };
  });
}

export async function updateEnvironmentAction(
  formData: FormData,
): Promise<never> {
  const ids = engineeringIds(formData);
  const path = engineeringViewPath(
    ids.projectId,
    ids.engineeringId,
    'environments',
  );
  return runEngineeringRedirect(formData, path, (userId) => {
    engineeringService().updateEnvironment(
      userId,
      formField(formData, 'environmentId'),
      {
        mutationId: formField(formData, 'mutationId'),
        expectedVersion: integerFormField(formData, 'expectedVersion'),
        name: formField(formData, 'name'),
        deployment: deploymentField(formData),
      },
    );
    return { path, message: '测试环境已更新' };
  });
}

export async function deleteEnvironmentAction(
  formData: FormData,
): Promise<never> {
  const ids = engineeringIds(formData);
  const path = engineeringViewPath(
    ids.projectId,
    ids.engineeringId,
    'environments',
  );
  return runEngineeringRedirect(formData, path, (userId) => {
    engineeringService().deleteEnvironment(
      userId,
      formField(formData, 'environmentId'),
      {
        mutationId: formField(formData, 'mutationId'),
        expectedVersion: integerFormField(formData, 'expectedVersion'),
      },
    );
    return { path, message: '测试环境已删除' };
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

function engineeringIds(formData: FormData) {
  return {
    projectId: formField(formData, 'projectId'),
    engineeringId: formField(formData, 'engineeringId'),
  };
}

function deploymentField(formData: FormData): DeploymentMethod {
  const kind = formField(formData, 'deploymentKind');
  const command = formField(formData, 'command').trim();
  return DeploymentMethodSchema.parse(command ? { kind, command } : { kind });
}

function keyedDeploymentField(
  formData: FormData,
  key: string,
): DeploymentMethod {
  const kind = formField(formData, `deploymentKind:${key}`);
  const command = formField(formData, `command:${key}`).trim();
  return DeploymentMethodSchema.parse(command ? { kind, command } : { kind });
}
