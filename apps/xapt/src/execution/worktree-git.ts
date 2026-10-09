export async function git(repositoryPath: string, args: string[]): Promise<string> {
  const child = Bun.spawn(['git', '-C', repositoryPath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(stderr.trim() || `Git 命令失败：${args[0] ?? 'unknown'}`);
  return stdout.trim();
}

export async function gitSucceeds(
  repositoryPath: string,
  args: string[],
): Promise<boolean> {
  const child = Bun.spawn(['git', '-C', repositoryPath, ...args], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return (await child.exited) === 0;
}
