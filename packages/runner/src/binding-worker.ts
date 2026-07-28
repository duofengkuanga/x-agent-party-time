import type {
  RunnerBindingWork,
  RunnerBindingWorkCompletion,
} from '@agent-party-time/runner-contract';
import { RunnerClient } from './client';
import {
  MacOSDirectorySelector,
  type DirectorySelector,
} from './directory-selector';
import { readRepositoryOrigin } from './repository-origin';
import { RunnerStateStore } from './state';

type BindingClient = Pick<
  RunnerClient,
  'claimBindingWork' | 'completeBindingWork' | 'listServerBindings'
>;
type BindingOutput = Pick<Console, 'log'>;

export class AgentBindingWorker {
  private stopped = false;

  constructor(
    private readonly client: BindingClient = new RunnerClient(),
    private readonly state: RunnerStateStore = new RunnerStateStore(),
    private readonly selector: DirectorySelector = new MacOSDirectorySelector(),
    private readonly repositoryOrigin: (
      path: string,
    ) => Promise<string | null> = readRepositoryOrigin,
    private readonly wait: (durationMs: number) => Promise<void> = sleep,
    private readonly output: BindingOutput = console,
  ) {}

  async run(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        await this.cycle();
      } catch {
        this.output.log('Agent 绑定同步暂时失败，将自动重试。');
      }
      if (!this.stopped) await this.wait(1_000);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async cycle(): Promise<boolean> {
    const serverBindings = await this.client.listServerBindings();
    const removed = await this.state.pruneBindings(
      serverBindings.map(({ bindingId }) => bindingId),
    );
    if (removed.length)
      this.output.log(`已清理 ${removed.length} 个失效的本机工程绑定。`);

    const request = await this.client.claimBindingWork();
    if (!request) return false;
    await this.process(request);
    return true;
  }

  private async process(request: RunnerBindingWork): Promise<void> {
    let repositoryPath: string | null;
    try {
      repositoryPath = await this.selector.selectDirectory();
    } catch {
      await this.completeFailure(request, {
        outcome: 'FAILED',
        code: 'UNSUPPORTED_PLATFORM',
        message: '当前本机无法打开目录选择器',
      });
      return;
    }
    if (!repositoryPath) {
      await this.completeFailure(request, {
        outcome: 'FAILED',
        code: 'CANCELLED',
        message: '已取消选择仓库目录',
      });
      return;
    }

    let repositoryUrl: string | null;
    try {
      repositoryUrl = await this.repositoryOrigin(repositoryPath);
    } catch {
      await this.completeFailure(request, {
        outcome: 'FAILED',
        code: 'NOT_GIT_REPOSITORY',
        message: '所选目录不是可用的 Git 仓库',
      });
      return;
    }
    if (!repositoryUrl) {
      await this.completeFailure(request, {
        outcome: 'FAILED',
        code: 'MISSING_REMOTE',
        message: '所选仓库缺少 remote origin',
      });
      return;
    }

    try {
      await this.state.bind(request.bindingId, repositoryPath);
    } catch {
      await this.completeFailure(request, {
        outcome: 'FAILED',
        code: 'LOCAL_STATE_FAILED',
        message: '无法安全保存本机仓库绑定',
      });
      return;
    }

    while (!this.stopped) {
      try {
        const state = await this.client.completeBindingWork(request.requestId, {
          outcome: 'SUCCEEDED',
          repositoryUrl,
        });
        if (state === 'FAILED')
          await this.state.removeBinding(request.bindingId);
        return;
      } catch {
        await this.wait(1_000);
      }
    }
  }

  private async completeFailure(
    request: RunnerBindingWork,
    completion: RunnerBindingWorkCompletion,
  ): Promise<void> {
    while (!this.stopped) {
      try {
        await this.client.completeBindingWork(request.requestId, completion);
        return;
      } catch {
        await this.wait(1_000);
      }
    }
  }
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
