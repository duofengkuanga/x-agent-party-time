import type {
  Clock,
  ForceConfirmation,
  LaunchAgent,
  UserEnvironment,
} from '../platform/contracts';
import type { LocalFileSystem } from '../platform/files';
import { XAPT_LAUNCH_AGENT_LABEL, type XaptPaths } from '../platform/paths';
import type { LocalStateStore } from '../state/store';
import { XAPT_VERSION } from '../version';
import type { CodexPreflight } from './codex';
import type { DaemonControlClient } from './control';
import {
  stoppedSnapshot,
  type DaemonSnapshot,
  unresponsiveSnapshot,
} from './status';

export interface DaemonManagerOptions {
  paths: XaptPaths;
  files: LocalFileSystem;
  state: LocalStateStore;
  launchAgent: LaunchAgent;
  codex: CodexPreflight;
  control: Pick<DaemonControlClient, 'status' | 'stop'>;
  confirmation: ForceConfirmation;
  clock: Clock;
  environment: UserEnvironment;
  stableExecutable: string;
  startupTimeoutMs?: number;
}

export class DaemonManager {
  constructor(private readonly options: DaemonManagerOptions) {}

  async start(): Promise<{
    snapshot: DaemonSnapshot;
    alreadyRunning: boolean;
  }> {
    if (
      this.options.environment.platform() !== 'darwin' ||
      this.options.environment.architecture() !== 'arm64'
    )
      throw new DaemonLifecycleError(
        'UNSUPPORTED_PLATFORM',
        'xapt 0.x 只支持 Apple Silicon macOS',
        '请在 macOS arm64 设备上运行',
      );
    const socket = await this.options.files.info(
      this.options.paths.controlSocket,
    );
    if (socket) {
      if (socket.type !== 'socket')
        throw new DaemonLifecycleError(
          'SOCKET_OCCUPIED',
          '本机服务通信文件被未知文件占用',
        );
      try {
        return {
          snapshot: await this.options.control.status(),
          alreadyRunning: true,
        };
      } catch {
        throw new DaemonLifecycleError(
          'UNRESPONSIVE',
          '本机服务已存在但无响应',
          '请运行 xapt daemon stop --force',
        );
      }
    }

    const executable = await this.options.files.info(
      this.options.stableExecutable,
    );
    if (
      !executable ||
      executable.type !== 'file' ||
      (executable.mode & 0o111) === 0
    )
      throw new DaemonLifecycleError(
        'EXECUTABLE_MISSING',
        'xapt 稳定执行入口不可用',
        '请重新安装 xapt 后重试',
      );

    await this.options.codex.check();
    await this.options.state.initialize();
    await this.options.state.preflight();
    await prepareDaemonLogs(this.options.files, this.options.paths);
    await this.options.files.writeAtomic(
      this.options.paths.launchAgentPlist,
      launchAgentPlist(this.options.paths, this.options.stableExecutable),
      0o644,
      0o700,
    );
    await this.options.launchAgent.register(
      this.options.paths.launchAgentPlist,
    );
    try {
      await this.options.launchAgent.start(XAPT_LAUNCH_AGENT_LABEL);
      return {
        snapshot: await this.waitUntilReady(),
        alreadyRunning: false,
      };
    } catch (error) {
      try {
        await this.options.launchAgent.unregister(
          this.options.paths.launchAgentPlist,
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          '本机服务启动失败，且启动项清理失败',
        );
      }
      throw error;
    }
  }

  async status(): Promise<DaemonSnapshot> {
    const socket = await this.options.files.info(
      this.options.paths.controlSocket,
    );
    if (!socket) return stoppedSnapshot(XAPT_VERSION);
    if (socket.type !== 'socket') return unresponsiveSnapshot(XAPT_VERSION);
    try {
      return await this.options.control.status();
    } catch {
      return unresponsiveSnapshot(XAPT_VERSION);
    }
  }

