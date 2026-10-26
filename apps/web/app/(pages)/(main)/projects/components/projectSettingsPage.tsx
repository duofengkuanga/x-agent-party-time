import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect, RedirectType } from 'next/navigation';
import { requireCurrentUser } from '@/app/auth';
import { engineeringService, projectService } from '@/server/runtime/services';
import { updateProjectAction } from '@/app/actions/projects/projects';
import {
  normalizeProjectSettingsRoute,
  parseProjectSettingsRoute,
  projectSettingsPath,
  projectSettingsRouteChanged,
  engineeringCreatePath,
} from './routeState';
import { ProjectSettingsControls } from './projectSettingsControls';
import { InvitationDialog, CollaborationDialog } from './collaborationDialog';
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
import { AutoSaveBoundary, AutoSaveForm } from './autoSaveForm';
import { ProjectDeleteControl } from './projectDeleteControl';

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
  const requestedProject = projects.find(
    ({ project }) => project.id === requestedRoute.projectId,
  );
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
  const selected =
    projects.find(({ project }) => project.id === route.projectId) ??
    projects[0];
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
    route.panel === 'engineering' && route.engineeringId === 'new';

  return (
    <AutoSaveBoundary>
      <ProjectSettingsControls
        mutationId={randomUUID()}
        projects={projects}
        selectedProjectId={selected?.project.id}
      >
        {!creatingEngineering && route.error ? (
          <p className="project-settings__error" role="alert">
            {route.error}
          </p>
        ) : null}
        {!creatingEngineering && route.success ? (
          <p className="notice notice-success" role="status">
            {route.success}
          </p>
        ) : null}
        {route.panel === 'invitations' ? (
          <InvitationDialog invitations={invitations} />
        ) : null}
        {selected ? (
          <>
            <header className="project-overview__heading">
              <div>
                <p>{owner ? '项目负责人' : '项目成员'}</p>
                {owner ? (
                  <AutoSaveForm
                    className="project-name-direct"
                    save={updateProjectAction}
                    version={selected.project.version}
                  >
                    <input
                      name="projectId"
                      type="hidden"
                      value={selected.project.id}
                    />
                    <input
                      aria-label="项目名称"
                      autoComplete="off"
                      defaultValue={selected.project.name}
                      maxLength={120}
                      name="name"
                      required
                    />
                  </AutoSaveForm>
                ) : (
                  <h2>{selected.project.name}</h2>
                )}
              </div>
              <nav aria-label="项目操作">
                <span className="project-auto-save-note">修改后自动保存</span>
                <Link href="/submissions">进入提测</Link>
              </nav>
              {owner ? (
                <details className="project-delete-disclosure">
                  <summary>删除项目</summary>
                  <ProjectDeleteControl
                    mutationId={randomUUID()}
                    project={selected.project}
                  />
                </details>
              ) : null}
            </header>
            <section
              className="project-overview__members"
              aria-label="项目成员"
            >
              <div className="project-overview__section-heading">
                <h3>
                  项目成员 <span>{members.length}</span>
                </h3>
              </div>
              <CollaborationDialog
                projectId={selected.project.id}
                userId={user.id}
              />
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
                    informationEditor={
                      owner ? (
                        <EngineeringInformationManagement
                          engineeringId={activeEngineering.id}
                          projectId={selected.project.id}
                          userId={user.id}
                        />
                      ) : null
                    }
                    membersEditor={
                      owner ? (
                        <EngineeringMemberManagement
                          engineeringId={activeEngineering.id}
                          projectMembers={members}
                          userId={user.id}
                        />
                      ) : null
                    }
                    environmentsEditor={
                      owner ? (
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
    </AutoSaveBoundary>
  );
}
