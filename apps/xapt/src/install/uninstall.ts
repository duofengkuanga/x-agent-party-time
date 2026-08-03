import type { LocalFileSystem } from '../platform/files';
import type { XaptPaths } from '../platform/paths';
import type { LocalStateStore } from '../state/store';
import type { DaemonControlClient } from '../daemon/control';
import type { DaemonManager } from '../daemon/manager';
import type {
  ForceConfirmation,
  Keychain,
  UserEnvironment,
} from '../platform/contracts';
import { keychainAccount } from '../platform/macos/keychain';

export interface UninstallResult {
  remoteRevoked: boolean;
  warnings: string[];
}

export class UninstallManager {
  constructor(
    private readonly paths: XaptPaths,
    private readonly files: LocalFileSystem,
    private readonly state: LocalStateStore,
    private readonly daemon: Pick<DaemonManager, 'status' | 'start' | 'stop'>,
    private readonly control: Pick<DaemonControlClient, 'revoke'>,
    private readonly confirmation: ForceConfirmation,
    private readonly environment: UserEnvironment,
    private readonly keychain: Keychain,
  ) {}

  async uninstall(force: boolean): Promise<UninstallResult> {
    if (force) {
      if (!this.environment.isTerminal())
        throw new UninstallError(
          'TTY_REQUIRED',
          'uninstall --force 只允许在真实 TTY 中执行',
        );
      if (
        !(await this.confirmation.confirm(
          '强制卸载可能遗留 Lease、Workspace 和远程 Credential。',
        ))
      )
        throw new UninstallError('CANCELLED', '已取消强制卸载');
    }
    const connection = await this.state.loadConnection();
    let snapshot = await this.daemon.status();
    if (!force) {
      if (snapshot.service === 'UNRESPONSIVE')
        throw new UninstallError(
          'DAEMON_UNRESPONSIVE',
          'daemon 本机控制无响应',
        );
      if (snapshot.activity === 'BUSY')
        throw new UninstallError('DAEMON_BUSY', 'daemon 正在处理任务');
      const [outbox, executions, unsettledWorkspaces] = await Promise.all([
        this.state.loadOutbox(),
        this.state.loadExecutions(),
        this.hasUnsettledWorkspaces(),
      ]);
      if (outbox.length || executions.length || unsettledWorkspaces)
        throw new UninstallError(
          'UNSETTLED_STATE',
          '仍有 Outbox、Execution 或 Workspace 需要保留',
        );
    }

    const warnings: string[] = [];
    if (snapshot.service === 'STOPPED' && !force) {
      await this.daemon.start();
      snapshot = await this.daemon.status();
    }
    let remoteRevoked = false;
    if (snapshot.service === 'RUNNING') {
      try {
        await this.control.revoke();
        remoteRevoked = true;
      } catch (error) {
        if (!force) throw error;
        warnings.push('Server Credential 未确认撤销');
      }
    } else if (force) warnings.push('Server 离线，远程 Credential 状态未知');

    await this.daemon.stop(force, force);
    if (connection)
      try {
        await this.keychain.delete(
          keychainAccount(
            new URL(connection.serverUrl).origin,
            connection.runnerId,
          ),
        );
      } catch (error) {
        if (!force) throw error;
        warnings.push('Keychain Credential 未删除');
      }
    for (const path of [
      this.paths.commandLink,
      this.paths.launchAgentPlist,
      this.paths.applicationSupport,
      this.paths.caches,
      this.paths.logs,
      this.paths.installRoot,
    ])
      await this.files.remove(path, { recursive: true });
    return { remoteRevoked, warnings };
  }

  private async hasUnsettledWorkspaces(): Promise<boolean> {
    const entries = await this.files.list(this.paths.workspaces);
    if (entries.some((entry) => entry !== 'state.json')) return true;
    if (!entries.includes('state.json')) return false;
    const bytes = await this.files.read(`${this.paths.workspaces}/state.json`);
    if (!bytes) return true;
    try {
      const value = JSON.parse(new TextDecoder().decode(bytes)) as {
        workspaces?: unknown;
      };
      return (
        typeof value.workspaces !== 'object' ||
        value.workspaces === null ||
        Object.keys(value.workspaces).length > 0
      );
    } catch {
      return true;
    }
  }
}

export class UninstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${message}。下一步：请先收敛状态，或在真实 TTY 使用 --force。`);
    this.name = 'UninstallError';
  }
}
