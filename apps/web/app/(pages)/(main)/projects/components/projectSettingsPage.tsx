import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect, RedirectType } from 'next/navigation';
import { requireCurrentUser } from '@/app/auth';
import { engineeringService, projectService } from '@/server/runtime/services';
import { runnerService } from '@/server/runtime/runner';
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
import { EngineeringTabs, ProjectRouteFeedback } from './engineeringTabs';
import { AutoSaveBoundary, AutoSaveForm } from './autoSaveForm';
import { ProjectDeleteControl } from './projectDeleteControl';
import { ProjectMembersControl } from './projectMembersControl';

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
  const engineeringReader = engineeringService();
  const requestedEngineering = requestedProject
    ? engineeringReader.listEngineering(user.id, requestedProject.project.id)
    : [];
  const engineeringIds =
    requestedRoute.panel === 'engineering'
      ? requestedEngineering.map(({ id }) => id)
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
    ? selected.project.id === requestedProject?.project.id
      ? requestedEngineering
      : engineeringReader.listEngineering(user.id, selected.project.id)
    : [];
  const creatingEngineering =
    route.panel === 'engineering' && route.engineeringId === 'new';

  const availableRunners = engineering.length
    ? runnerService()
        .listRunners(user.id)
        .filter(({ online, runner }) => online && !runner.revokedAt)
    : [];
  const engineeringPanels = engineering.map((item) => {
    const workspace = engineeringReader.getWorkspace(user.id, item.id);
    return {
      id: item.id,
      name: workspace.engineering.name,
      type: workspace.engineering.type,
      panel: (
        <EngineeringDetail
          key={item.id}
          bindingRequestId={
            route.engineeringId === item.id ? route.bindingRequestId : undefined
          }
          workspace={workspace}
          runners={availableRunners}
          owner={owner}
          userId={user.id}
          informationEditor={
            owner ? (
              <EngineeringInformationManagement
                workspace={workspace}
                identifierLocked={engineeringReader.isIdentifierLocked(
                  user.id,
                  item.id,
                )}
              />
            ) : null
          }
          membersEditor={
            owner ? (
              <EngineeringMemberManagement
                workspace={workspace}
                projectMembers={members}
              />
            ) : null
          }
          environmentsEditor={
            owner ? (
              <EngineeringEnvironmentManagement workspace={workspace} />
            ) : null
          }
        />
      ),
    };
  });

  return (
    <AutoSaveBoundary>
      <ProjectSettingsControls
        mutationId={randomUUID()}
        projects={projects}
        selectedProjectId={selected?.project.id}
      >
        <ProjectRouteFeedback />
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
                <ProjectMembersControl
                  key={selected.project.id}
                  count={members.length}
                  projectName={selected.project.name}
                >
                  <CollaborationDialog
                    projectId={selected.project.id}
                    userId={user.id}
                  />
                </ProjectMembersControl>
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
              className="project-overview__engineering"
              aria-label="项目工程"
            >
              {engineering.length || creatingEngineering ? (
                <EngineeringTabs
                  engineering={engineeringPanels}
                  projectId={selected.project.id}
                  creationPanel={
                    owner ? (
                      <EngineeringDialog
                        error={creatingEngineering ? route.error : undefined}
                        projectId={selected.project.id}
                        success={
                          creatingEngineering ? route.success : undefined
                        }
                        userId={user.id}
                      />
                    ) : null
                  }
                />
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
