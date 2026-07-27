'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireCurrentUser } from '@/platform/auth/server';
import { publicError } from '@/platform/errors';
import {
  messageRedirectPath,
  rethrowRedirectError,
} from '@/platform/http/message-redirect';
import { engineeringService } from '@/modules/cooking/application/server';
import { DeploymentMethodSchema, type DeploymentMethod } from '../contract';

export async function createEngineeringAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const projectId = field(formData, 'projectId');
  try {
    const engineering = engineeringService().createEngineering(
      user.id,
      projectId,
      {
        mutationId: field(formData, 'mutationId'),
        name: field(formData, 'name'),
        repositoryUrl: field(formData, 'repositoryUrl'),
      },
    );
    refreshProject(projectId);
    redirect(
      messageRedirectPath(
        engineeringPath(projectId, engineering.id),
        'success',
        '工程已创建',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(projectPath(projectId), error);
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
      repositoryUrl: field(formData, 'repositoryUrl'),
    });
    refreshEngineering(projectId, engineeringId);
    redirect(
      messageRedirectPath(
        engineeringPath(projectId, engineeringId),
        'success',
        '工程设置已更新',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(engineeringPath(projectId, engineeringId), error);
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
    redirect(
      messageRedirectPath(
        engineeringPath(projectId, engineeringId),
        'success',
        '工程已归档，历史数据仍然保留',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(engineeringPath(projectId, engineeringId), error);
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
    redirect(
      messageRedirectPath(
        engineeringPath(projectId, engineeringId),
        'success',
        '工程成员已添加',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(engineeringPath(projectId, engineeringId), error);
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
    redirect(
      messageRedirectPath(
        engineeringPath(projectId, engineeringId),
        'success',
        '工程成员已移除',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(engineeringPath(projectId, engineeringId), error);
  }
}

export async function createEnvironmentAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const engineeringId = field(formData, 'engineeringId');
  const projectId = field(formData, 'projectId');
  try {
    engineeringService().createEnvironment(user.id, engineeringId, {
      mutationId: field(formData, 'mutationId'),
      name: field(formData, 'name'),
      deployment: deploymentField(formData),
    });
    refreshEngineering(projectId, engineeringId);
    redirect(
      messageRedirectPath(
        engineeringPath(projectId, engineeringId),
        'success',
        '测试环境已创建',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(engineeringPath(projectId, engineeringId), error);
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
    redirect(
      messageRedirectPath(
        engineeringPath(projectId, engineeringId),
        'success',
        '测试环境已更新',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(engineeringPath(projectId, engineeringId), error);
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
    redirect(
      messageRedirectPath(
        engineeringPath(projectId, engineeringId),
        'success',
        '测试环境已删除',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(engineeringPath(projectId, engineeringId), error);
  }
}

function deploymentField(formData: FormData): DeploymentMethod {
  const kind = field(formData, 'deploymentKind');
  const command = field(formData, 'command').trim();
  const raw = command ? { kind, command } : { kind };
  return DeploymentMethodSchema.parse(raw);
}

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '');
}

function numberField(formData: FormData, name: string): number {
  return Number(field(formData, name));
}

function projectPath(projectId: string): string {
  return `/cooking/projects?project=${encodeURIComponent(projectId)}&panel=engineering`;
}

function engineeringPath(projectId: string, engineeringId: string): string {
  return `${projectPath(projectId)}&engineering=${encodeURIComponent(engineeringId)}`;
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
  redirect(messageRedirectPath(path, 'error', publicError(error).message));
}
