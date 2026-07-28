import { isAbsolute } from 'node:path';
import { normalizeRepositoryUrl } from '@agent-party-time/runner-contract';
import { RunnerClient } from './client';
import { AgentAuthorization } from './authorization';
import { AgentBindingWorker } from './binding-worker';
import { RunnerWorker } from './worker';
import { RunnerStateStore } from './state';
import { readRepositoryOrigin } from './repository-origin';
import { normalizeServerUrl } from './server-url';

type Output = Pick<Console, 'log'>;

export async function runRunnerCli(
  args: string[],
  dependencies: {
    client?: RunnerClient;
    state?: RunnerStateStore;
    output?: Output;
    repositoryOrigin?: (path: string) => Promise<string | null>;
    authorization?: Pick<AgentAuthorization, 'ensureAuthorized'>;
    bindingWorker?: Pick<AgentBindingWorker, 'run' | 'stop'>;
  } = {},
): Promise<void> {
  const client = dependencies.client ?? new RunnerClient();
  const state = dependencies.state ?? new RunnerStateStore();
  const output = dependencies.output ?? console;
  const repositoryOrigin =
    dependencies.repositoryOrigin ?? readRepositoryOrigin;
  const [command, ...rest] = args;
  switch (command) {
    case 'pair': {
      const serverUrl = option(rest, '--server');
      const code = option(rest, '--code');
      const name = option(rest, '--name');
      const runner = await client.pair({ serverUrl, code, name });
      output.log(`Runner “${runner.name}” 已配对，Runner 标识：${runner.id}`);
      return;
    }
    case 'heartbeat': {
      const runner = await client.heartbeat();
      output.log(`心跳已发送：${runner.name}`);
      return;
    }
    case 'bind': {
      const [bindingId, repositoryPath, manualRepositoryUrl] = rest;
      if (!bindingId || !repositoryPath)
        throw new Error(
          '用法：runner bind <bindingId> <本机绝对路径> [仓库地址]',
        );
      if (!isAbsolute(repositoryPath))
        throw new Error('仓库路径必须是本机绝对路径');
      const discoveredOrigin = await repositoryOrigin(repositoryPath);
      if (!discoveredOrigin && !manualRepositoryUrl)
        throw new Error(
          '本机仓库没有可用的 remote.origin.url；可在命令末尾手工提供仓库地址',
        );
      const origin =
        discoveredOrigin ?? normalizeRepositoryUrl(manualRepositoryUrl!);
      await client.confirmBinding(bindingId, origin);
      const binding = await state.bind(bindingId, repositoryPath);
      output.log(`已登记绑定：${binding.bindingId}`);
      return;
    }
    case 'bindings': {
      const bindings = await state.listBindings();
      if (!bindings.length) {
        output.log('尚未登记本机绑定。');
        return;
      }
      for (const binding of bindings) output.log(binding.bindingId);
      return;
    }
    case 'start': {
      const concurrencyValue = optional(rest, '--concurrency') ?? '1';
      const concurrency = Number(concurrencyValue);
      if (
        !Number.isSafeInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > 32
      )
        throw new Error('--concurrency 必须是 1 到 32 的整数');
      const serverUrl = normalizeServerUrl(
        optional(rest, '--server') ??
          process.env.AGENT_PARTY_TIME_SERVER_URL ??
          'http://localhost:3000',
      );
      const authorization =
        dependencies.authorization ??
        new AgentAuthorization(
          client,
          state,
          undefined,
          undefined,
          undefined,
          undefined,
          output,
        );
      await authorization.ensureAuthorized(serverUrl);
      const worker = new RunnerWorker(
        client,
        state,
        undefined,
        undefined,
        undefined,
        concurrency,
        {
          log: (line) => output.log(line),
          error: (line) => output.log(line),
        },
      );
      output.log(`Agent 已启动，并发数：${concurrency}`);
      const bindingWorker =
        dependencies.bindingWorker ??
        new AgentBindingWorker(
          client,
          state,
          undefined,
          undefined,
          undefined,
          output,
        );
      const bindingTask = bindingWorker.run();
      try {
        await worker.run();
      } finally {
        bindingWorker.stop();
        await bindingTask;
      }
      return;
    }
    default:
      output.log(
        [
          'Agent Party Time Runner',
          '  pair --server <服务端地址> --code <配对码> --name <名称>',
          '  heartbeat',
          '  bind <bindingId> <本机绝对路径> [仓库地址]',
          '  bindings',
          '  start [--server <服务端地址>] [--concurrency <1-32>]',
        ].join('\n'),
      );
  }
}

function optional(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}
