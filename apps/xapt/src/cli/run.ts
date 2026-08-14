import type { DaemonSnapshot } from '../daemon/status';
import type { ConnectionProgress } from '../daemon/connection';
import { isDaemonHealthy } from '../daemon/status';
import { CliUsageError, parseCommand } from './command';
import {
  HELP_TEXT,
  renderNotImplemented,
  renderUsageError,
  renderVersion,
} from './render';

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface BugsDeleteInput {
  bugIds: readonly string[];
  all: boolean;
  force: boolean;
}

export interface BugsDeleteResult {
  deletedBugIds: string[];
  deletedExecutionIds: string[];
}

export interface CliRuntime {
  daemonStart(): Promise<{
    snapshot: DaemonSnapshot;
    alreadyRunning: boolean;
    skillWarning?: string | null;
  }>;
  daemonStatus(): Promise<DaemonSnapshot>;
  daemonConnect(
    serverUrl: string,
    progress: (value: ConnectionProgress) => void,
  ): Promise<DaemonSnapshot>;
  daemonStop(force: boolean): Promise<{ alreadyStopped: boolean }>;
  update(): Promise<{
    updated: boolean;
    version: string;
    daemonRestarted: boolean;
  }>;
  uninstall(force: boolean): Promise<{
    remoteRevoked: boolean;
    warnings: string[];
  }>;
  bugsDelete(input: BugsDeleteInput): Promise<BugsDeleteResult>;
  skillsUpdate(): Promise<{
    updated: boolean;
    sourceRevision: string;
  }>;
  internalDaemon(): Promise<void>;
}

export async function runCli(
  args: readonly string[],
  runtime?: CliRuntime,
  progressOutput: (line: string) => void = () => undefined,
): Promise<CliResult> {
  try {
    const command = parseCommand(args);
    switch (command.kind) {
      case 'help':
        return { exitCode: EXIT_SUCCESS, stdout: HELP_TEXT };
      case 'version':
        return { exitCode: EXIT_SUCCESS, stdout: renderVersion() };
      case 'daemon-connect':
        if (!runtime)
          return notImplemented(`daemon connect ${command.serverUrl}`);
        await runtime.daemonConnect(command.serverUrl, (progress) => {
          progressOutput(
            [
              progress.browserOpened
                ? '已打开浏览器授权页面：'
                : '无法自动打开浏览器，请手动访问：',
              progress.authorizationUrl,
              `请核对指纹：${progress.fingerprint}`,
            ].join('\n'),
          );
        });
        return {
          exitCode: EXIT_SUCCESS,
          stdout: 'Agent 已授权并连接 Server。',
        };
      case 'daemon-start': {
        if (!runtime) return notImplemented('daemon start');
        const result = await runtime.daemonStart();
        const message = result.alreadyRunning
          ? 'xapt daemon 已在运行。'
          : 'xapt daemon 已启动，但尚未连接 Server。\n下一步：xapt daemon connect <server-url>';
        return {
          exitCode: EXIT_SUCCESS,
          stdout: result.skillWarning
            ? `${message}\n警告：${result.skillWarning}`
            : message,
        };
      }
      case 'daemon-stop': {
        if (!runtime) return notImplemented('daemon stop');
        const result = await runtime.daemonStop(command.force);
        return {
          exitCode: EXIT_SUCCESS,
          stdout: result.alreadyStopped
            ? 'xapt daemon 已停止。'
            : 'xapt daemon 已安全停止。',
        };
      }
      case 'daemon-status': {
        if (!runtime) return notImplemented('daemon status');
        const snapshot = await runtime.daemonStatus();
        return {
          exitCode: isDaemonHealthy(snapshot) ? EXIT_SUCCESS : EXIT_FAILURE,
          stdout: renderDaemonStatus(snapshot),
        };
      }
      case 'bugs-delete': {
        if (!runtime) return notImplemented('bugs delete');
        const result = await runtime.bugsDelete({
          bugIds: command.bugIds,
          all: command.all,
          force: command.force,
        });
        return {
          exitCode: EXIT_SUCCESS,
          stdout: renderBugsDeleteResult(result),
        };
      }
      case 'skills-update': {
        if (!runtime) return notImplemented('skills update');
        const result = await runtime.skillsUpdate();
        return {
          exitCode: EXIT_SUCCESS,
          stdout: result.updated
            ? `Agent Party Time Skills 已更新（${result.sourceRevision}）。`
            : `Agent Party Time Skills 已是当前 main（${result.sourceRevision}）。`,
        };
      }
      case 'uninstall':
        if (!runtime) return notImplemented('uninstall');
        {
          progressOutput(
            '将删除 xapt 程序、版本、LaunchAgent、Credential、本机状态、Cache 与日志；不会修改 Codex 或 ~/.codex。',
          );
          const result = await runtime.uninstall(command.force);
          return {
            exitCode: EXIT_SUCCESS,
            stdout: [
              'xapt 已卸载；Codex 与 ~/.codex 未被修改。',
              ...result.warnings.map((warning) => `警告：${warning}`),
            ].join('\n'),
          };
        }
      case 'update':
        if (!runtime) return notImplemented('update');
        {
          const result = await runtime.update();
          return {
            exitCode: EXIT_SUCCESS,
            stdout: result.updated
              ? `xapt 已更新到 ${result.version}${result.daemonRestarted ? '，daemon 已恢复运行' : ''}。`
              : `xapt ${result.version} 已是最新稳定版本。`,
          };
        }
      case 'internal-daemon': {
        if (!runtime) return notImplemented('内部 daemon 入口');
        await runtime.internalDaemon();
        return { exitCode: EXIT_SUCCESS };
      }
    }
  } catch (error) {
    if (error instanceof CliUsageError)
      return { exitCode: EXIT_USAGE, stderr: renderUsageError(error.message) };
    return { exitCode: EXIT_FAILURE, stderr: safeRuntimeError(error) };
  }
}

