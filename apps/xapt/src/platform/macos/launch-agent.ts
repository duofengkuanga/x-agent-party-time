import type { CommandRunner, LaunchAgent, UserEnvironment } from '../contracts';

export class MacOsLaunchAgent implements LaunchAgent {
  constructor(
    private readonly commands: CommandRunner,
    private readonly environment: UserEnvironment,
  ) {}

  async register(plistPath: string): Promise<void> {
    const result = await this.commands.run('/bin/launchctl', [
      'bootstrap',
      this.domain(),
      plistPath,
    ]);
    if (result.exitCode !== 0)
      throw new LaunchAgentError('无法注册 xapt LaunchAgent');
  }

  async start(label: string): Promise<void> {
    const result = await this.commands.run('/bin/launchctl', [
      'kickstart',
      `${this.domain()}/${label}`,
    ]);
    if (result.exitCode !== 0)
      throw new LaunchAgentError('无法启动 xapt daemon');
  }

  async stop(label: string): Promise<void> {
    const result = await this.commands.run('/bin/launchctl', [
      'kill',
      'SIGTERM',
      `${this.domain()}/${label}`,
    ]);
    if (result.exitCode !== 0)
      throw new LaunchAgentError('无法停止 xapt daemon');
  }

  async unregister(plistPath: string): Promise<void> {
    const result = await this.commands.run('/bin/launchctl', [
      'bootout',
      this.domain(),
      plistPath,
    ]);
    if (result.exitCode !== 0 && !/No such process/iu.test(result.stderr))
      throw new LaunchAgentError('无法注销 xapt LaunchAgent');
  }

  private domain(): string {
    return `gui/${this.environment.userId()}`;
  }
}

export class LaunchAgentError extends Error {
  constructor(message: string) {
    super(`${message}。下一步：运行 xapt daemon status 检查状态。`);
    this.name = 'LaunchAgentError';
  }
}
