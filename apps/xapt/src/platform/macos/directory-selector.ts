import type { CommandRunner } from '../contracts';

export interface DirectorySelector {
  selectDirectory(): Promise<string | null>;
}

export class MacOsDirectorySelector implements DirectorySelector {
  constructor(private readonly commands: CommandRunner) {}

  async selectDirectory(): Promise<string | null> {
    const result = await this.commands.run('/usr/bin/osascript', [
      '-e',
      'POSIX path of (choose folder with prompt "选择要绑定的 Git 仓库")',
    ]);
    if (result.exitCode === 0) return result.stdout.trim().replace(/\/$/u, '');
    if (/User canceled/iu.test(result.stderr)) return null;
    throw new Error('无法打开本机目录选择器');
  }
}