function notImplemented(command: string): CliResult {
  return {
    exitCode: EXIT_FAILURE,
    stderr: renderNotImplemented(command),
  };
}

function renderBugsDeleteResult(result: BugsDeleteResult): string {
  const lines = [
    result.deletedBugIds.length > 0
      ? `已删除缺陷 ${result.deletedBugIds.length} 个：${result.deletedBugIds.join('、')}`
      : '没有需要删除的缺陷。',
    `已删除关联 Execution ${result.deletedExecutionIds.length} 个。`,
  ];
  return lines.join('\n');
}

function renderDaemonStatus(snapshot: DaemonSnapshot): string {
  const service = {
    STOPPED: '已停止',
    RUNNING: '正在运行',
    UNRESPONSIVE: '无响应',
  }[snapshot.service];
  const connection = {
    UNCONFIGURED: '尚未连接',
    CONNECTING: '连接中',
    CONNECTED: '已连接',
    DEGRADED: '连接降级',
    REVOKED: 'Credential 已撤销',
  }[snapshot.connection];
  const lines = [
    `Daemon        ${service}`,
    `版本          ${snapshot.version}`,
    `Codex         ${snapshot.codexVersion ?? '不可用'}`,
    `连接          ${connection}`,
  ];
  if (snapshot.serverOrigin)
    lines.push(`Server         ${snapshot.serverOrigin}`);
  if (snapshot.agentName) lines.push(`Agent          ${snapshot.agentName}`);
  if (snapshot.lastHeartbeatAt)
    lines.push(`最近心跳      ${relativeHeartbeat(snapshot.lastHeartbeatAt)}`);
  lines.push(
    `执行槽位      ${snapshot.activeSlots} / ${snapshot.totalSlots} 使用中`,
    `等待交互      ${snapshot.waitingInteractions}`,
    `待发送结果    ${snapshot.outboxCount}`,
    `Binding       ${snapshot.bindingCount} 个`,
  );
  if (snapshot.connection === 'UNCONFIGURED' && snapshot.service === 'RUNNING')
    lines.push('下一步：xapt daemon connect <server-url>');
  return lines.join('\n');
}

function relativeHeartbeat(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)} 秒前`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  return `${Math.floor(elapsed / 3_600_000)} 小时前`;
}

function safeRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '未知错误';
  return `错误：${message}`;
}
