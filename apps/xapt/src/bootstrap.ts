import type { CliRuntime } from './cli/run';
import { MacOsCodexPreflight } from './daemon/codex';
import { AgentService } from './daemon/agent-service';
import { ConnectionCoordinator, normalizeServerOrigin } from './daemon/connection';
import { DaemonControlClient } from './daemon/control';
import { DaemonManager } from './daemon/manager';
import { DaemonRuntime } from './daemon/runtime';
import { NodeLocalFileSystem } from './platform/files';
import { MacOsBrowser } from './platform/macos/browser';
import { MacOsDirectorySelector } from './platform/macos/directory-selector';
import { MacOsKeychain, keychainAccount } from './platform/macos/keychain';
import { MacOsLaunchAgent } from './platform/macos/launch-agent';
import { xaptPaths } from './platform/paths';
import {
  CurrentUserEnvironment,
  NodeCommandRunner,
  SystemClock,
} from './platform/system';
import { LocalStateStore } from './state/store';
import { RunnerHttpClient } from './daemon/runner-http';
import { LocalRepositoryInspector } from './platform/repository';
import { TerminalForceConfirmation } from './platform/terminal';
import { AttachmentMaterializer } from './execution/attachments';
import { CodexAppServerExecutor } from './execution/codex-app-server';
import { ExecutionService } from './execution/service';
import { GitExecutionWorkspaceManager } from './execution/workspaces';
import { UpdateManager } from './install/update';
import { UninstallManager } from './install/uninstall';

export function createCliRuntime(): CliRuntime {
  const environment = new CurrentUserEnvironment();
  const paths = xaptPaths(environment.homeDirectory());
  const files = new NodeLocalFileSystem();
  const commands = new NodeCommandRunner();
  const state = new LocalStateStore(paths, files);
  const clock = new SystemClock();
  const codex = new MacOsCodexPreflight(commands, files, environment);
  const keychain = new MacOsKeychain(commands);
  const control = new DaemonControlClient(paths.controlSocket);
  const manager = new DaemonManager({
    paths,
    files,
    state,
    launchAgent: new MacOsLaunchAgent(commands, environment),
    codex,
    control,
    confirmation: new TerminalForceConfirmation(),
    clock,
    environment,
    stableExecutable: paths.currentExecutable,
  });
  const updates = new UpdateManager(
    paths,
    files,
    state,
    manager,
    codex,
    commands,
    clock,
  );
  const uninstaller = new UninstallManager(
    paths,
    files,
    state,
    manager,
    control,
    new TerminalForceConfirmation(),
    environment,
    keychain,
  );
  const http = new RunnerHttpClient();
  const workspaces = new GitExecutionWorkspaceManager(paths);
  return {
    daemonStart: () => manager.start(),
    daemonStatus: () => manager.status(),
    daemonConnect: (serverUrl, progress) =>
      control.connect(serverUrl, progress),
    daemonStop: (force) => manager.stop(force),
    update: () => updates.update(),
    uninstall: (force) => uninstaller.uninstall(force),
    bugsDelete: async ({ bugIds, all, force }) => {
      const connection = await state.loadConnection();
      if (!connection)
        throw new Error(
          '尚未连接 Server，请先运行 xapt daemon connect <server-url>',
        );
      const origin = normalizeServerOrigin(connection.serverUrl);
      const credential = await keychain.read(
        keychainAccount(origin, connection.runnerId),
      );
      if (!credential)
        throw new Error(
          '未找到本机 Credential，请先运行 xapt daemon connect <server-url>',
        );
      const keys = all
        ? await workspaces.workspaceKeys()
        : bugIds.map((bugId) => `bug-repair:${bugId}`);
      await workspaces.removeWorkspaces(keys, { force });
      return http.deleteBugs(origin, credential, {
        bugIds: all ? undefined : bugIds,
        all,
        force,
      });
    },
    internalDaemon: async () => {
      if (
        environment.platform() !== 'darwin' ||
        environment.architecture() !== 'arm64'
      )
        throw new Error('xapt 0.x 只支持 Apple Silicon macOS');
      const installation = await codex.check();
      const connection = new ConnectionCoordinator(
        state,
        keychain,
        new MacOsBrowser(commands),
        http,
        clock,
      );
      const agentService = new AgentService(
        connection,
        http,
        state,
        new MacOsDirectorySelector(commands),
        new LocalRepositoryInspector(commands),
        clock,
        new ExecutionService(
          http,
          state,
          files,
          new AttachmentMaterializer(http, paths),
          workspaces,
          new CodexAppServerExecutor(installation.executable),
        ),
      );
      await new DaemonRuntime({
        paths,
        files,
        state,
        codex: installation,
        connection,
        agentService,
      }).run();
    },
  };
}
