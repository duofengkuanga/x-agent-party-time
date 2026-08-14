import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import type { CommandRunner, UserEnvironment } from '../platform/contracts';
import type { LocalFileSystem } from '../platform/files';
import { MINIMUM_CODEX_VERSION, XAPT_VERSION } from '../version';

export interface CodexInstallation {
  executable: string;
  version: string;
}

export interface CodexPreflight {
  check(): Promise<CodexInstallation>;
}

export interface CodexInitializer {
  initialize(executable: string, timeoutMs?: number): Promise<void>;
}

export class MacOsCodexPreflight implements CodexPreflight {
  constructor(
    private readonly commands: CommandRunner,
    private readonly files: LocalFileSystem,
    private readonly environment: UserEnvironment,
    private readonly initializer: CodexInitializer = new AppServerInitializer(),
    private readonly minimumVersion = MINIMUM_CODEX_VERSION,
  ) {}

  async check(): Promise<CodexInstallation> {
    const executable = await this.discover();
    const versionResult = await this.commands.run(executable, ['--version']);
    const version = parseCodexVersion(versionResult.stdout);
    if (versionResult.exitCode !== 0 || !version)
      throw new CodexPreflightError(
        'VERSION_UNAVAILABLE',
        '无法读取 Codex 版本',
        '请更新官方 Codex 独立版后重试',
      );
    if (compareVersions(version, this.minimumVersion) < 0)
      throw new CodexPreflightError(
        'VERSION_TOO_OLD',
        `Codex ${version} 低于最低要求 ${this.minimumVersion}`,
        '请更新官方 Codex 独立版后重试',
      );
    const login = await this.commands.run(executable, ['login', 'status']);
    if (login.exitCode !== 0)
      throw new CodexPreflightError(
        'NOT_LOGGED_IN',
        'Codex 尚未登录',
        '请先运行 codex login',
      );
    try {
      await this.initializer.initialize(executable);
    } catch {
      throw new CodexPreflightError(
        'INITIALIZE_FAILED',
        'Codex 本机服务初始化失败',
        '请更新 Codex 或检查 codex app-server 后重试',
      );
    }
    return { executable, version };
  }

  private async discover(): Promise<string> {
    const found = await this.commands.run('/usr/bin/which', ['codex']);
    const path = found.stdout.trim();
    if (found.exitCode === 0 && path.startsWith('/')) return path;
    const fallback = join(this.environment.homeDirectory(), '.local/bin/codex');
    const info = await this.files.info(fallback);
    if (
      (info?.type === 'file' || info?.type === 'symbolic-link') &&
      (info.mode & 0o111) !== 0
    )
      return fallback;
    throw new CodexPreflightError(
      'NOT_FOUND',
      '未找到官方 Codex 独立版',
      '请安装官方 Codex 独立版后重试',
    );
  }
}

export class AppServerInitializer implements CodexInitializer {
  async initialize(executable: string, timeoutMs = 5_000): Promise<void> {
    const child = spawn(executable, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    try {
      await waitForInitialize(child, timeoutMs);
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('close', () => resolve());
      });
    }
  }
}

function waitForInitialize(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let pending = '';
    let settled = false;
    const timeout = setTimeout(
      () => finish(() => reject(new Error('initialize timeout'))),
      timeoutMs,
    );
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    child.once('error', (error) => finish(() => reject(error)));
    child.stdin.once('error', (error) => finish(() => reject(error)));
    child.once('close', () =>
      finish(() => reject(new Error('app-server exited before initialize'))),
    );
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.id !== 1) continue;
        if ('error' in message)
          finish(() => reject(new Error('initialize rejected')));
        else {
          child.stdin.write(
            `${JSON.stringify({ method: 'initialized', params: {} })}\n`,
          );
          finish(resolve);
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'xapt',
            title: 'xapt',
            version: XAPT_VERSION,
          },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      })}\n`,
    );
  });
}

export function parseCodexVersion(output: string): string | null {
  return /(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+)/iu.exec(output)?.[1] ?? null;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export type CodexPreflightErrorCode =
  | 'NOT_FOUND'
  | 'VERSION_UNAVAILABLE'
  | 'VERSION_TOO_OLD'
  | 'NOT_LOGGED_IN'
  | 'INITIALIZE_FAILED';

export class CodexPreflightError extends Error {
  constructor(
    readonly code: CodexPreflightErrorCode,
    message: string,
    nextStep: string,
  ) {
    super(`${message}。下一步：${nextStep}。`);
    this.name = 'CodexPreflightError';
  }
}
