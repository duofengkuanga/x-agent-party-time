import { testDirectories } from '../testing/directories';
import type { ExecutionWorkspace } from '@agent-party-time/execution-contract';
import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';

import { join } from 'node:path';
import { xaptPaths } from '../platform/paths';
import { GitExecutionWorkspaceManager } from './workspaces';

const createTestDirectory = testDirectories('apt-workspaces-');

function repairWorkspace(id: string): ExecutionWorkspace {
  return {
    key: `bug-repair:${id}`,
    isolation: 'BRANCH_WORKTREE',
    baseRef: 'origin/main',
    branch: `apt/repair/${id}`,
  };
}

function updateWorkspace(id: string): ExecutionWorkspace {
  return {
    key: `update-batch:${id}`,
    isolation: 'DETACHED_WORKTREE',
    baseRef: 'origin/main',
  };
}

describe('GitExecutionWorkspaceManager', () => {
  test('Repair 使用唯一分支，Update 使用 Detached HEAD 且目录互不串扰', async () => {
    const { root, source, binding } = await createRepository({
      ignoreLocalFiles: true,
    });

    const paths = xaptPaths(root);
    const manager = new GitExecutionWorkspaceManager(paths);
    const repair = cwd(await manager.prepare(binding, repairWorkspace('bug-1')));
    const update = cwd(await manager.prepare(binding, updateWorkspace('batch-1')));

    expect(repair).not.toBe(update);
    expect(await output(['git', '-C', repair, 'branch', '--show-current'])).toBe(
      'apt/repair/bug-1',
    );
    expect(await output(['git', '-C', update, 'branch', '--show-current'])).toBe('');
    await writeFile(join(source, 'LATEST.md'), 'latest\n');
    await run(['git', '-C', source, 'add', 'LATEST.md']);
    await run(['git', '-C', source, 'commit', '-m', 'latest']);
    await run(['git', '-C', source, 'push', 'origin', 'main']);
    const latestUpdate = cwd(await manager.prepare(binding, updateWorkspace('batch-2')));
    expect(await output(['git', '-C', latestUpdate, 'rev-parse', 'HEAD'])).toBe(
      await output(['git', '-C', binding, 'rev-parse', 'origin/main']),
    );
    await writeFile(join(repair, 'repair-only.txt'), 'repair\n');
    expect(await output(['git', '-C', update, 'status', '--short'])).not.toContain(
      'repair-only.txt',
    );
    await run(['git', '-C', binding, 'switch', 'main']);

    const restarted = new GitExecutionWorkspaceManager(paths);
    expect(cwd(await restarted.prepare(binding, repairWorkspace('bug-1')))).toBe(repair);
    expect(await restarted.resolve(binding, repairWorkspace('bug-1'))).toBe(repair);
    await expect(
      restarted.resolve(binding, {
        key: 'missing-workspace',
        isolation: 'BRANCH_WORKTREE',
        baseRef: 'origin/main',
        branch: 'apt/repair/missing',
      }),
    ).rejects.toThrow('原任务工作区不存在');

    await run(['git', '-C', repair, 'switch', '-c', 'wrong-branch']);
    await expect(restarted.prepare(binding, repairWorkspace('bug-1'))).rejects.toThrow(
      '身份不匹配',
    );
    await run(['git', '-C', repair, 'switch', 'apt/repair/bug-1']);
    await run(['git', '-C', binding, 'branch', '-D', 'wrong-branch']);

    const replaced = cwd(await restarted.prepare(binding, updateWorkspace('replaced')));
    await run(['git', '-C', binding, 'worktree', 'remove', replaced]);
    await mkdir(replaced);
    await run(['git', 'init', replaced]);
    await expect(restarted.prepare(binding, updateWorkspace('replaced'))).rejects.toThrow(
      '身份不匹配',
    );
    await rm(replaced, { recursive: true, force: true });

    await expect(
      restarted.prepare(binding, {
        key: 'cleanup:unsafe',
        isolation: 'CLEANUP_WORKTREES',
        workspaceKeys: ['bug-repair:bug-1'],
        completionResult: { cleaned: true },
      }),
    ).rejects.toThrow('未提交修改');
    await run(['git', '-C', repair, 'add', 'repair-only.txt']);
    await run(['git', '-C', repair, 'commit', '-m', 'repair candidate']);
    await run(['git', '-C', binding, 'worktree', 'remove', update]);
    expect(
      await restarted.prepare(binding, {
        key: 'cleanup:submission-1',
        isolation: 'CLEANUP_WORKTREES',
        workspaceKeys: [
          'bug-repair:bug-1',
          'update-batch:batch-1',
          'update-batch:batch-2',
          'update-batch:replaced',
        ],
        completionResult: { cleaned: true },
      }),
    ).toEqual({ kind: 'COMPLETED', result: { cleaned: true } });
    expect(
      await output(['git', '-C', binding, 'worktree', 'list', '--porcelain']),
    ).not.toContain(repair);
    expect(await output(['git', '-C', binding, 'show-ref', '--heads'])).not.toContain(
      'apt/repair/bug-1',
    );
  });

  test('新 worktree 镜像主工程被忽略内容，复用不覆盖已存在项', async () => {
    const { root, binding } = await createRepository({
      ignoreLocalFiles: true,
    });

    await mkdir(join(binding, 'node_modules'), { recursive: true });
    await writeFile(join(binding, 'node_modules', 'dep.js'), 'dep\n');
    await writeFile(join(binding, '.env.local'), 'SECRET=1\n');
    // 被忽略文件位于主工程未跟踪的父目录下，worktree 需先补建父目录
    await mkdir(join(binding, 'cache'), { recursive: true });
    await writeFile(join(binding, 'cache', '.DS_Store'), 'ds\n');

    const paths = xaptPaths(root);
    const manager = new GitExecutionWorkspaceManager(paths);
    const repair = cwd(await manager.prepare(binding, repairWorkspace('mirror-1')));

    expect(await readlink(join(repair, 'node_modules'))).toBe(
      join(binding, 'node_modules'),
    );
    expect(await readlink(join(repair, '.env.local'))).toBe(join(binding, '.env.local'));
    expect(await readFile(join(repair, 'node_modules', 'dep.js'), 'utf8')).toBe('dep\n');
    expect(await readlink(join(repair, 'cache', '.DS_Store'))).toBe(
      join(binding, 'cache', '.DS_Store'),
    );
    expect(await output(['git', '-C', repair, 'status', '--porcelain'])).toBe('');

    await writeFile(join(repair, '.env.local'), 'LOCAL=1\n');
    const reused = cwd(await manager.prepare(binding, repairWorkspace('mirror-1')));
    expect(reused).toBe(repair);
    expect(await readFile(join(repair, '.env.local'), 'utf8')).toBe('LOCAL=1\n');
  });

  test('removeWorkspaces 先全量校验再删除，force 覆盖未提交修改', async () => {
    const { root, binding } = await createRepository();

    const paths = xaptPaths(root);
    const manager = new GitExecutionWorkspaceManager(paths);
    const repair = cwd(await manager.prepare(binding, repairWorkspace('bug-1')));
    const clean = cwd(await manager.prepare(binding, repairWorkspace('bug-2')));
    const missing = cwd(await manager.prepare(binding, repairWorkspace('bug-3')));

    expect(await manager.workspaceKeys()).toEqual([
      'bug-repair:bug-1',
      'bug-repair:bug-2',
      'bug-repair:bug-3',
    ]);

    await writeFile(join(repair, 'dirty.txt'), 'x\n');
    await expect(
      manager.removeWorkspaces(['bug-repair:bug-1'], { force: false }),
    ).rejects.toThrow('未提交修改');
    expect(await manager.workspaceKeys()).toContain('bug-repair:bug-1');

    await manager.removeWorkspaces(['bug-repair:missing'], { force: false });
    expect(await manager.workspaceKeys()).toHaveLength(3);

    // 身份不匹配时拒绝，且不删除其他记录
    await run(['git', '-C', clean, 'switch', '-c', 'wrong-branch']);
    await expect(
      manager.removeWorkspaces(['bug-repair:bug-1', 'bug-repair:bug-2'], {
        force: true,
      }),
    ).rejects.toThrow('身份不匹配');
    expect(await manager.workspaceKeys()).toContain('bug-repair:bug-1');
    expect(await manager.workspaceKeys()).toContain('bug-repair:bug-2');
    await run(['git', '-C', clean, 'switch', 'apt/repair/bug-2']);

    // 物理目录已丢失：prune + 删除分支
    await rm(missing, { recursive: true, force: true });
    await manager.removeWorkspaces(['bug-repair:bug-3'], { force: false });
    expect(await manager.workspaceKeys()).not.toContain('bug-repair:bug-3');

    // force 删除脏工作区，同时删除干净工作区
    await manager.removeWorkspaces(['bug-repair:bug-1', 'bug-repair:bug-2'], {
      force: true,
    });
    expect(await manager.workspaceKeys()).toEqual([]);
    const worktrees = await output([
      'git',
      '-C',
      binding,
      'worktree',
      'list',
      '--porcelain',
    ]);
    expect(worktrees).not.toContain(repair);
    expect(worktrees).not.toContain(clean);
    const heads = await output(['git', '-C', binding, 'show-ref', '--heads']);
    expect(heads).not.toContain('apt/repair/bug-1');
    expect(heads).not.toContain('apt/repair/bug-2');
    expect(heads).not.toContain('apt/repair/bug-3');
  });
});

