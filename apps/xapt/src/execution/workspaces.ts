import type {
  ExecutionWorkspace,
  JsonValue,
} from '@agent-party-time/execution-contract';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { NodeLocalFileSystem } from '../platform/files';
import type { XaptPaths } from '../platform/paths';
import {
  isExpectedGitWorktree,
  requireDirectory,
  WorkspaceRecordSchema,
  type WorkspaceRecord,
} from './worktree-identity';
import { mirrorIgnoredRepositoryContents } from './worktree-local-contents';
import { git, gitSucceeds } from './worktree-git';

const WorkspaceStateSchema = z.strictObject({
  workspaces: z.record(z.string(), WorkspaceRecordSchema),
});

export interface ExecutionWorkspaceManager {
  prepare(
    repositoryPath: string,
    workspace: ExecutionWorkspace,
  ): Promise<PreparedExecutionWorkspace>;
  resolve(
    repositoryPath: string,
    workspace: ExecutionWorkspace,
  ): Promise<string>;
}

export type PreparedExecutionWorkspace =
  { kind: 'EXECUTE'; cwd: string } | { kind: 'COMPLETED'; result: JsonValue };

export class GitExecutionWorkspaceManager implements ExecutionWorkspaceManager {
  private readonly statePath: string;
  private readonly worktreeRoot: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    paths: XaptPaths,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.worktreeRoot = resolve(paths.workspaces);
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

  async resolve(
    repositoryPathValue: string,
    workspace: ExecutionWorkspace,
  ): Promise<string> {
    const result = this.pending.then(() =>
      this.resolveLocked(repositoryPathValue, workspace),
    );
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async resolveLocked(
    repositoryPathValue: string,
    workspace: ExecutionWorkspace,
  ): Promise<string> {
    if (workspace.isolation === 'CLEANUP_WORKTREES')
      throw new Error('清理工作区不能用于结果校验');
    const repositoryPath = resolve(repositoryPathValue);
    await requireDirectory(repositoryPath, '本机绑定仓库不存在');
    const record = (await this.readState()).workspaces[workspace.key];
    if (!record) throw new Error('原任务工作区不存在，无法校验同步结果');
    if (
      record.repositoryPath !== repositoryPath ||
      record.isolation !== workspace.isolation ||
      record.branch !==
        (workspace.isolation === 'BRANCH_WORKTREE' ? workspace.branch : null)
    )
      throw new Error('原任务工作区与本机映射不一致，无法校验同步结果');
    if (
      !(await isExpectedGitWorktree(repositoryPath, record, this.worktreeRoot))
    )
      throw new Error('原任务工作区不可用，无法校验同步结果');
    return record.worktreePath;
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
      ) {
        await mirrorIgnoredRepositoryContents(
          repositoryPath,
          existing.worktreePath,
        );
        return { kind: 'EXECUTE', cwd: existing.worktreePath };
      }
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
      await mirrorIgnoredRepositoryContents(repositoryPath, worktreePath);
      await this.writeState(current);
    } catch (error) {
      await git(repositoryPath, ['worktree', 'remove', worktreePath]).catch(
        () => undefined,
      );
      throw error;
    }
    return { kind: 'EXECUTE', cwd: worktreePath };
  }

  async workspaceKeys(): Promise<string[]> {
    const current = await this.readState();
    return Object.keys(current.workspaces).sort();
  }

  async removeWorkspaces(
    keys: string[],
    options: { force: boolean },
  ): Promise<void> {
    const current = await this.readState();
    const records = [...new Set(keys)]
      .map((key) => ({ key, record: current.workspaces[key] }))
      .filter(
        (entry): entry is { key: string; record: WorkspaceRecord } =>
          entry.record !== undefined,
      );
    // 第一遍：只读校验全部记录，任何一条不满足都不删除，避免半途失败。
    for (const { key, record } of records) {
      if (dirname(record.worktreePath) !== this.worktreeRoot)
        throw new Error(`拒绝删除不属于本机管理的工作区（${key}）`);
      if (!(await pathExists(record.worktreePath))) continue;
      if (
        !(await isExpectedGitWorktree(
          record.repositoryPath,
          record,
          this.worktreeRoot,
        ))
      )
        throw new Error(`拒绝删除仓库或分支身份不匹配的本机工作区（${key}）`);
      if (
        !options.force &&
        (await git(record.worktreePath, ['status', '--porcelain'])).length > 0
      )
        throw new Error(
          `工作区仍有未提交修改（${key}），拒绝删除；如需强制删除请加 --force`,
        );
    }
    // 第二遍：执行删除。每条记录使用各自绑定的 repositoryPath。
    for (const { key, record } of records) {
      if (await pathExists(record.worktreePath))
        await git(record.repositoryPath, [
          'worktree',
          'remove',
          ...(options.force ? ['--force'] : []),
          record.worktreePath,
        ]);
      else await git(record.repositoryPath, ['worktree', 'prune']);
      await deleteBranchIfPresent(record.repositoryPath, record.branch);
      delete current.workspaces[key];
    }
    for (const repositoryPath of [
      ...new Set(records.map(({ record }) => record.repositoryPath)),
    ])
      await git(repositoryPath, ['worktree', 'prune']);
    await this.writeState(current);
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
      if (await pathExists(record.worktreePath)) {
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
      } else await git(repositoryPath, ['worktree', 'prune']);
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

async function ensureMissing(path: string): Promise<void> {
  if (await pathExists(path))
    throw new Error('工作区物理目录已存在但没有可信映射');
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

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await new NodeLocalFileSystem().writeAtomic(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    0o600,
  );
}
