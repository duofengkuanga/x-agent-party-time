import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect, RedirectType } from 'next/navigation';
import { requireCurrentUser } from '@/platform/auth/server';
import { engineeringService, projectService } from '@/cooking/runtime/services';
import {
  normalizeProjectSettingsRoute,
  parseProjectSettingsRoute,
  projectSettingsPath,
  projectSettingsRouteChanged,
} from '@/cooking/projects/ui/route-state';
import { ProjectSettingsControls } from './project-settings-controls';
import { settingsHref } from './settings-links';
import {
  InvitationDialog,
  ProjectSettingsDialog,
  CollaborationDialog,
} from './collaboration-dialog';

import { EngineeringDialog } from './engineering-dialog';

export const metadata: Metadata = {
  title: '我的项目 — Agent Party Time',
  description: '管理协作提测项目、成员、工程配置与本机 Agent 绑定。',
};

export default async function ProjectSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    engineering?: string;
    bindingRequest?: string;
    error?: string;
    mode?: string;
    panel?: string;
    project?: string;
    success?: string;
  }>;
}) {
  const user = await requireCurrentUser();
  const query = await searchParams;
  const projects = projectService().listProjects(user.id);
  const invitations = projectService().listReceivedInvitations(user.id);
  const requestedRoute = parseProjectSettingsRoute(query);
  const requestedProject = requestedRoute.projectId
    ? projects.find(({ project }) => project.id === requestedRoute.projectId)
    : undefined;
  const engineeringIds =
    requestedProject && requestedRoute.panel === 'engineering'
      ? engineeringService()
          .listEngineering(user.id, requestedProject.project.id)
          .map(({ id }) => id)
      : undefined;
  const route = normalizeProjectSettingsRoute(requestedRoute, {
    projects: projects.map(({ project, membership }) => ({
      id: project.id,
      owner: membership.role === 'OWNER',
    })),
    engineeringIds,
  });
  if (projectSettingsRouteChanged(requestedRoute, route))
    redirect(projectSettingsPath(route), RedirectType.replace);
  const selected = route.projectId
    ? projects.find(({ project }) => project.id === route.projectId)
    : undefined;
  const panel = route.panel;

  return (
    <>
      <ProjectSettingsControls
        error={panel ? undefined : route.error}
        hasProjects={projects.length > 0}
        mutationId={randomUUID()}
        success={panel ? undefined : route.success}
      >
        <ol className="project-settings__list">
          {projects.map(({ project, membership }) => (
            <li key={project.id}>
              <div className="project-settings__project-copy">
                <span>
                  {membership.role === 'OWNER' ? '项目负责人' : '项目成员'}
                </span>
                <h2>{project.name}</h2>
              </div>
              <div className="project-settings__row-actions">
                {membership.role === 'OWNER' ? (
                  <Link
                    aria-label={`设置项目 ${project.name}`}
                    className="project-settings__row-settings"
                    href={settingsHref(project.id, 'project')}
                  >
                    设置
                  </Link>
                ) : null}
                <Link href={settingsHref(project.id, 'collaboration')}>
                  成员
                </Link>
                <Link
                  className="project-settings__row-primary"
                  href={settingsHref(project.id, 'engineering')}
                >
                  工程与 Agent
                </Link>
                <Link href="/cooking">提测</Link>
              </div>
            </li>
          ))}
        </ol>
      </ProjectSettingsControls>

      {panel === 'invitations' ? (
        <InvitationDialog
          error={route.error}
          invitations={invitations}
          success={route.success}
        />
      ) : null}
      {selected && panel === 'project' ? (
        <ProjectSettingsDialog
          error={route.error}
          projectId={selected.project.id}
          success={route.success}
          userId={user.id}
        />
      ) : null}
      {selected && panel === 'collaboration' ? (
        <CollaborationDialog
          error={route.error}
          projectId={selected.project.id}
          success={route.success}
          userId={user.id}
        />
      ) : null}
      {selected && panel === 'engineering' ? (
        <EngineeringDialog
          engineeringId={route.engineeringId}
          bindingRequestId={route.bindingRequestId}
          error={route.error}
          mode={route.mode}
          projectId={selected.project.id}
          success={route.bindingRequestId ? undefined : route.success}
          userId={user.id}
        />
      ) : null}
    </>
  );
}