  async stop(
    force = false,
    forceAlreadyConfirmed = false,
  ): Promise<{ alreadyStopped: boolean }> {
    if (force && !forceAlreadyConfirmed) {
      if (!this.options.environment.isTerminal())
        throw new DaemonLifecycleError(
          'TTY_REQUIRED',
          'xapt daemon stop --force 只允许在真实终端中执行',
        );
      if (
        !(await this.options.confirmation.confirm(
          '强制停止可能遗留任务领取状态、本机工作区和远程状态。',
        ))
      )
        throw new DaemonLifecycleError('CANCELLED', '已取消强制停止');
    }
    const socket = await this.options.files.info(
      this.options.paths.controlSocket,
    );
    if (!socket) {
      await this.options.launchAgent.unregister(
        this.options.paths.launchAgentPlist,
      );
      return { alreadyStopped: true };
    }
    if (socket.type !== 'socket')
      throw new DaemonLifecycleError(
        'SOCKET_OCCUPIED',
        'control socket 位置被未知文件占用',
      );
    let snapshot: DaemonSnapshot;
    try {
      snapshot = await this.options.control.status();
    } catch {
      if (force) {
        await this.forceStopLaunchAgent();
        return { alreadyStopped: false };
      }
      throw new DaemonLifecycleError(
        'UNRESPONSIVE',
        '本机服务无响应',
        '请运行 xapt daemon stop --force',
      );
    }
    if (snapshot.outboxCount > 0 && !force)
      throw new DaemonLifecycleError(
        'BUSY',
        `daemon 仍有 ${snapshot.outboxCount} 条未发送 Outcome，不能安全停止`,
      );
    if (snapshot.activity === 'BUSY' && !force)
      throw new DaemonLifecycleError(
        'BUSY',
        '本机服务正在处理任务，不能安全停止',
      );
    await this.options.control.stop(force);
    await this.waitUntilStopped();
    await this.options.launchAgent.unregister(
      this.options.paths.launchAgentPlist,
    );
    return { alreadyStopped: false };
  }

  private async forceStopLaunchAgent(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.options.launchAgent.stop(XAPT_LAUNCH_AGENT_LABEL);
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.options.launchAgent.unregister(
        this.options.paths.launchAgentPlist,
      );
    } catch (error) {
      errors.push(error);
    }
    const socket = await this.options.files.info(
      this.options.paths.controlSocket,
    );
    if (socket?.type === 'socket')
      await this.options.files.remove(this.options.paths.controlSocket);
    if (errors.length > 0)
      throw new AggregateError(errors, '强制停止 LaunchAgent 未完整完成');
  }

  private async waitUntilReady(): Promise<DaemonSnapshot> {
    const deadline =
      this.options.clock.now().getTime() +
      (this.options.startupTimeoutMs ?? 5_000);
    let lastError: unknown;
    do {
      try {
        return await this.options.control.status();
      } catch (error) {
        lastError = error;
        await this.options.clock.sleep(50);
      }
    } while (this.options.clock.now().getTime() < deadline);
    throw new DaemonLifecycleError(
      'START_TIMEOUT',
      '本机服务启动后未能完成本机连接',
      '请查看 xapt 本机服务错误日志后重试',
      lastError,
    );
  }

  private async waitUntilStopped(): Promise<void> {
    const deadline = this.options.clock.now().getTime() + 2_000;
    do {
      if (!(await this.options.files.info(this.options.paths.controlSocket)))
        return;
      await this.options.clock.sleep(25);
    } while (this.options.clock.now().getTime() < deadline);
    throw new DaemonLifecycleError(
      'STOP_TIMEOUT',
      '本机服务未在超时前停止',
      '请运行 xapt daemon stop --force',
    );
  }
}

export function launchAgentPlist(
  paths: XaptPaths,
  stableExecutable: string,
): string {
  const escape = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${XAPT_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(stableExecutable)}</string>
    <string>internal-daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${escape(paths.home)}</string>
    <key>PATH</key><string>${escape(`${paths.home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escape(paths.daemonLog)}</string>
  <key>StandardErrorPath</key><string>${escape(paths.daemonErrorLog)}</string>
</dict>
</plist>
`;
}

async function prepareDaemonLogs(
  files: LocalFileSystem,
  paths: XaptPaths,
): Promise<void> {
  await files.ensureDirectory(paths.logs, 0o700);
  for (const path of [paths.daemonLog, paths.daemonErrorLog]) {
    const info = await files.info(path);
    if (!info || info.size > 5 * 1024 * 1024)
      await files.writeAtomic(path, '', 0o600);
  }
}

export type DaemonLifecycleErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'SOCKET_OCCUPIED'
  | 'UNRESPONSIVE'
  | 'EXECUTABLE_MISSING'
  | 'BUSY'
  | 'TTY_REQUIRED'
  | 'CANCELLED'
  | 'START_TIMEOUT'
  | 'STOP_TIMEOUT';

export class DaemonLifecycleError extends Error {
  constructor(
    readonly code: DaemonLifecycleErrorCode,
    message: string,
    nextStep = '请运行 xapt daemon status 检查状态',
    cause?: unknown,
  ) {
    super(`${message}。下一步：${nextStep}。`, { cause });
    this.name = 'DaemonLifecycleError';
  }
}
