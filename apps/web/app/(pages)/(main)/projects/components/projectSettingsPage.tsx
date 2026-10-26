import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect, RedirectType } from 'next/navigation';
import { requireCurrentUser } from '@/app/auth';
import { engineeringService, projectService } from '@/server/runtime/services';
import {
  normalizeProjectSettingsRoute,
  parseProjectSettingsRoute,
  projectSettingsPath,
  projectSettingsRouteChanged,
  projectPanelPath,
  engineeringCreatePath,
} from '@/app/(pages)/(main)/projects/components/routeState';
import { ProjectSettingsControls } from './projectSettingsControls';
import {
  InvitationDialog,
  ProjectSettingsDialog,
  CollaborationDialog,
} from './collaborationDialog';

import {
  EngineeringDialog,
  EngineeringMemberManagement,
} from '../engineering/engineeringDialog';
import {
  EngineeringDetail,
  EngineeringEnvironmentManagement,
  EngineeringInformationManagement,
} from '../engineering/engineeringSettings';
import { EngineeringTabs } from './engineeringTabs';
import { DialogFeedback } from '../engineering/settingsFields';

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
    : projects[0];
  const panel = route.panel;
  const editing =
    panel === 'project' ||
    panel === 'collaboration' ||
    panel === 'invitations' ||
    (panel === 'engineering' &&
      (route.engineeringId === 'new' || Boolean(route.mode)));
  const owner = selected?.membership.role === 'OWNER';
  const members = selected
    ? projectService().listMembers(user.id, selected.project.id)
    : [];
  const engineering = selected
    ? engineeringService().listEngineering(user.id, selected.project.id)
    : [];
  const activeEngineering =
    engineering.find(({ id }) => id === route.engineeringId) ?? engineering[0];
  const creatingEngineering =
    panel === 'engineering' && route.engineeringId === 'new';
  const engineeringMode = panel === 'engineering' ? route.mode : undefined;
  const pendingInvitations =
    selected && owner
      ? projectService()
          .listProjectInvitations(user.id, selected.project.id)
          .filter(({ invitation }) => invitation.status === 'PENDING').length
      : 0;

  return (
    <>
      <ProjectSettingsControls
        mutationId={randomUUID()}
        projects={projects}
        selectedProjectId={selected?.project.id}
      >
        {!editing && route.error ? (
          <p className="project-settings__error" role="alert">
            {route.error}
          </p>
        ) : null}
        {!editing && route.success ? (
          <p className="notice notice-success" role="status">
            {route.success}
          </p>
        ) : null}
        {!selected && panel === 'invitations' ? (
          <InvitationDialog
            error={route.error}
            invitations={invitations}
            success={route.success}
          />
        ) : null}
        {selected ? (
          <>
            <header className="project-overview__heading">
              <div>
                <p>{owner ? '项目负责人' : '项目成员'}</p>
                <h2>{selected.project.name}</h2>
              </div>
              <nav aria-label="项目操作">
                {owner ? (
                  <Link
                    aria-label={`设置项目 ${selected.project.name}`}
                    href={projectPanelPath(selected.project.id, 'project')}
                  >
                    项目设置
                  </Link>
                ) : null}
                <Link href="/submissions">进入提测</Link>
              </nav>
            </header>
            {panel === 'invitations' ? (
              <InvitationDialog
                error={route.error}
                invitations={invitations}
                success={route.success}
              />
            ) : null}
            {panel === 'project' ? (
              <ProjectSettingsDialog
                error={route.error}
                projectId={selected.project.id}
                success={route.success}
                userId={user.id}
              />
            ) : null}
            <section
              className="project-overview__members"
              aria-label="项目成员"
            >
              <div className="project-overview__section-heading">
                <h3>
                  项目成员 <span>{members.length}</span>
                </h3>
                <Link
                  href={projectPanelPath(selected.project.id, 'collaboration')}
                >
                  {owner ? '管理成员与邀请' : '查看成员'}
                  {pendingInvitations
                    ? `（${pendingInvitations} 条待接受）`
                    : ''}
                </Link>
              </div>
              {panel === 'collaboration' ? (
                <CollaborationDialog
                  error={route.error}
                  projectId={selected.project.id}
                  success={route.success}
                  userId={user.id}
                />
              ) : (
                <ul>
                  {members.map(({ membership, user: member }) => (
                    <li key={member.id}>
                      <span
                        className="project-overview__avatar"
                        aria-hidden="true"
                      >
                        {member.displayName.slice(0, 1)}
                      </span>
                      <span>
                        <strong>
                          {member.displayName}
                          {member.id === user.id ? '（你）' : ''}
                        </strong>
                        <small>@{member.username}</small>
                      </span>
                      {membership.role === 'OWNER' ? <em>负责人</em> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section
              className="project-overview__engineering"
              aria-label="项目工程"
            >
              <div className="project-overview__section-heading">
                <h3>
                  工程 <span>{engineering.length}</span>
                </h3>
                {owner && engineering.length ? (
                  <Link
                    className="repair-primary"
                    href={engineeringCreatePath(selected.project.id)}
                  >
                    新建工程
                  </Link>
                ) : null}
              </div>
              {engineering.length ? (
                <EngineeringTabs
                  engineering={engineering.map(({ id, name, type }) => ({
                    id,
                    name,
                    type,
                  }))}
                  projectId={selected.project.id}
                  selectedId={
                    creatingEngineering ? undefined : activeEngineering?.id
                  }
                />
              ) : null}
              {creatingEngineering ? (
                <div id="project-engineering-panel">
                  <EngineeringDialog
                    error={route.error}
                    projectId={selected.project.id}
                    success={route.success}
                    userId={user.id}
                  />
                </div>
              ) : activeEngineering ? (
                <div
                  role="tabpanel"
                  id="project-engineering-panel"
                  aria-labelledby={`engineering-tab-${activeEngineering.id}`}
                  tabIndex={0}
                >
                  <EngineeringDetail
                    key={activeEngineering.id}
                    bindingRequestId={
                      route.engineeringId === activeEngineering.id
                        ? route.bindingRequestId
                        : undefined
                    }
                    engineeringId={activeEngineering.id}
                    owner={owner}
                    projectId={selected.project.id}
                    userId={user.id}
                    feedback={
                      engineeringMode ? (
                        <DialogFeedback
                          error={route.error}
                          success={route.success}
                        />
                      ) : null
                    }
                    informationEditor={
                      engineeringMode === 'information' && owner ? (
                        <EngineeringInformationManagement
                          engineeringId={activeEngineering.id}
                          projectId={selected.project.id}
                          userId={user.id}
                        />
                      ) : null
                    }
                    membersEditor={
                      engineeringMode === 'members' && owner ? (
                        <EngineeringMemberManagement
                          engineeringId={activeEngineering.id}
                          projectId={selected.project.id}
                          projectMembers={members}
                          userId={user.id}
                        />
                      ) : null
                    }
                    environmentsEditor={
                      engineeringMode === 'environments' && owner ? (
                        <EngineeringEnvironmentManagement
                          engineeringId={activeEngineering.id}
                          projectId={selected.project.id}
                          userId={user.id}
                        />
                      ) : null
                    }
                  />
                </div>
              ) : (
                <div className="project-overview__empty">
                  <h4>为 {selected.project.name} 添加第一个工程</h4>
                  <p>
                    {owner
                      ? '添加工程后，就能配置成员和测试环境，并绑定本机 Agent。'
                      : '项目负责人添加工程后，你可以在这里查看工程信息。'}
                  </p>
                  {owner ? (
                    <Link
                      className="repair-primary"
                      href={engineeringCreatePath(selected.project.id)}
                    >
                      新建工程
                    </Link>
                  ) : null}
                </div>
              )}
            </section>
          </>
        ) : null}
      </ProjectSettingsControls>
    </>
  );
}
