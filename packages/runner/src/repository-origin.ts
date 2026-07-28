import { isAbsolute, resolve } from 'node:path';
import { normalizeRepositoryUrl } from '@agent-party-time/runner-contract';

export async function readRepositoryOrigin(
  repositoryPath: string,
): Promise<string | null> {
  if (!isAbsolute(repositoryPath))
    throw new Error('仓库路径必须是本机绝对路径');
  const path = resolve(repositoryPath);
  const repositoryCheck = await git(path, [
    'rev-parse',
    '--is-inside-work-tree',
  ]);
  if (
    repositoryCheck.exitCode !== 0 ||
    repositoryCheck.stdout.trim() !== 'true'
  )
    throw new Error('本机路径不是 Git 仓库');
  const remote = await git(path, ['remote', 'get-url', 'origin']);
  const origin = remote.stdout.trim();
  if (remote.exitCode !== 0 || !origin) return null;
  return normalizeRepositoryUrl(origin);
}

async function git(
  repositoryPath: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(['git', '-C', repositoryPath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
