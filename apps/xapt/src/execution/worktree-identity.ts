import { realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import { git } from './worktree-git';

export const WorkspaceRecordSchema = z.strictObject({
  key: z.string().min(1),
  repositoryPath: z.string().min(1),
  worktreePath: z.string().min(1),
  isolation: z.enum(['BRANCH_WORKTREE', 'DETACHED_WORKTREE']),
  branch: z.string().min(1).nullable(),
  updatedAt: z.iso.datetime(),
});

export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

export async function isExpectedGitWorktree(
  repositoryPath: string,
  record: WorkspaceRecord,
  worktreeRoot: string,
): Promise<boolean> {
  try {
    await requireDirectory(record.worktreePath, '工作区不存在');
    const [repositoryCommonDirectory, worktreeCommonDirectory] = await Promise.all([
      gitCommonDirectory(repositoryPath),
      gitCommonDirectory(record.worktreePath),
    ]);
    if (
      repositoryCommonDirectory !== worktreeCommonDirectory ||
      (await realpath(dirname(record.worktreePath))) !== (await realpath(worktreeRoot))
    )
      return false;
    const expectedPath = await realpath(record.worktreePath);
    const registered = parseWorktreeList(
      await git(repositoryPath, ['worktree', 'list', '--porcelain']),
    ).find(({ path }) => path === expectedPath);
    if (!registered) return false;
    if (record.isolation === 'DETACHED_WORKTREE')
      return registered.detached && record.branch === null;
    return !registered.detached && registered.branch === `refs/heads/${record.branch}`;
  } catch {
    return false;
  }
}

async function gitCommonDirectory(repositoryPath: string): Promise<string> {
  const value = await git(repositoryPath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  return realpath(value);
}

function parseWorktreeList(value: string): Array<{
  path: string;
  branch: string | null;
  detached: boolean;
}> {
  return value
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      return {
        path: resolve(lines.find((line) => line.startsWith('worktree '))!.slice(9)),
        branch: lines.find((line) => line.startsWith('branch '))?.slice(7) ?? null,
        detached: lines.includes('detached'),
      };
    });
}

export async function requireDirectory(path: string, message: string): Promise<void> {
  const value = await stat(path).catch(() => null);
  if (!value?.isDirectory()) throw new Error(message);
}
