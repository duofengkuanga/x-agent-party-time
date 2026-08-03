import { isAbsolute, resolve } from 'node:path';
import { normalizeRepositoryUrl } from '@agent-party-time/runner-contract';
import type { CommandRunner } from './contracts';

export class LocalRepositoryInspector {
  constructor(private readonly commands: CommandRunner) {}

  async origin(repositoryPath: string): Promise<string | null> {
    if (!isAbsolute(repositoryPath))
      throw new RepositoryError('INVALID_DIRECTORY', '仓库路径必须是绝对路径');
    const path = resolve(repositoryPath);
    const repository = await this.commands.run('git', [
      '-C',
      path,
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    if (repository.exitCode !== 0 || repository.stdout.trim() !== 'true')
      throw new RepositoryError('NOT_GIT_REPOSITORY', '所选目录不是 Git 仓库');
    const remote = await this.commands.run('git', [
      '-C',
      path,
      'remote',
      'get-url',
      'origin',
    ]);
    if (remote.exitCode !== 0 || !remote.stdout.trim()) return null;
    return normalizeRepositoryUrl(remote.stdout.trim());
  }
}

export class RepositoryError extends Error {
  constructor(
    readonly code: 'INVALID_DIRECTORY' | 'NOT_GIT_REPOSITORY',
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}
