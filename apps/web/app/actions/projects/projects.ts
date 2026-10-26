'use server';

import { projectService } from '@/server/runtime/services';
import {
  formField,
  integerFormField,
  runRedirectMutation,
  runInteractiveMutation,
} from '@/app/actions/actionTransport';
import { ProjectInvitationDecisionSchema } from '../../../contracts/projects/project';
import {
  projectPanelPath,
  projectSettingsPath,
} from '../../(pages)/(main)/projects/components/routeState';

const PROJECTS_PATH = '/projects';

export async function createProjectAction(formData: FormData): Promise<never> {
  return runRedirectMutation({
    formData,
    errorPath: () => PROJECTS_PATH,
    command: (userId) => {
      const result = projectService().createProject(userId, {
        mutationId: formField(formData, 'mutationId'),
        name: formField(formData, 'name'),
      });
      return {
        path: projectPanelPath(result.project.id, 'engineering'),
        message: '项目已创建',
        refreshPaths: [PROJECTS_PATH],
      };
    },
  });
}

export async function inviteProjectUserAction(formData: FormData): Promise<never> {
  const projectId = formField(formData, 'projectId');
  return runRedirectMutation({
    formData,
    errorPath: () => projectSettingsPath({ projectId }),
    command: (userId) => {
      projectService().inviteUser(userId, projectId, {
        mutationId: formField(formData, 'mutationId'),
        username: formField(formData, 'username'),
      });
      return projectSuccess(projectId, '邀请已发送');
    },
  });
}

export async function respondProjectInvitationAction(formData: FormData): Promise<never> {
  const returnTo = invitationReturnPath(formField(formData, 'returnTo'));
  return runRedirectMutation({
    formData,
    errorPath: () => returnTo,
    command: (userId) => {
      projectService().respondToInvitation(userId, formField(formData, 'invitationId'), {
        mutationId: formField(formData, 'mutationId'),
        expectedVersion: integerFormField(formData, 'expectedVersion'),
        decision: ProjectInvitationDecisionSchema.parse(formField(formData, 'decision')),
      });
      return {
        path: returnTo,
        message: '邀请已处理',
        refreshPaths: [PROJECTS_PATH],
      };
    },
  });
}

export async function revokeProjectInvitationAction(formData: FormData): Promise<never> {
  const projectId = formField(formData, 'projectId');
  return runRedirectMutation({
    formData,
    errorPath: () => projectSettingsPath({ projectId }),
    command: (userId) => {
      projectService().revokeInvitation(userId, formField(formData, 'invitationId'), {
        mutationId: formField(formData, 'mutationId'),
        expectedVersion: integerFormField(formData, 'expectedVersion'),
      });
      return projectSuccess(projectId, '邀请已撤销');
    },
  });
}

export async function updateProjectAction(formData: FormData) {
  return runInteractiveMutation({
    validationEvent: 'project_autosave_validation_failed',
    command: ({ userId }) => ({
      result: projectService().updateProject(userId, formField(formData, 'projectId'), {
        mutationId: formField(formData, 'mutationId'),
        expectedVersion: integerFormField(formData, 'expectedVersion'),
        name: formField(formData, 'name'),
      }),
      refreshPaths: [PROJECTS_PATH, '/submissions'],
    }),
  });
}

export async function deleteProjectAction(formData: FormData): Promise<never> {
  const projectId = formField(formData, 'projectId');
  return runRedirectMutation({
    formData,
    errorPath: () => projectSettingsPath({ projectId }),
    command: (userId) => {
      projectService().deleteProject(userId, projectId, {
        mutationId: formField(formData, 'mutationId'),
        expectedVersion: integerFormField(formData, 'expectedVersion'),
        confirmationName: formField(formData, 'confirmationName'),
      });
      return {
        path: PROJECTS_PATH,
        message: '项目已删除',
        refreshPaths: [PROJECTS_PATH, '/submissions'],
      };
    },
  });
}

export async function removeProjectMemberAction(formData: FormData): Promise<never> {
  const projectId = formField(formData, 'projectId');
  return runRedirectMutation({
    formData,
    errorPath: () => projectSettingsPath({ projectId }),
    command: (userId) => {
      projectService().removeMember(userId, projectId, formField(formData, 'userId'), {
        mutationId: formField(formData, 'mutationId'),
        expectedVersion: integerFormField(formData, 'expectedVersion'),
      });
      return projectSuccess(projectId, '成员已移除');
    },
  });
}

function invitationReturnPath(value: string): string {
  return value === PROJECTS_PATH ? value : `${PROJECTS_PATH}?panel=invitations`;
}

function projectSuccess(projectId: string, message: string) {
  return {
    path: projectSettingsPath({ projectId }),
    message,
    refreshPaths: [PROJECTS_PATH],
  };
}
