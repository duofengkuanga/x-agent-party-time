import { expect, test } from 'bun:test';
import type {
  CommandResult,
  CommandRunner,
  UserEnvironment,
} from '../contracts';
import { MacOsLaunchAgent } from './launch-agent';

test('launchctl Adapter 只操作当前用户 domain 和明确 Label', async () => {
  const commands = new RecordingCommands();
  const launchAgent = new MacOsLaunchAgent(commands, environment());

  await launchAgent.register('/tmp/com.agentpartytime.xapt.daemon.plist');
  await launchAgent.start('com.agentpartytime.xapt.daemon');
  await launchAgent.stop('com.agentpartytime.xapt.daemon');
  await launchAgent.unregister('/tmp/com.agentpartytime.xapt.daemon.plist');

  expect(commands.calls).toEqual([
    [
      '/bin/launchctl',
      'bootstrap',
      'gui/501',
      '/tmp/com.agentpartytime.xapt.daemon.plist',
    ],
    ['/bin/launchctl', 'kickstart', 'gui/501/com.agentpartytime.xapt.daemon'],
    [
      '/bin/launchctl',
      'kill',
      'SIGTERM',
      'gui/501/com.agentpartytime.xapt.daemon',
    ],
    [
      '/bin/launchctl',
      'bootout',
      'gui/501',
      '/tmp/com.agentpartytime.xapt.daemon.plist',
    ],
  ]);
});

class RecordingCommands implements CommandRunner {
  readonly calls: string[][] = [];

  async run(
    executable: string,
    args: readonly string[],
  ): Promise<CommandResult> {
    this.calls.push([executable, ...args]);
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

function environment(): UserEnvironment {
  return {
    homeDirectory: () => '/tmp/home',
    userId: () => 501,
    platform: () => 'darwin',
    architecture: () => 'arm64',
    isTerminal: () => false,
  };
}
