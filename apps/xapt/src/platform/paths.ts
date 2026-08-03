import { isAbsolute, join, resolve } from 'node:path';

export const XAPT_IDENTIFIER = 'com.agentpartytime.xapt';
export const XAPT_LAUNCH_AGENT_LABEL = `${XAPT_IDENTIFIER}.daemon`;

export interface XaptPaths {
  home: string;
  commandLink: string;
  installRoot: string;
  versions: string;
  currentLink: string;
  currentExecutable: string;
  installState: string;
  applicationSupport: string;
  connection: string;
  bindings: string;
  run: string;
  controlSocket: string;
  state: string;
  outbox: string;
  executions: string;
  workspaces: string;
  caches: string;
  updateCache: string;
  attachmentCache: string;
  executionCache: string;
  logs: string;
  daemonLog: string;
  daemonErrorLog: string;
  launchAgentPlist: string;
  versionExecutable(version: string): string;
}

export function xaptPaths(home: string): XaptPaths {
  if (!isAbsolute(home)) throw new Error('xapt Home 必须是绝对路径');
  const normalizedHome = resolve(home);
  const installRoot = join(normalizedHome, '.local', 'share', 'xapt');
  const applicationSupport = join(
    normalizedHome,
    'Library',
    'Application Support',
    XAPT_IDENTIFIER,
  );
  const state = join(applicationSupport, 'state');
  const caches = join(normalizedHome, 'Library', 'Caches', XAPT_IDENTIFIER);
  const logs = join(normalizedHome, 'Library', 'Logs', XAPT_IDENTIFIER);
  const versions = join(installRoot, 'versions');
  const currentLink = join(installRoot, 'current');

  return {
    home: normalizedHome,
    commandLink: join(normalizedHome, '.local', 'bin', 'xapt'),
    installRoot,
    versions,
    currentLink,
    currentExecutable: join(currentLink, 'xapt'),
    installState: join(installRoot, 'install.json'),
    applicationSupport,
    connection: join(applicationSupport, 'connection.json'),
    bindings: join(applicationSupport, 'bindings.json'),
    run: join(applicationSupport, 'run'),
    controlSocket: join(applicationSupport, 'run', 'control.sock'),
    state,
    outbox: join(state, 'outbox'),
    executions: join(state, 'executions'),
    workspaces: join(state, 'workspaces'),
    caches,
    updateCache: join(caches, 'updates'),
    attachmentCache: join(caches, 'attachments'),
    executionCache: join(caches, 'executions'),
    logs,
    daemonLog: join(logs, 'daemon.log'),
    daemonErrorLog: join(logs, 'daemon-error.log'),
    launchAgentPlist: join(
      normalizedHome,
      'Library',
      'LaunchAgents',
      `${XAPT_LAUNCH_AGENT_LABEL}.plist`,
    ),
    versionExecutable(version: string): string {
      if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version))
        throw new Error('xapt 版本格式无效');
      return join(versions, version, 'xapt');
    },
  };
}
