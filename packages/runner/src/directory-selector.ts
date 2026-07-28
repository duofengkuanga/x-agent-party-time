export interface DirectorySelector {
  selectDirectory(): Promise<string | null>;
}

export class MacOSDirectorySelector implements DirectorySelector {
  async selectDirectory(): Promise<string | null> {
    if (process.platform !== 'darwin')
      throw new Error('当前平台暂不支持选择仓库目录');
    const child = Bun.spawn(
      [
        'osascript',
        '-e',
        'POSIX path of (choose folder with prompt "选择要绑定的 Git 仓库")',
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode === 0) return stdout.trim().replace(/\/$/u, '');
    if (/User canceled/iu.test(stderr)) return null;
    throw new Error('无法打开本机目录选择器');
  }
}
