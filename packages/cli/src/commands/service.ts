import {
  ShutdownServiceCommandSchema,
  ShutdownServiceResultSchema,
  ServiceStatusQuerySchema,
  ServiceStatusResultSchema,
} from '@agent-party-time/shared';
import { startLocalService } from '@agent-party-time/local-service';
import { optionNumber, optionString, parseArgs } from '../args.js';
import type { ServiceClient } from '../client/service-client.js';
import type { Output } from '../output.js';

export async function runServiceCommand(
  action: string,
  args: readonly string[],
  client: ServiceClient,
  output: Output,
): Promise<void> {
  const parsed = parseArgs(args);
  if (action === 'start') {
    const handle = await startLocalService({
      homeDirectory: optionString(parsed, 'home'),
      apiHost: optionString(parsed, 'host'),
      apiPort: optionNumber(parsed, 'port'),
      logLevel: optionString(parsed, 'log-level') as never,
      controlPlaneUrl: optionString(parsed, 'control-plane'),
      runnerName: optionString(parsed, 'runner-name'),
      codexExecutable: optionString(parsed, 'codex-executable'),
    });
    output.success(
      `Agent Party Time 已启动\ninstance: ${handle.instanceId}\nAPI: ${handle.address()}`,
    );
    const signalStop = new Promise<void>((resolve) => {
      const stop = (signal: string) =>
        void handle.shutdown(signal).then(resolve);
      process.once('SIGINT', () => stop('SIGINT'));
      process.once('SIGTERM', () => stop('SIGTERM'));
    });
    await Promise.race([signalStop, handle.waitUntilStopped()]);
    return;
  }
  if (action === 'status') {
    output.value(
      await client.query(
        'service.status',
        ServiceStatusQuerySchema,
        ServiceStatusResultSchema,
        {},
      ),
    );
    return;
  }
  if (action === 'stop') {
    await client.request(
      'service.shutdown',
      ShutdownServiceCommandSchema,
      ShutdownServiceResultSchema,
      { reason: optionString(parsed, 'reason') ?? 'CLI stop' },
    );
    await client.waitUntilUnavailable(optionNumber(parsed, 'timeout', 30_000));
    output.success('服务已停止');
    return;
  }
  throw new Error(`未知 service 命令: ${action}`);
}
