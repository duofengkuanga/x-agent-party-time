import { appendFile, mkdir, readFile, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { git } from './worktree-git';

export async function mirrorIgnoredRepositoryContents(
  repositoryPath: string,
  worktreePath: string,
): Promise<void> {
  const entries = await ignoredRepositoryEntries(repositoryPath);
  if (entries.length === 0) return;
  await Promise.all(
    entries.map(async (entry) => {
      const target = join(worktreePath, entry);
      // 被忽略文件可能位于主工程里未跟踪的父目录下（如 cache/.DS_Store），
      // worktree 里没有该父目录，先补建（空目录不会出现在 git status）。
      await mkdir(dirname(target), { recursive: true });
      await symlink(join(repositoryPath, entry), target).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
    }),
  );
  // 符号链接目录不会被带斜杠的忽略规则匹配，追加不带斜杠的条目到仓库公共
  // .git/info/exclude，避免 git status 显示为未跟踪。注意：worktree 私有
  // gitdir（.git/worktrees/<name>/info/exclude）不会被 git 读取，必须写
  // 公共 gitdir 的 info/exclude（git rev-parse --git-path info/exclude
  // 即指向公共目录）。
  const gitDir = await git(worktreePath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const excludePath = join(gitDir, 'info', 'exclude');
  await mkdir(dirname(excludePath), { recursive: true });
  const existing = await readFile(excludePath, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    },
  );
  const lines = new Set(existing.split('\n'));
  const additions = entries.filter((entry) => !lines.has(entry));
  if (additions.length > 0)
    await appendFile(excludePath, `\n${additions.join('\n')}\n`, 'utf8');
}

async function ignoredRepositoryEntries(repositoryPath: string): Promise<string[]> {
  const value = await git(repositoryPath, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '-z',
  ]);
  return [...new Set(value.split('\0'))]
    .map((entry) => entry.replace(/\/+$/u, ''))
    .filter((entry) => entry.length > 0);
}
