import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  BindProjectCommandSchema,
  ERROR_CODES,
  ProjectBindingSchema,
  createAppError,
} from '@agent-party-time/shared';
import type { ControlPlanePort } from '@agent-party-time/control-plane-client';
import type { RunnerStateStore } from './runner-state-store.js';

export interface RepositoryBinding {
  repositoryPath: string;
  baseBranch: string;
}

export interface RepositoryResolver {
  resolve(
    repositoryPath: string,
    baseBranch?: string,
  ): Promise<RepositoryBinding>;
}

export class GitRepositoryResolver implements RepositoryResolver {
  async resolve(repositoryPath: string, requestedBranch?: string) {
    try {
      const canonicalInput = await realpath(repositoryPath);
      const repositoryRoot = await findRepositoryRoot(canonicalInput);
      const gitDirectory = await resolveGitDirectory(repositoryRoot);
      const commonGitDirectory = await resolveCommonGitDirectory(gitDirectory);
      const baseBranch = requestedBranch
        ? validateBranchName(requestedBranch)
        : await readCurrentBranch(gitDirectory);
      await assertLocalBranchExists(commonGitDirectory, baseBranch);
      return { repositoryPath: repositoryRoot, baseBranch };
    } catch {
      throw createAppError({
        code: ERROR_CODES.projectBindingInvalid,
        category: 'validation',
        message:
          '项目绑定必须指向本地 Git 仓库；分离 HEAD 时需要显式提供本地基准分支',
        retryable: false,
      });
    }
  }
}

async function findRepositoryRoot(path: string) {
  let current = (await lstat(path)).isDirectory() ? path : dirname(path);
  while (true) {
    try {
      await lstat(join(current, '.git'));
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error('Git repository root not found');
    current = parent;
  }
}

async function resolveGitDirectory(repositoryRoot: string) {
  const dotGit = join(repositoryRoot, '.git');
  if ((await lstat(dotGit)).isDirectory()) return dotGit;
  const pointer = (await readFile(dotGit, 'utf8')).trim();
  const match = /^gitdir:\s*(.+)$/i.exec(pointer);
  if (!match?.[1]) throw new Error('Invalid Git directory pointer');
  return realpath(resolve(repositoryRoot, match[1]));
}

async function resolveCommonGitDirectory(gitDirectory: string) {
  return readFile(join(gitDirectory, 'commondir'), 'utf8')
    .then((pointer) => realpath(resolve(gitDirectory, pointer.trim())))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return gitDirectory;
      throw error;
    });
}

async function readCurrentBranch(gitDirectory: string) {
  const head = (await readFile(join(gitDirectory, 'HEAD'), 'utf8')).trim();
  const prefix = 'ref: refs/heads/';
  if (!head.startsWith(prefix)) throw new Error('Detached HEAD');
  return validateBranchName(head.slice(prefix.length));
}

function validateBranchName(branch: string) {
  const normalized = branch.trim();
  if (
    !normalized ||
    normalized.startsWith('-') ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.endsWith('.') ||
    normalized.includes('..') ||
    normalized.includes('@{') ||
    normalized.includes('//') ||
    normalized === '@' ||
    normalized
      .split('/')
      .some(
        (component) =>
          component.startsWith('.') ||
          component.toLowerCase().endsWith('.lock'),
      ) ||
    /[\x00-\x20~^:?*[\\]/.test(normalized)
  )
    throw new Error('Invalid branch name');
  return normalized;
}

async function assertLocalBranchExists(gitDirectory: string, branch: string) {
  try {
    await access(join(gitDirectory, 'refs', 'heads', ...branch.split('/')));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const packedRefs = await readFile(
    join(gitDirectory, 'packed-refs'),
    'utf8',
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (
    !packedRefs
      .split('\n')
      .some((line) => line.endsWith(` refs/heads/${branch}`))
  )
    throw new Error('Local branch does not exist');
}

export interface ProjectBindingServiceOptions {
  controlPlane: ControlPlanePort;
  stateStore: RunnerStateStore;
  runner: { runnerId: string; runnerName: string };
  repositories?: RepositoryResolver;
  now?: () => Date;
}

export class ProjectBindingService {
  private readonly repositories: RepositoryResolver;
  private readonly now: () => Date;

  constructor(private readonly options: ProjectBindingServiceOptions) {
    this.repositories = options.repositories ?? new GitRepositoryResolver();
    this.now = options.now ?? (() => new Date());
  }

  async bind(rawInput: unknown) {
    const input = BindProjectCommandSchema.parse(rawInput);
    const [project, repository] = await Promise.all([
      this.options.controlPlane.getProject(input.project),
      this.repositories.resolve(input.repositoryPath, input.baseBranch),
      this.options.controlPlane.registerRunner({
        runnerId: this.options.runner.runnerId,
        name: this.options.runner.runnerName,
      }),
    ]);
    const now = this.now().toISOString();
    const binding = await this.options.stateStore.saveBinding(
      ProjectBindingSchema.parse({
        projectId: project.id,
        projectSlug: project.slug,
        projectTitle: project.title,
        runnerId: this.options.runner.runnerId,
        repositoryPath: repository.repositoryPath,
        baseBranch: repository.baseBranch,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await this.options.controlPlane.setProjectDefaultRunner(
      project.id,
      this.options.runner.runnerId,
    );
    return { binding };
  }

  async list() {
    return { items: await this.options.stateStore.listBindings() };
  }
}
