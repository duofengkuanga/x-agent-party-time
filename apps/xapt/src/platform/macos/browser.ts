import type { Browser, CommandRunner } from '../contracts';

export class MacOsBrowser implements Browser {
  constructor(private readonly commands: CommandRunner) {}

  async open(url: URL): Promise<void> {
    const result = await this.commands.run('/usr/bin/open', [url.toString()]);
    if (result.exitCode !== 0) throw new Error('无法自动打开系统浏览器');
  }
}
