'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireCurrentUser } from '@/server/auth/server';
import { publicError } from '@/server/errors';
import { projectService } from '@/features/cooking/application/server';
import { ProjectInvitationDecisionSchema } from '../contract';
import {
  messageRedirectPath,
  rethrowRedirectError,
} from '@/server/http/message-redirect';

export async function createProjectAction(formData: FormData): Promise<never> {
  const user = await requireCurrentUser();
  try {
    const result = projectService().createProject(user.id, {
      mutationId: field(formData, 'mutationId'),
      name: field(formData, 'name'),
    });
    revalidatePath('/cooking/projects');
    redirect(
      messageRedirectPath(
        projectSettingsPath(result.project.id, 'engineering'),
        'success',
        '项目已创建',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError('/cooking/projects', error);
  }
}

export async function inviteProjectUserAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const projectId = field(formData, 'projectId');
  try {
    projectService().inviteUser(user.id, projectId, {
      mutationId: field(formData, 'mutationId'),
      username: field(formData, 'username'),
    });
    refreshProject(projectId);
    redirect(
      messageRedirectPath(
        projectSettingsPath(projectId, 'collaboration'),
        'success',
        '邀请已发送',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(projectSettingsPath(projectId, 'collaboration'), error);
  }
}

export async function respondProjectInvitationAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  try {
    projectService().respondToInvitation(
      user.id,
      field(formData, 'invitationId'),
      {
        mutationId: field(formData, 'mutationId'),
        expectedVersion: numberField(formData, 'expectedVersion'),
        decision:
          field(formData, 'decision') === 'ACCEPT' ? 'ACCEPT' : 'REJECT',
      },
    );
    revalidatePath('/cooking/projects');
    redirect(messageRedirectPath('/cooking/projects', 'success', '邀请已处理'));
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError('/cooking/projects', error);
  }
}

export async function revokeProjectInvitationAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const projectId = field(formData, 'projectId');
  try {
    projectService().revokeInvitation(
      user.id,
      field(formData, 'invitationId'),
      {
        mutationId: field(formData, 'mutationId'),
        expectedVersion: numberField(formData, 'expectedVersion'),
      },
    );
    refreshProject(projectId);
    redirect(
      messageRedirectPath(
        projectSettingsPath(projectId, 'collaboration'),
        'success',
        '邀请已撤销',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(projectSettingsPath(projectId, 'collaboration'), error);
  }
}

export async function updateProjectAction(formData: FormData): Promise<never> {
  const user = await requireCurrentUser();
  const projectId = field(formData, 'projectId');
  try {
    projectService().updateProject(user.id, projectId, {
      mutationId: field(formData, 'mutationId'),
      expectedVersion: numberField(formData, 'expectedVersion'),
      name: field(formData, 'name'),
    });
    refreshProject(projectId);
    redirect(
      messageRedirectPath(
        projectSettingsPath(projectId, 'collaboration'),
        'success',
        '项目名称已更新',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(projectSettingsPath(projectId, 'collaboration'), error);
  }
}

export async function removeProjectMemberAction(
  formData: FormData,
): Promise<never> {
  const user = await requireCurrentUser();
  const projectId = field(formData, 'projectId');
  try {
    projectService().removeMember(
      user.id,
      projectId,
      field(formData, 'userId'),
      {
        mutationId: field(formData, 'mutationId'),
        expectedVersion: numberField(formData, 'expectedVersion'),
      },
    );
    refreshProject(projectId);
    redirect(
      messageRedirectPath(
        projectSettingsPath(projectId, 'collaboration'),
        'success',
        '成员已移除',
      ),
    );
  } catch (error) {
    rethrowRedirectError(error);
    redirectWithError(projectSettingsPath(projectId, 'collaboration'), error);
  }
}

function refreshProject(projectId: string): void {
  revalidatePath('/cooking/projects');
  revalidatePath(projectSettingsPath(projectId, 'collaboration'));
}

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '');
}

function numberField(formData: FormData, name: string): number {
  return Number(field(formData, name));
}

function redirectWithError(path: string, error: unknown): never {
  redirect(messageRedirectPath(path, 'error', publicError(error).message));
}

function projectSettingsPath(
  projectId: string,
  panel: 'collaboration' | 'engineering',
): string {
  return `/cooking/projects?project=${encodeURIComponent(projectId)}&panel=${panel}`;
}
