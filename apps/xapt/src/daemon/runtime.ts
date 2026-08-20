import type { LocalStateStore } from '../state/store';
import { XAPT_VERSION } from '../version';
import type { CodexInstallation } from './codex';
import { DaemonControlServer } from './control';
import type { LocalFileSystem } from '../platform/files';
import type { XaptPaths } from '../platform/paths';
import type { DaemonSnapshot } from './status';
import type { ConnectionCoordinator } from './connection';
import type { AgentService } from './agent-service';

export interface DaemonRuntimeOptions {
  paths: XaptPaths;
  files: LocalFileSystem;
  state: LocalStateStore;
  codex: CodexInstallation;
  connection?: ConnectionCoordinator;
  agentService?: AgentService;
}

export class DaemonRuntime {
  private readonly control: DaemonControlServer;

  constructor(private readonly options: DaemonRuntimeOptions) {
    this.control = new DaemonControlServer({
      socketPath: options.paths.controlSocket,
      files: options.files,
      snapshot: () => this.snapshot(),
      connect: options.connection
        ? (serverUrl, progress) =>
            options.connection!.connect(serverUrl, progress)
        : undefined,
      forceStop: () => options.agentService?.forceStop(),
      revoke: options.connection
        ? () => options.connection!.revokeSelf()
        : undefined,
    });
  }

  async run(): Promise<void> {
    await this.options.state.initialize();
    await this.options.state.preflight();
    await this.control.start();
    try {
      await this.options.connection?.restore();
    } catch (error) {
      try {
        await this.control.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          '远程连接恢复失败，且本机控制通道清理失败',
        );
      }
      throw error;
    }
    const serviceTask = this.options.agentService?.run();
    await this.control.done;
    this.options.agentService?.stop();
    await serviceTask;
  }

  private async snapshot(): Promise<DaemonSnapshot> {
    const [connection, bindings, outbox] = await Promise.all([
      this.options.state.loadConnection(),
      this.options.state.loadBindings(),
      this.options.state.loadOutbox(),
    ]);
    return {
      service: 'RUNNING',
      connection:
        this.options.connection?.projection.status ??
        (connection ? 'DEGRADED' : 'UNCONFIGURED'),
      activity:
        this.options.connection?.projection.activity === 'BUSY' ||
        this.options.agentService?.projection.bindingActive ||
        (this.options.agentService?.projection.activeExecutionCount ?? 0) > 0 ||
        this.options.agentService?.projection.recoveryRequired
          ? 'BUSY'
          : 'IDLE',
      version: XAPT_VERSION,
      codexVersion: this.options.codex.version,
      serverOrigin:
        this.options.connection?.projection.serverOrigin ??
        (connection ? new URL(connection.serverUrl).origin : null),
      agentName: this.options.connection?.projection.agentName ?? null,
      lastHeartbeatAt:
        this.options.connection?.projection.lastHeartbeatAt ?? null,
      activeSlots:
        this.options.agentService?.projection.activeExecutionCount ?? 0,
      totalSlots: 3,
      waitingInteractions:
        this.options.agentService?.projection.waitingInteractionCount ?? 0,
      outboxCount: outbox.length,
      bindingCount: Object.keys(bindings.bindings).length,
      bindingActive:
        this.options.agentService?.projection.bindingActive ?? false,
    };
  }
}
