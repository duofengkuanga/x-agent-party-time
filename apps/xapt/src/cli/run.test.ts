import { describe, expect, test } from 'bun:test';
import type { DaemonSnapshot } from '../daemon/status';
import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  runCli,
  type BugsDeleteInput,
  type CliRuntime,
} from './run';

describe('runCli', () => {
  test('renders only the confirmed public command tree', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(result.stdout).toContain('daemon connect <server-url>');
    expect(result.stdout).toContain('uninstall [--force]');
    expect(result.stdout).toContain('skills update');
    expect(result.stdout).not.toMatch(
      /internal-daemon|pair|heartbeat|bindings|daemon logs|daemon restart/,
    );
    expect(result.stderr).toBeUndefined();
  });

  test('renders xapt and minimum Codex versions', async () => {
    expect(await runCli(['--version'])).toEqual({
      exitCode: EXIT_SUCCESS,
      stdout: 'xapt 0.3.5\n最低 Codex 版本 0.145.0',
    });
  });

  test.each([[[]], [['--help']], [['--version']]] as const)(
    'successful command %j uses exit code 0',
    async (args) => {
      expect((await runCli(args)).exitCode).toBe(EXIT_SUCCESS);
    },
  );

  test.each([
    [['daemon', 'start']],
    [['daemon', 'connect', 'https://apt.example.com']],
    [['daemon', 'stop']],
    [['daemon', 'stop', '--force']],
    [['daemon', 'status']],
    [['update']],
    [['uninstall']],
    [['uninstall', '--force']],
    [['bugs', 'delete', '944d519c-1ed0-4711-a3b1-325bec5bbe56']],
    [['skills', 'update']],
    [['internal-daemon']],
  ] as const)(
    'recognized but unimplemented command %j fails explicitly',
    async (args) => {
      const result = await runCli(args);

      expect(result.exitCode).toBe(EXIT_FAILURE);
      expect(result.stderr).toContain('尚未实现');
      expect(result.stdout).toBeUndefined();
    },
  );

  test.each([
    [['unknown']],
    [['daemon']],
    [['daemon', 'connect']],
    [['daemon', 'status', '--json']],
    [['update', '--force']],
    [['uninstall', '--keep-data']],
  ] as const)(
    'invalid command %j uses exit code 2 and a next step',
    async (args) => {
      const result = await runCli(args);

      expect(result.exitCode).toBe(EXIT_USAGE);
      expect(result.stderr).toContain('下一步：运行 xapt --help');
      expect(result.stdout).toBeUndefined();
    },
  );

  test('default output does not expose sensitive values', async () => {
    const output = [
      (await runCli(['--help'])).stdout,
      (await runCli(['--version'])).stdout,
      (await runCli(['unknown'])).stderr,
    ].join('\n');

    expect(output).not.toMatch(
      /credential|bearer|prompt|attachment|\/Users\/|bindingId|runnerId/i,
    );
  });

  test('daemon runtime 渲染未连接状态、幂等启动和停止', async () => {
    const runtime = fakeRuntime(runningSnapshot('UNCONFIGURED'));

    expect(await runCli(['daemon', 'start'], runtime)).toMatchObject({
      exitCode: EXIT_SUCCESS,
      stdout: expect.stringContaining('daemon 已启动'),
    });
    const status = await runCli(['daemon', 'status'], runtime);
    expect(status.exitCode).toBe(EXIT_FAILURE);
    expect(status.stdout).toContain('尚未连接');
    expect(status.stdout).toContain('下一步：xapt daemon connect');
    expect(status.stdout).not.toMatch(/credential|runnerId|\/Users\//i);
    expect(await runCli(['daemon', 'stop'], runtime)).toMatchObject({
      exitCode: EXIT_SUCCESS,
      stdout: 'xapt daemon 已安全停止。',
    });
  });

  test('daemon start 不因首次 Skill 安装失败而失败', async () => {
    const runtime = fakeRuntime(runningSnapshot('UNCONFIGURED'));
    runtime.daemonStart = async () => ({
      snapshot: runningSnapshot('UNCONFIGURED'),
      alreadyRunning: false,
      skillWarning: 'Skill 未安装：GitHub 不可用',
    });

    const result = await runCli(['daemon', 'start'], runtime);

    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(result.stdout).toContain('daemon 已启动');
    expect(result.stdout).toContain('警告：Skill 未安装');
  });

  test('skills update 渲染确定 source revision', async () => {
    const runtime = fakeRuntime(runningSnapshot('CONNECTED'));
    runtime.skillsUpdate = async () => ({
      updated: true,
      sourceRevision: 'a'.repeat(40),
    });

    const result = await runCli(['skills', 'update'], runtime);

    expect(result).toEqual({
      exitCode: EXIT_SUCCESS,
      stdout: `Agent Party Time Skills 已更新（${'a'.repeat(40)}）。`,
    });
  });

  test('已连接且健康的 status 使用退出码 0', async () => {
    const result = await runCli(
      ['daemon', 'status'],
      fakeRuntime(runningSnapshot('CONNECTED')),
    );
    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(result.stdout).toContain('已连接');
    expect(result.stdout).toContain('Agent          测试 Agent');
    expect(result.stdout).toMatch(/最近心跳\s+\d+ (?:秒|分钟|小时)前/u);
  });

  test('connect 立即输出授权 URL 和指纹，然后报告成功', async () => {
    const lines: string[] = [];
    const result = await runCli(
      ['daemon', 'connect', 'https://apt.example.com'],
      fakeRuntime(runningSnapshot('UNCONFIGURED')),
      (line) => lines.push(line),
    );

    expect(lines).toEqual([
      expect.stringMatching(
        /已打开浏览器授权页面：[\s\S]+请核对指纹：ABCD-EF12-3456/,
      ),
    ]);
    expect(result).toEqual({
      exitCode: EXIT_SUCCESS,
      stdout: 'Agent 已授权并连接 Server。',
    });
  });

  test('daemon stop --force 交给运行时执行真实 TTY 安全检查', async () => {
    let force = false;
    const runtime = fakeRuntime(runningSnapshot('CONNECTED'));
    runtime.daemonStop = async (value) => {
      force = value;
      return { alreadyStopped: false };
    };

    const result = await runCli(['daemon', 'stop', '--force'], runtime);

    expect(force).toBe(true);
    expect(result.exitCode).toBe(EXIT_SUCCESS);
  });

  test('bugs delete 传递参数并渲染删除结果', async () => {
    let input: BugsDeleteInput | undefined;
    const runtime = fakeRuntime(runningSnapshot('CONNECTED'));
    runtime.bugsDelete = async (value) => {
      input = value;
      return {
        deletedBugIds: ['944d519c-1ed0-4711-a3b1-325bec5bbe56'],
        deletedExecutionIds: ['00000000-0000-4000-8000-000000000001'],
      };
    };

    const result = await runCli(
      ['bugs', 'delete', '944d519c-1ed0-4711-a3b1-325bec5bbe56', '--force'],
      runtime,
    );

    expect(input).toEqual({
      bugIds: ['944d519c-1ed0-4711-a3b1-325bec5bbe56'],
      all: false,
      force: true,
    });
    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(result.stdout).toContain('已删除缺陷 1 个');
    expect(result.stdout).toContain('已删除关联 Execution 1 个');
    expect(result.stdout).not.toMatch(/credential|runnerId|\/Users\//i);
  });
});

function fakeRuntime(snapshot: DaemonSnapshot): CliRuntime {
  return {
    daemonStart: async () => ({ snapshot, alreadyRunning: false }),
    daemonStatus: async () => snapshot,
    daemonConnect: async (_serverUrl, progress) => {
      progress({
        authorizationUrl:
          'https://apt.example.com/cooking/agents/connect?request=req_1',
        fingerprint: 'ABCD-EF12-3456',
        browserOpened: true,
      });
      return { ...snapshot, connection: 'CONNECTED' };
    },
    daemonStop: async () => ({ alreadyStopped: false }),
    update: async () => ({
      updated: false,
      version: '0.1.0',
      daemonRestarted: false,
    }),
    uninstall: async () => ({ remoteRevoked: true, warnings: [] }),
    bugsDelete: async () => ({ deletedBugIds: [], deletedExecutionIds: [] }),
    skillsUpdate: async () => ({
      updated: false,
      sourceRevision: 'a'.repeat(40),
    }),
    internalDaemon: async () => {},
  };
}

function runningSnapshot(
  connection: DaemonSnapshot['connection'],
): DaemonSnapshot {
  return {
    service: 'RUNNING',
    connection,
    activity: 'IDLE',
    version: '0.1.0',
    codexVersion: '0.146.0',
    serverOrigin: connection === 'CONNECTED' ? 'https://apt.example.com' : null,
    agentName: connection === 'CONNECTED' ? '测试 Agent' : null,
    lastHeartbeatAt:
      connection === 'CONNECTED' ? new Date().toISOString() : null,
    activeSlots: 0,
    totalSlots: 3,
    waitingInteractions: 0,
    outboxCount: 0,
    bindingCount: 0,
    bindingActive: false,
  };
}
