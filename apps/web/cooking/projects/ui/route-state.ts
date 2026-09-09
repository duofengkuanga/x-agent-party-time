export type ProjectSettingsPanel =
  'invitations' | 'project' | 'collaboration' | 'engineering';

export type EngineeringSettingsMode =
  'members' | 'environments' | 'information';

export type ProjectSettingsRoute = {
  projectId?: string;
  panel?: string;
  engineeringId?: string;
  mode?: string;
  bindingRequestId?: string;
  error?: string;
  success?: string;
};

export type ProjectRouteAccess = {
  projects: Array<{ id: string; owner: boolean }>;
  engineeringIds?: string[];
};

export function parseProjectSettingsRoute(query: {
  project?: string;
  panel?: string;
  engineering?: string;
  mode?: string;
  bindingRequest?: string;
  error?: string;
  success?: string;
}): ProjectSettingsRoute {
  return compactRoute({
    projectId: query.project,
    panel: query.panel,
    engineeringId: query.engineering,
    mode: query.mode,
    bindingRequestId: query.bindingRequest,
    error: query.error,
    success: query.success,
  });
}

export function normalizeProjectSettingsRoute(
  route: ProjectSettingsRoute,
  access: ProjectRouteAccess,
): ProjectSettingsRoute {
  const feedback = { error: route.error, success: route.success };
  if (!isPanel(route.panel)) return compactRoute(feedback);
  if (route.panel === 'invitations')
    return compactRoute({ panel: 'invitations', ...feedback });

  const project = access.projects.find(({ id }) => id === route.projectId);
  if (!project) return compactRoute(feedback);
  const parent = { projectId: project.id, panel: route.panel, ...feedback };
  if (route.panel === 'project' && !project.owner)
    return compactRoute({
      projectId: project.id,
      panel: 'collaboration',
      ...feedback,
    });
  if (route.panel !== 'engineering') return compactRoute(parent);
  if (!route.engineeringId) return compactRoute(parent);
  if (route.engineeringId === 'new')
    return project.owner
      ? compactRoute({ ...parent, engineeringId: 'new' })
      : compactRoute(parent);
  if (!access.engineeringIds?.includes(route.engineeringId))
    return compactRoute(parent);

  const detail = { ...parent, engineeringId: route.engineeringId };
  if (!route.mode) {
    return compactRoute({
      ...detail,
      bindingRequestId: route.bindingRequestId,
    });
  }
  if (!project.owner || !isEngineeringMode(route.mode))
    return compactRoute(detail);
  return compactRoute({ ...detail, mode: route.mode });
}

export function projectSettingsRouteChanged(
  requested: ProjectSettingsRoute,
  normalized: ProjectSettingsRoute,
): boolean {
  return projectSettingsPath(requested) !== projectSettingsPath(normalized);
}

export function projectSettingsPath(route: ProjectSettingsRoute): string {
  const search = new URLSearchParams();
  if (route.projectId) search.set('project', route.projectId);
  if (route.panel) search.set('panel', route.panel);
  if (route.engineeringId) search.set('engineering', route.engineeringId);
  if (route.mode) search.set('mode', route.mode);
  if (route.bindingRequestId)
    search.set('bindingRequest', route.bindingRequestId);
  if (route.error) search.set('error', route.error);
  if (route.success) search.set('success', route.success);
  const query = search.toString();
  return query ? `/cooking/projects?${query}` : '/cooking/projects';
}

export function projectPanelPath(
  projectId: string,
  panel: Exclude<ProjectSettingsPanel, 'invitations'>,
): string {
  return projectSettingsPath({ projectId, panel });
}

export function engineeringSettingsPath(
  projectId: string,
  engineeringId: string,
): string {
  return projectSettingsPath({
    projectId,
    panel: 'engineering',
    engineeringId,
  });
}

export function engineeringCreatePath(projectId: string): string {
  return engineeringSettingsPath(projectId, 'new');
}

export function engineeringViewPath(
  projectId: string,
  engineeringId: string,
  mode: EngineeringSettingsMode,
): string {
  return projectSettingsPath({
    projectId,
    panel: 'engineering',
    engineeringId,
    mode,
  });
}

export function bindingSettingsPath(
  projectId: string,
  engineeringId: string,
  bindingRequestId?: string,
): string {
  return projectSettingsPath({
    projectId,
    panel: 'engineering',
    engineeringId,
    bindingRequestId,
  });
}

function compactRoute(route: ProjectSettingsRoute): ProjectSettingsRoute {
  return Object.fromEntries(
    Object.entries(route).filter(([, value]) => Boolean(value)),
  ) as ProjectSettingsRoute;
}

function isPanel(value: string | undefined): value is ProjectSettingsPanel {
  return (
    value === 'invitations' ||
    value === 'project' ||
    value === 'collaboration' ||
    value === 'engineering'
  );
}

function isEngineeringMode(
  value: string | undefined,
): value is EngineeringSettingsMode {
  return (
    value === 'members' || value === 'environments' || value === 'information'
  );
}
