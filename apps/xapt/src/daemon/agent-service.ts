import type {
  RunnerBindingWork,
  RunnerBindingWorkCompletion,
} from '@agent-party-time/runner-contract';
import type { Clock } from '../platform/contracts';
import type { DirectorySelector } from '../platform/macos/directory-selector';
import {
  RepositoryError,
  type LocalRepositoryInspector,
} from '../platform/repository';
import type { LocalStateStore } from '../state/store';
import type {
  AuthenticatedRunnerSession,
  ConnectionCoordinator,
} from './connection';
import type { RunnerBindingHttp } from './runner-http';
import type { ExecutionService } from '../execution/service';

export interface AgentServiceProjection {
  bindingActive: boolean;
  activeExecutionCount: number;
  waitingInteractionCount: number;
  recoveryRequired: boolean;
}

export class AgentService {
  readonly projection: AgentServiceProjection = {
    bindingActive: false,
    activeExecutionCount: 0,
    waitingInteractionCount: 0,
    recoveryRequired: false,
  };
  private stopped = false;

  constructor(
    private readonly connection: ConnectionCoordinator,
    private readonly http: RunnerBindingHttp,
    private readonly state: LocalStateStore,
    private readonly selector: DirectorySelector,
    private readonly repositories: LocalRepositoryInspector,
    private readonly clock: Clock,
    private readonly executions?: ExecutionService,
    private readonly pollIntervalMs = 1_000,
  ) {}

  async run(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        await this.cycle();
      } catch (error) {
        this.connection.reportConnectionError(error);
      }
      if (!this.stopped) await this.clock.sleep(this.pollIntervalMs);
    }
    await this.executions?.waitForIdle();
  }

  stop(): void {
    this.stopped = true;
  }

  forceStop(): void {
    this.stopped = true;
    this.executions?.forceStop();
  }

  async cycle(): Promise<boolean> {
    const recovering = this.executions
      ? (await this.state.loadOutbox()).length > 0 ||
        (await this.executions.hasRecoveryRecords())
      : false;
    const session = await this.connection.heartbeat(
      recovering
        ? 0
        : 3 - (this.executions?.projection.activeExecutionCount ?? 0),
    );
    if (!session) return false;
    const serverBindings = await this.http.listBindings(
      session.serverOrigin,
      session.credential,
    );
    await this.state.pruneBindings(
      serverBindings.map(({ bindingId }) => bindingId),
    );
    if (this.executions) {
      this.projection.activeExecutionCount =
        this.executions.projection.activeExecutionCount;
      this.projection.waitingInteractionCount =
        this.executions.projection.waitingInteractionCount;
      this.projection.recoveryRequired =
        this.executions.projection.recoveryRequired;
      try {
        const progressed = await this.executions.cycle(session);
        if (recovering || progressed) return progressed;
      } finally {
        this.projection.activeExecutionCount =
          this.executions.projection.activeExecutionCount;
        this.projection.waitingInteractionCount =
          this.executions.projection.waitingInteractionCount;
        this.projection.recoveryRequired =
          this.executions.projection.recoveryRequired;
      }
    }
    const request = await this.http.claimBindingWork(
      session.serverOrigin,
      session.credential,
    );
    if (!request) return false;
    this.projection.bindingActive = true;
    try {
      await this.process(session, request);
    } finally {
      this.projection.bindingActive = false;
    }
    return true;
  }

  private async process(
    session: AuthenticatedRunnerSession,
    request: RunnerBindingWork,
  ): Promise<void> {
    let repositoryPath: string | null;
    try {
      repositoryPath = await this.selector.selectDirectory();
    } catch {
      await this.completeFailure(session, request, {
        outcome: 'FAILED',
        code: 'UNSUPPORTED_PLATFORM',
        message: '当前本机无法打开目录选择器',
      });
      return;
    }
    if (!repositoryPath) {
      await this.completeFailure(session, request, {
        outcome: 'FAILED',
        code: 'CANCELLED',
        message: '已取消选择仓库目录',
      });
      return;
    }

    let repositoryUrl: string | null;
    try {
      repositoryUrl = await this.repositories.origin(repositoryPath);
    } catch (error) {
      const code =
        error instanceof RepositoryError ? error.code : 'NOT_GIT_REPOSITORY';
      await this.completeFailure(session, request, {
        outcome: 'FAILED',
        code,
        message:
          code === 'INVALID_DIRECTORY'
            ? '所选仓库目录无效'
            : '所选目录不是可用的 Git 仓库',
      });
      return;
    }
    if (!repositoryUrl) {
      await this.completeFailure(session, request, {
        outcome: 'FAILED',
        code: 'MISSING_REMOTE',
        message: '所选仓库缺少 remote origin',
      });
      return;
    }

    try {
      await this.state.bind(request.bindingId, repositoryPath);
    } catch {
      await this.completeFailure(session, request, {
        outcome: 'FAILED',
        code: 'LOCAL_STATE_FAILED',
        message: '无法安全保存本机仓库绑定',
      });
      return;
    }

    const result = await this.completeWithRetry(session, request, {
      outcome: 'SUCCEEDED',
      repositoryUrl,
    });
    if (result === 'FAILED') await this.state.removeBinding(request.bindingId);
  }

  private async completeFailure(
    session: AuthenticatedRunnerSession,
    request: RunnerBindingWork,
    completion: RunnerBindingWorkCompletion,
  ): Promise<void> {
    await this.completeWithRetry(session, request, completion);
  }

  private async completeWithRetry(
    session: AuthenticatedRunnerSession,
    request: RunnerBindingWork,
    completion: RunnerBindingWorkCompletion,
  ): Promise<'SUCCEEDED' | 'FAILED'> {
    while (!this.stopped) {
      try {
        return await this.http.completeBindingWork(
          session.serverOrigin,
          session.credential,
          request.requestId,
          completion,
        );
      } catch (error) {
        this.connection.reportConnectionError(error);
        await this.clock.sleep(this.pollIntervalMs);
      }
    }
    return 'FAILED';
  }
}
