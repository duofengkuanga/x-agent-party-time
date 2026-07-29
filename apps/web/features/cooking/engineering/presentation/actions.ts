'use server';

import { revalidatePath } from 'next/cache';
import { redirect, RedirectType } from 'next/navigation';
import { requireCurrentUser } from '@/server/auth/server';
import {
  messageRedirectPath,
  rethrowRedirectError,
} from '@/server/http/message-redirect';
import { engineeringService } from '@/features/cooking/application/server';
import {
  DeploymentMethodSchema,
  EngineeringTypeSchema,
  type DeploymentMethod,
} from '../contract';
import { engineeringActionError } from './action-error';

export async function createEngineeringAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const projectId = field(formData, 'projectId');
  try {
    const engineering = engineeringService().createEngineeringSetup(
      user.id,
      projectId,
      {
        mutationId: field(formData, 'mutationId'),
        name: field(formData, 'name'),
        type: EngineeringTypeSchema.parse(field(formData, 'type')),
        identifier: field(formData, 'identifier'),
        creatorMembershipMutationId: field(
          formData,
          'creatorMembershipMutationId',
        ),
        members: stringFields(formData, 'memberUserId').map((userId) => ({
          userId,
          mutationId: field(formData, `memberMutationId:${userId}`),
        })),
        environments: stringFields(formData, 'environmentKey').map((key) => ({
          mutationId: field(formData, `environmentMutationId:${key}`),
          name: field(formData, `environmentName:${key}`),
          deployment: keyedDeploymentField(formData, key),
        })),
      },
    );
    refreshProject(projectId);
    redirectReplacingHistory(
      messageRedirectPath(
        engineeringPath(projectId, engineering.id),
        'success',
        '工程已创建',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(engineeringCreatePath(projectId), error);
  }
}

export async function updateEngineeringAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const engineeringId = field(formData, 'engineeringId');
  const projectId = field(formData, 'projectId');
  try {
    engineeringService().updateEngineering(user.id, engineeringId, {
      mutationId: field(formData, 'mutationId'),
      expectedVersion: numberField(formData, 'expectedVersion'),
      name: field(formData, 'name'),
      type: EngineeringTypeSchema.parse(field(formData, 'type')),
      identifier: field(formData, 'identifier'),
    });
    refreshEngineering(projectId, engineeringId);
    redirectReplacingHistory(
      messageRedirectPath(
        engineeringViewPath(projectId, engineeringId, 'information'),
        'success',
        '工程设置已更新',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(
      engineeringViewPath(projectId, engineeringId, 'information'),
      error,
    );
  }
}

export async function archiveEngineeringAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const engineeringId = field(formData, 'engineeringId');
  const projectId = field(formData, 'projectId');
  try {
    engineeringService().archiveEngineering(user.id, engineeringId, {
      mutationId: field(formData, 'mutationId'),
      expectedVersion: numberField(formData, 'expectedVersion'),
    });
    refreshEngineering(projectId, engineeringId);
    redirectReplacingHistory(
      messageRedirectPath(
        engineeringPath(projectId, engineeringId),
        'success',
        '工程已归档，历史数据仍然保留',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(
      engineeringViewPath(projectId, engineeringId, 'information'),
      error,
    );
  }
}

export async function addEngineeringMemberAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const engineeringId = field(formData, 'engineeringId');
  const projectId = field(formData, 'projectId');
  try {
    engineeringService().addMember(
      user.id,
      engineeringId,
      field(formData, 'userId'),
      { mutationId: field(formData, 'mutationId') },
    );
    refreshEngineering(projectId, engineeringId);
    redirectReplacingHistory(
      messageRedirectPath(
        engineeringViewPath(projectId, engineeringId, 'members'),
        'success',
        '工程成员已添加',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(
      engineeringViewPath(projectId, engineeringId, 'members'),
      error,
    );
  }
}

export async function removeEngineeringMemberAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const engineeringId = field(formData, 'engineeringId');
  const projectId = field(formData, 'projectId');
  try {
    engineeringService().removeMember(
      user.id,
      engineeringId,
      field(formData, 'userId'),
      {
        mutationId: field(formData, 'mutationId'),
        expectedVersion: numberField(formData, 'expectedVersion'),
      },
    );
    refreshEngineering(projectId, engineeringId);
    redirectReplacingHistory(
      messageRedirectPath(
        engineeringViewPath(projectId, engineeringId, 'members'),
        'success',
        '工程成员已移除',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(
      engineeringViewPath(projectId, engineeringId, 'members'),
      error,
    );
  }
}

export async function createEnvironmentAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const engineeringId = field(formData, 'engineeringId');
  const projectId = field(formData, 'projectId');
  try {
    engineeringService().createEnvironments(
      user.id,
      engineeringId,
      stringFields(formData, 'environmentKey').map((key) => ({
        mutationId: field(formData, `environmentMutationId:${key}`),
        name: field(formData, `environmentName:${key}`),
        deployment: keyedDeploymentField(formData, key),
      })),
    );
    refreshEngineering(projectId, engineeringId);
    redirectReplacingHistory(
      messageRedirectPath(
        engineeringViewPath(projectId, engineeringId, 'environments'),
        'success',
        '测试环境已创建',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(
      engineeringViewPath(projectId, engineeringId, 'environments'),
      error,
    );
  }
}

export async function updateEnvironmentAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const engineeringId = field(formData, 'engineeringId');
  const projectId = field(formData, 'projectId');
  try {
    engineeringService().updateEnvironment(
      user.id,
      field(formData, 'environmentId'),
      {
        mutationId: field(formData, 'mutationId'),
        expectedVersion: numberField(formData, 'expectedVersion'),
        name: field(formData, 'name'),
        deployment: deploymentField(formData),
      },
    );
    refreshEngineering(projectId, engineeringId);
    redirectReplacingHistory(
      messageRedirectPath(
        engineeringViewPath(projectId, engineeringId, 'environments'),
        'success',
        '测试环境已更新',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(
      engineeringViewPath(projectId, engineeringId, 'environments'),
      error,
    );
  }
}

export async function deleteEnvironmentAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const engineeringId = field(formData, 'engineeringId');
  const projectId = field(formData, 'projectId');
  try {
    engineeringService().deleteEnvironment(
      user.id,
      field(formData, 'environmentId'),
      {
        mutationId: field(formData, 'mutationId'),
        expectedVersion: numberField(formData, 'expectedVersion'),
      },
    );
    refreshEngineering(projectId, engineeringId);
    redirectReplacingHistory(
      messageRedirectPath(
        engineeringViewPath(projectId, engineeringId, 'environments'),
        'success',
        '测试环境已删除',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(
      engineeringViewPath(projectId, engineeringId, 'environments'),
      error,
    );
  }
}

function deploymentField(formData: FormData): DeploymentMethod {
  const kind = field(formData, 'deploymentKind');
  const command = field(formData, 'command').trim();
  const raw = command ? { kind, command } : { kind };
  return DeploymentMethodSchema.parse(raw);
}

function keyedDeploymentField(
  formData: FormData,
  key: string,
): DeploymentMethod {
  const kind = field(formData, `deploymentKind:${key}`);
  const command = field(formData, `command:${key}`).trim();
  const raw = command ? { kind, command } : { kind };
  return DeploymentMethodSchema.parse(raw);
}

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '');
}

function numberField(formData: FormData, name: string): number {
  return Number(field(formData, name));
}

function stringFields(formData: FormData, name: string): string[] {
  return formData.getAll(name).map(String);
}

function projectPath(projectId: string): string {
  return `/cooking/projects?project=${encodeURIComponent(projectId)}&panel=engineering`;
}

function engineeringPath(projectId: string, engineeringId: string): string {
  return `${projectPath(projectId)}&engineering=${encodeURIComponent(engineeringId)}`;
}

function engineeringCreatePath(projectId: string): string {
  return engineeringPath(projectId, 'new');
}

function engineeringViewPath(
  projectId: string,
  engineeringId: string,
  view: 'members' | 'environments' | 'information',
): string {
  return `${engineeringPath(projectId, engineeringId)}&mode=${view}`;
}

function refreshProject(projectId: string): void {
  revalidatePath('/cooking');
  revalidatePath('/cooking/projects');
}

function refreshEngineering(projectId: string, engineeringId: string): void {
  refreshProject(projectId);
  revalidatePath('/cooking/projects');
}

function redirectWithError(path: string, error: unknown): never {
  redirectReplacingHistory(
    messageRedirectPath(path, 'error', engineeringActionError(error).message),
  );
}

function redirectReplacingHistory(path: string): never {
  redirect(path, RedirectType.replace);
}
