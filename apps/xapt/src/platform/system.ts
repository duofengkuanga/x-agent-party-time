import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type {
  Clock,
  CommandResult,
  CommandRunner,
  UserEnvironment,
} from './contracts';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  async sleep(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
}

export class NodeCommandRunner implements CommandRunner {
  async run(
    executable: string,
    args: readonly string[],
    options: { stdin?: string; timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs ?? 10_000);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.stdin.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (exitCode) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(new Error('本机命令执行超时'));
          return;
        }
        resolve({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      if (options.stdin !== undefined) child.stdin.write(options.stdin);
      child.stdin.end();
    });
  }
}

export class CurrentUserEnvironment implements UserEnvironment {
  homeDirectory(): string {
    const developmentHome = process.env.XAPT_DEVELOPMENT_HOME;
    return developmentHome ? resolve(developmentHome) : homedir();
  }

  userId(): number {
    const id = process.getuid?.();
    if (id === undefined) throw new Error('当前平台不支持用户级 daemon');
    return id;
  }

  platform(): NodeJS.Platform {
    return process.platform;
  }

  architecture(): string {
    return process.arch;
  }

  isTerminal(): boolean {
    return process.stdin.isTTY === true && process.stdout.isTTY === true;
  }
}
