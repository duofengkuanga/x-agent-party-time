import { RunnerClient } from './client';
import { RunnerStateStore } from './state';

type Output = Pick<Console, 'log'>;

export async function runRunnerCli(
  args: string[],
  dependencies: {
    client?: RunnerClient;
    state?: RunnerStateStore;
    output?: Output;
  } = {},
): Promise<void> {
  const client = dependencies.client ?? new RunnerClient();
  const state = dependencies.state ?? new RunnerStateStore();
  const output = dependencies.output ?? console;
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
      const [bindingId, repositoryPath] = rest;
      if (!bindingId || !repositoryPath)
        throw new Error('用法：runner bind <bindingId> <本机绝对路径>');
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
    default:
      output.log(
        [
          'Agent Party Time Runner',
          '  pair --server <服务端地址> --code <配对码> --name <名称>',
          '  heartbeat',
          '  bind <bindingId> <本机绝对路径>',
          '  bindings',
        ].join('\n'),
      );
  }
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}
