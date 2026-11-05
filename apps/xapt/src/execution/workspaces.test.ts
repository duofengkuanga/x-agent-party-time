import { testDirectories } from '../testing/directories';
import type { ExecutionWorkspace } from '@agent-party-time/execution-contract';
import { describe, expect, test } from 'bun:test';
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  rm,
  writeFile,
} from 'node:fs/promises';

import { join } from 'node:path';
import { GitExecutionResultVerifier } from './resultVerification';
import { NodeCommandRunner } from '../platform/system';
import { xaptPaths } from '../platform/paths';
import { GitExecutionWorkspaceManager } from './workspaces';
import { readEngineeringDelivery } from './deploymentEvidence';

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
  test('更新只集成冻结提交，另一修复并发 Commit 后由下一批基于新目标分支集成', async () => {
    const { root, binding } = await createRepository();
    const manager = new GitExecutionWorkspaceManager(xaptPaths(root));
    const first = cwd(await manager.prepare(binding, repairWorkspace('first')));
    await writeFile(join(first, 'first.txt'), 'first\n');
    await run(['git', '-C', first, 'add', 'first.txt']);
    await run(['git', '-C', first, 'commit', '-m', 'first']);
    const frozen = await output(['git', '-C', first, 'rev-parse', 'HEAD']);
    const late = cwd(await manager.prepare(binding, repairWorkspace('late')));
    const update = cwd(await manager.prepare(binding, updateWorkspace('first')));
    await Promise.all([
      run(['git', '-C', update, 'cherry-pick', frozen]),
      (async () => {
        await writeFile(join(late, 'late.txt'), 'late\n');
        await run(['git', '-C', late, 'add', 'late.txt']);
        await run(['git', '-C', late, 'commit', '-m', 'late']);
      })(),
    ]);
    expect(
      await output(['git', '-C', update, 'ls-tree', '--name-only', 'HEAD']),
    ).not.toContain('late.txt');
    const lateCommit = await output(['git', '-C', late, 'rev-parse', 'HEAD']);
    await run(['git', '-C', update, 'push', 'origin', 'HEAD:main']);
    expect(await output(['git', '-C', late, 'rev-parse', 'HEAD'])).toBe(lateCommit);
    const next = cwd(await manager.prepare(binding, updateWorkspace('next')));
    await run(['git', '-C', next, 'cherry-pick', lateCommit]);
    expect(await readFile(join(next, 'first.txt'), 'utf8')).toBe('first\n');
    expect(await readFile(join(next, 'late.txt'), 'utf8')).toBe('late\n');
  });

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

  test('worktree 通过软链复用依赖与忽略内容，复用保留已有文件和目录', async () => {
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

    expect((await lstat(join(repair, 'node_modules'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(repair, 'node_modules'))).toBe(
      join(binding, 'node_modules'),
    );
    expect((await lstat(join(repair, '.env.local'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(repair, 'node_modules', 'dep.js'), 'utf8')).toBe('dep\n');
    expect(await realpath(join(repair, 'cache', '.DS_Store'))).toBe(
      await realpath(join(binding, 'cache', '.DS_Store')),
    );
    expect(await output(['git', '-C', repair, 'status', '--porcelain'])).toBe('');

    const update = cwd(await manager.prepare(binding, updateWorkspace('linked-update')));
    expect(await readlink(join(update, 'node_modules'))).toBe(
      join(binding, 'node_modules'),
    );
    expect(await readFile(join(update, 'node_modules', 'dep.js'), 'utf8')).toBe('dep\n');
    await writeFile(join(update, 'node_modules', 'dep.js'), 'shared\n');
    expect(await readFile(join(repair, 'node_modules', 'dep.js'), 'utf8')).toBe(
      'shared\n',
    );
    expect(await readFile(join(binding, 'node_modules', 'dep.js'), 'utf8')).toBe(
      'shared\n',
    );

    // A resumed workspace may already own private content; never replace it with a link.
    await rm(join(repair, '.env.local'));
    await writeFile(join(repair, '.env.local'), 'LOCAL=1\n');
    await rm(join(repair, 'node_modules'));
    await mkdir(join(repair, 'node_modules'));
    await writeFile(join(repair, 'node_modules', 'dep.js'), 'repair-only\n');
    expect(await readFile(join(binding, '.env.local'), 'utf8')).toBe('SECRET=1\n');
    const reused = cwd(await manager.prepare(binding, repairWorkspace('mirror-1')));
    expect(reused).toBe(repair);
    expect(await readFile(join(repair, '.env.local'), 'utf8')).toBe('LOCAL=1\n');
    expect((await lstat(join(repair, 'node_modules'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(repair, 'node_modules', 'dep.js'), 'utf8')).toBe(
      'repair-only\n',
    );
    expect(await readlink(join(update, 'node_modules'))).toBe(
      join(binding, 'node_modules'),
    );
  });

  test('本地忽略的工程约定传递到修复、更新和恢复工作区，保持未跟踪', async () => {
    const { root, binding } = await createRepository();
    const exclude = await output([
      'git',
      '-C',
      binding,
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'info/exclude',
    ]);
    await appendFile(exclude, '\n.xapt\n');
    await mkdir(join(binding, '.xapt'));
    const document =
      '```xapt-delivery\n' +
      JSON.stringify({
        prepare: 'sh tools/prepare.sh',
        environments: [
          { key: 'local', deploy: 'sh tools/deploy.sh', verify: 'sh tools/verify.sh' },
        ],
      }) +
      '\n```\n';
    await writeFile(join(binding, '.xapt/README.md'), document);
    const paths = xaptPaths(root);
    const manager = new GitExecutionWorkspaceManager(paths);
    const repair = cwd(
      await manager.prepare(binding, repairWorkspace('local-convention')),
    );
    const update = cwd(
      await manager.prepare(binding, updateWorkspace('local-convention')),
    );
    for (const worktree of [repair, update]) {
      expect(readEngineeringDelivery(worktree, 'local').deploy).toBe(
        'sh tools/deploy.sh',
      );
      expect(await readFile(join(worktree, '.xapt/README.md'), 'utf8')).toBe(document);
      expect(await output(['git', '-C', worktree, 'ls-files', '.xapt'])).toBe('');
      expect(await output(['git', '-C', worktree, 'status', '--porcelain'])).toBe('');
    }
    const changed = document + '\nDeveloper updated local policy.\n';
    await writeFile(join(binding, '.xapt/README.md'), changed);
    const restarted = new GitExecutionWorkspaceManager(paths);
    expect(
      cwd(await restarted.prepare(binding, repairWorkspace('local-convention'))),
    ).toBe(repair);
    expect(await readFile(join(repair, '.xapt/README.md'), 'utf8')).toBe(changed);
    expect(await readFile(join(update, '.xapt/README.md'), 'utf8')).toBe(changed);
    expect(await output(['git', '-C', binding, 'status', '--porcelain'])).toBe('');
  });

  test('修复与更新 worktree 隔离构建产物，同时复用依赖内文件', async () => {
    const { root, binding } = await createRepository({ ignoreLocalFiles: true });
    const exclude = await output([
      'git',
      '-C',
      binding,
      'rev-parse',
      '--git-path',
      'info/exclude',
    ]);
    const artifacts = [
      'dist',
      'dist.zip',
      'target',
      'build',
      '.next',
      'src/.umi',
      'src/.umi-production',
    ];
    await writeFile(join(binding, exclude), artifacts.join('\n') + '\n');
    for (const entry of artifacts) {
      if (entry === 'dist.zip') await writeFile(join(binding, entry), 'old archive');
      else {
        await mkdir(join(binding, entry), { recursive: true });
        await writeFile(join(binding, entry, 'artifact'), 'old artifact');
      }
    }
    await mkdir(join(binding, 'node_modules', 'dep', 'dist'), { recursive: true });
    await writeFile(
      join(binding, 'node_modules', 'dep', 'dist', 'index.js'),
      'dependency',
    );

    const manager = new GitExecutionWorkspaceManager(xaptPaths(root));
    const repair = cwd(await manager.prepare(binding, repairWorkspace('isolated-build')));
    const update = cwd(
      await manager.prepare(binding, updateWorkspace('isolated-build-update')),
    );
    for (const worktree of [repair, update]) {
      for (const artifact of artifacts)
        await expect(lstat(join(worktree, artifact))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      expect(
        await readFile(join(worktree, 'node_modules', 'dep', 'dist', 'index.js'), 'utf8'),
      ).toBe('dependency');
    }
    await symlink(join(binding, 'dist'), join(repair, 'dist'));
    await manager.prepare(binding, repairWorkspace('isolated-build'));
    await expect(lstat(join(repair, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(join(repair, 'dist'));
    await writeFile(join(repair, 'dist', 'artifact'), 'repair output');
    await manager.prepare(binding, repairWorkspace('isolated-build'));
    expect(await readFile(join(repair, 'dist', 'artifact'), 'utf8')).toBe(
      'repair output',
    );
    expect(await readFile(join(binding, 'dist', 'artifact'), 'utf8')).toBe(
      'old artifact',
    );
    await expect(lstat(join(update, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('依赖输入改变后解除已有共享链接并保留私有依赖', async () => {
    const { root, binding } = await createRepository({ ignoreLocalFiles: true });
    const manager = new GitExecutionWorkspaceManager(xaptPaths(root));
    await mkdir(join(binding, 'node_modules'));
    await writeFile(join(binding, 'node_modules', 'dep.js'), 'shared dependency');
    const workspace = repairWorkspace('dependency-change');
    const repair = cwd(await manager.prepare(binding, workspace));
    expect((await lstat(join(repair, 'node_modules'))).isSymbolicLink()).toBe(true);

    await writeFile(join(repair, 'package.json'), '{"dependencies":{"dep":"2.0.0"}}');
    expect(cwd(await manager.prepare(binding, workspace))).toBe(repair);
    await expect(lstat(join(repair, 'node_modules'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(binding, 'node_modules', 'dep.js'), 'utf8')).toBe(
      'shared dependency',
    );

    await mkdir(join(repair, 'node_modules'));
    await writeFile(join(repair, 'node_modules', 'dep.js'), 'private dependency');
    await manager.prepare(binding, workspace);
    expect(await readFile(join(repair, 'node_modules', 'dep.js'), 'utf8')).toBe(
      'private dependency',
    );
    expect(await readFile(join(binding, 'node_modules', 'dep.js'), 'utf8')).toBe(
      'shared dependency',
    );
  });

  test('工作区私有且被忽略的 Node 声明也参与共享依赖检查', async () => {
    const { root, binding } = await createRepository({ ignoreLocalFiles: true });
    await writeFile(join(binding, '.git/info/exclude'), '.nvmrc\n');
    await writeFile(join(binding, '.nvmrc'), 'v20');
    await mkdir(join(binding, 'node_modules'));
    const manager = new GitExecutionWorkspaceManager(xaptPaths(root));
    const workspace = repairWorkspace('runtime-dependency-change');
    const repair = cwd(await manager.prepare(binding, workspace));
    expect((await lstat(join(repair, 'node_modules'))).isSymbolicLink()).toBe(true);
    await rm(join(repair, '.nvmrc'));
    await writeFile(join(repair, '.nvmrc'), 'v22');
    await manager.prepare(binding, workspace);
    await expect(lstat(join(repair, 'node_modules'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(binding, '.nvmrc'), 'utf8')).toBe('v20');
  });

  test('依赖准备拒绝通过父目录软链修改工作区外的链接', async () => {
    const { root, binding } = await createRepository({ ignoreLocalFiles: true });
    await mkdir(join(binding, 'pkg/node_modules'), { recursive: true });
    await writeFile(join(binding, 'pkg/node_modules/dep.js'), 'shared');
    const manager = new GitExecutionWorkspaceManager(xaptPaths(root));
    const workspace = repairWorkspace('dependency-parent-link');
    const repair = cwd(await manager.prepare(binding, workspace));
    expect((await lstat(join(repair, 'pkg'))).isDirectory()).toBe(true);
    const outside = join(root, 'outside');
    await rename(join(repair, 'pkg'), outside);
    await symlink(outside, join(repair, 'pkg'));
    await writeFile(join(repair, 'package.json'), '{}');
    await expect(manager.prepare(binding, workspace)).rejects.toThrow(
      '工作区父目录不是私有目录',
    );
    expect((await lstat(join(outside, 'node_modules'))).isSymbolicLink()).toBe(true);
  });

  test('重试沿用工作区原始基线，累计提交全部进入候选，额外提交阻止轮换', async () => {
    const { root, binding } = await createRepository();
    const manager = new GitExecutionWorkspaceManager(xaptPaths(root));
    const workspace = repairWorkspace('cumulative');
    const original = await manager.prepare(binding, workspace);
    if (original.kind !== 'EXECUTE' || !original.baseCommit)
      throw new Error('缺少原始基线');
    const repair = original.cwd;
    await run(['git', '-C', repair, 'config', 'user.name', 'Test']);
    await run(['git', '-C', repair, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repair, 'first.txt'), 'first attempt');
    await run(['git', '-C', repair, 'add', 'first.txt']);
    await run(['git', '-C', repair, 'commit', '-m', 'first attempt']);
    const first = await output(['git', '-C', repair, 'rev-parse', 'HEAD']);

    const retried = await manager.prepare(binding, workspace);
    expect(retried).toMatchObject({ cwd: repair, baseCommit: original.baseCommit });
    await writeFile(join(repair, 'second.txt'), 'second attempt');
    await run(['git', '-C', repair, 'add', 'second.txt']);
    await run(['git', '-C', repair, 'commit', '-m', 'second attempt']);
    const second = await output(['git', '-C', repair, 'rev-parse', 'HEAD']);
    const verifier = new GitExecutionResultVerifier(new NodeCommandRunner());
    const assertions = [
      {
        kind: 'GIT_COMMITS_CREATED' as const,
        workspaceBindingId: '00000000-0000-4000-8000-000000000101',
        resultPath: ['result', 'repositories', 'repo-1', 'commits'],
      },
    ];
    const result = (commits: string[]) => ({
      result: { outcome: 'COMPLETED', repositories: { 'repo-1': { commits } } },
    });
    await expect(
      verifier.verify(
        repair,
        assertions,
        { gitHead: original.baseCommit },
        result([first, second]),
      ),
    ).resolves.toBeUndefined();
    await expect(
      verifier.verify(
        repair,
        assertions,
        { gitHead: original.baseCommit },
        result([second]),
      ),
    ).rejects.toThrow('创建记录不一致');

    await writeFile(join(repair, 'draft.txt'), 'private draft');
    const rotated = {
      ...repairWorkspace('next-round'),
      rotateFrom: { key: workspace.key, head: second },
    };
    await expect(manager.prepare(binding, rotated)).rejects.toThrow(
      '旧修复工作区有额外改动',
    );
    expect(await readFile(join(repair, 'draft.txt'), 'utf8')).toBe('private draft');
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