async function createRepository({
  ignoreLocalFiles = false,
}: { ignoreLocalFiles?: boolean } = {}) {
  const root = await createTestDirectory();
  const remote = join(root, 'remote.git');
  const source = join(root, 'source');
  const binding = join(root, 'binding');
  await run(['git', 'init', '--bare', remote]);
  await run(['git', 'init', source]);
  await run(['git', '-C', source, 'config', 'user.email', 'test@example.com']);
  await run(['git', '-C', source, 'config', 'user.name', 'Test']);
  await writeFile(join(source, 'README.md'), 'baseline\n');
  if (ignoreLocalFiles)
    await writeFile(join(source, '.gitignore'), 'node_modules/\n.env.local\n.DS_Store\n');
  await run([
    'git',
    '-C',
    source,
    'add',
    'README.md',
    ...(ignoreLocalFiles ? ['.gitignore'] : []),
  ]);
  await run(['git', '-C', source, 'commit', '-m', 'baseline']);
  await run(['git', '-C', source, 'branch', '-M', 'main']);
  await run(['git', '-C', source, 'remote', 'add', 'origin', remote]);
  await run(['git', '-C', source, 'push', '-u', 'origin', 'main']);
  await run(['git', 'clone', remote, binding]);
  await run(['git', '-C', binding, 'switch', 'main']);
  return { root, source, binding };
}

function cwd(
  prepared: { kind: 'EXECUTE'; cwd: string } | { kind: 'COMPLETED'; result: unknown },
): string {
  if (prepared.kind !== 'EXECUTE') throw new Error('测试预期 Runner 返回可执行工作区');
  return prepared.cwd;
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'pipe' });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
}

async function output(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}
