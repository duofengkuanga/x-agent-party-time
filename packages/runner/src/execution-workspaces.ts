import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  ExecutionWorkspace,
  JsonValue,
} from '@agent-party-time/execution-contract';
import { z } from 'zod';
import { runnerLocalPaths } from './state';

const WorkspaceRecordSchema = z
  .object({
    key: z.string().min(1),
    repositoryPath: z.string().min(1),
    worktreePath: z.string().min(1),
    isolation: z.enum(['BRANCH_WORKTREE', 'DETACHED_WORKTREE']),
    branch: z.string().min(1).nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const WorkspaceStateSchema = z
  .object({
    workspaces: z.record(z.string(), WorkspaceRecordSchema),
  })
  .strict();

type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

export interface ExecutionWorkspaceManager {
  prepare(
    repositoryPath: string,
    workspace: ExecutionWorkspace,
  ): Promise<PreparedExecutionWorkspace>;
}

export type PreparedExecutionWorkspace =
  { kind: 'EXECUTE'; cwd: string } | { kind: 'COMPLETED'; result: JsonValue };

export class GitExecutionWorkspaceManager implements ExecutionWorkspaceManager {
  private readonly statePath: string;
  private readonly worktreeRoot: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    root = join(runnerLocalPaths().root, 'workspaces'),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.worktreeRoot = resolve(root);
    this.statePath = join(this.worktreeRoot, 'state.json');
  }

  async prepare(
    repositoryPathValue: string,
    workspace: ExecutionWorkspace,
  ): Promise<PreparedExecutionWorkspace> {
    const result = this.pending.then(() =>
      this.prepareLocked(repositoryPathValue, workspace),
    );
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async prepareLocked(
    repositoryPathValue: string,
    workspace: ExecutionWorkspace,
  ): Promise<PreparedExecutionWorkspace> {
    const repositoryPath = resolve(repositoryPathValue);
    await requireDirectory(repositoryPath, '本机绑定仓库不存在');
    const current = await this.readState();
    if (workspace.isolation === 'CLEANUP_WORKTREES') {
      await this.cleanup(repositoryPath, workspace.workspaceKeys, current);
      return { kind: 'COMPLETED', result: workspace.completionResult };
    }
    const existing = current.workspaces[workspace.key];
    if (existing) {
      if (
        existing.repositoryPath !== repositoryPath ||
        existing.isolation !== workspace.isolation ||
        existing.branch !==
          (workspace.isolation === 'BRANCH_WORKTREE' ? workspace.branch : null)
      )
        throw new Error('逻辑工作区与已保存的本机映射不一致');
      if (
        await isExpectedGitWorktree(repositoryPath, existing, this.worktreeRoot)
      )
        return { kind: 'EXECUTE', cwd: existing.worktreePath };
      if (await pathExists(existing.worktreePath))
        throw new Error('拒绝复用仓库或分支身份不匹配的本机工作区');
      delete current.workspaces[workspace.key];
      await this.writeState(current);
    }

    await fetchBaseRef(repositoryPath, workspace.baseRef);
    await mkdir(this.worktreeRoot, { recursive: true, mode: 0o700 });
    await chmod(this.worktreeRoot, 0o700);
    const worktreePath = join(
      this.worktreeRoot,
      createHash('sha256').update(workspace.key).digest('hex').slice(0, 24),
    );
    await ensureMissing(worktreePath);
    await git(repositoryPath, ['worktree', 'prune']);
    if (workspace.isolation === 'BRANCH_WORKTREE') {
      const branchExists = await gitSucceeds(repositoryPath, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${workspace.branch}`,
      ]);
      await git(
        repositoryPath,
        branchExists
          ? ['worktree', 'add', worktreePath, workspace.branch]
          : [
              'worktree',
              'add',
              '-b',
              workspace.branch,
              worktreePath,
              workspace.baseRef,
            ],
      );
    } else
      await git(repositoryPath, [
        'worktree',
        'add',
        '--detach',
        worktreePath,
        workspace.baseRef,
      ]);

    const record: WorkspaceRecord = {
      key: workspace.key,
      repositoryPath,
      worktreePath,
      isolation: workspace.isolation,
      branch:
        workspace.isolation === 'BRANCH_WORKTREE' ? workspace.branch : null,
      updatedAt: this.now().toISOString(),
    };
    current.workspaces[workspace.key] = record;
    try {
      await this.writeState(current);
    } catch (error) {
      await git(repositoryPath, ['worktree', 'remove', worktreePath]).catch(
        () => undefined,
      );
      throw error;
    }
    return { kind: 'EXECUTE', cwd: worktreePath };
  }

  private async cleanup(
    repositoryPath: string,
    workspaceKeys: string[],
    current: z.infer<typeof WorkspaceStateSchema>,
  ): Promise<void> {
    for (const key of [...new Set(workspaceKeys)]) {
      const record = current.workspaces[key];
      if (!record) continue;
      if (
        record.repositoryPath !== repositoryPath ||
        dirname(record.worktreePath) !== this.worktreeRoot
      )
        throw new Error('拒绝清理不属于当前绑定的本机工作区');
      if (!(await pathExists(record.worktreePath))) {
        await git(repositoryPath, ['worktree', 'prune']);
        await deleteBranchIfPresent(repositoryPath, record.branch);
        delete current.workspaces[key];
        continue;
      }
      if (
        !(await isExpectedGitWorktree(
          repositoryPath,
          record,
          this.worktreeRoot,
        ))
      )
        throw new Error('拒绝清理仓库或分支身份不匹配的本机工作区');
      if (
        (await git(record.worktreePath, ['status', '--porcelain'])).length > 0
      )
        throw new Error('工作区仍有未提交修改，拒绝自动清理');
      await git(repositoryPath, ['worktree', 'remove', record.worktreePath]);
      await deleteBranchIfPresent(repositoryPath, record.branch);
      delete current.workspaces[key];
    }
    await git(repositoryPath, ['worktree', 'prune']);
    await this.writeState(current);
  }

  private async readState(): Promise<z.infer<typeof WorkspaceStateSchema>> {
    try {
      return WorkspaceStateSchema.parse(
        JSON.parse(await readFile(this.statePath, 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { workspaces: {} };
      throw error;
    }
  }

  private async writeState(
    state: z.infer<typeof WorkspaceStateSchema>,
  ): Promise<void> {
    await writePrivateJson(this.statePath, WorkspaceStateSchema.parse(state));
  }
}

async function fetchBaseRef(
  repositoryPath: string,
  baseRef: string,
): Promise<void> {
  const remote = baseRef.match(/^([^/]+)\/(.+)$/u);
  if (remote) await git(repositoryPath, ['fetch', '--prune', remote[1]!]);
  await git(repositoryPath, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
}

async function isExpectedGitWorktree(
  repositoryPath: string,
  record: WorkspaceRecord,
  worktreeRoot: string,
): Promise<boolean> {
  try {
    await requireDirectory(record.worktreePath, '工作区不存在');
    const [repositoryCommonDirectory, worktreeCommonDirectory] =
      await Promise.all([
        gitCommonDirectory(repositoryPath),
        gitCommonDirectory(record.worktreePath),
      ]);
    if (
      repositoryCommonDirectory !== worktreeCommonDirectory ||
      (await realpath(dirname(record.worktreePath))) !==
        (await realpath(worktreeRoot))
    )
      return false;
    const expectedPath = await realpath(record.worktreePath);
    const registered = parseWorktreeList(
      await git(repositoryPath, ['worktree', 'list', '--porcelain']),
    ).find(({ path }) => path === expectedPath);
    if (!registered) return false;
    if (record.isolation === 'DETACHED_WORKTREE')
      return registered.detached && record.branch === null;
    return (
      !registered.detached &&
      registered.branch === `refs/heads/${record.branch}`
    );
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
        path: resolve(
          lines.find((line) => line.startsWith('worktree '))!.slice(9),
        ),
        branch:
          lines.find((line) => line.startsWith('branch '))?.slice(7) ?? null,
        detached: lines.includes('detached'),
      };
    });
}

async function ensureMissing(path: string): Promise<void> {
  try {
    await stat(path);
    throw new Error('工作区物理目录已存在但没有可信映射');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function deleteBranchIfPresent(
  repositoryPath: string,
  branch: string | null,
): Promise<void> {
  if (
    branch &&
    (await gitSucceeds(repositoryPath, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]))
  )
    await git(repositoryPath, ['branch', '-D', branch]);
}

async function requireDirectory(path: string, message: string): Promise<void> {
  const value = await stat(path).catch(() => null);
  if (!value?.isDirectory()) throw new Error(message);
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
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

async function gitSucceeds(
  repositoryPath: string,
  args: string[],
): Promise<boolean> {
  const child = Bun.spawn(['git', '-C', repositoryPath, ...args], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return (await child.exited) === 0;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
