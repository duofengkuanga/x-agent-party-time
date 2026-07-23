import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneAdapter } from '@agent-party-time/control-plane-client';
import {
  GitRepositoryResolver,
  ProjectBindingService,
} from './project-binding-service.js';
import { RunnerStateStore } from './runner-state-store.js';

describe('project binding', () => {
  let directory: string | null = null;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  test('keeps repository paths local and restores the binding', async () => {
    directory = await mkdtemp(join(tmpdir(), 'apt-runner-binding-'));
    const controlPlane = new InMemoryControlPlaneAdapter();
    await controlPlane.createProject(
      { slug: 'checkout', title: '结算服务' },
      'project:checkout',
    );
    const statePath = join(directory, 'runner.json');
    const stateStore = new RunnerStateStore(statePath);
    const runner = await stateStore.ensureIdentity('Test Runner');
    const service = new ProjectBindingService({
      controlPlane,
      stateStore,
      runner,
      repositories: {
        resolve: async () => ({
          repositoryPath: '/private/local/checkout',
          baseBranch: 'main',
        }),
      },
    });
    const result = await service.bind({
      project: 'checkout',
      repositoryPath: directory,
    });
    expect(result.binding.repositoryPath).toBe('/private/local/checkout');
    expect((await controlPlane.getProject('checkout')).executable).toBe(true);

    const restored = await new RunnerStateStore(statePath).listBindings();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.projectSlug).toBe('checkout');
    expect(JSON.stringify(await controlPlane.listProjects())).not.toContain(
      '/private/local/checkout',
    );
  });

  test('resolves repository metadata without spawning Git commands', async () => {
    directory = await mkdtemp(join(tmpdir(), 'apt-runner-repository-'));
    await mkdir(join(directory, '.git'), { recursive: true });
    await mkdir(join(directory, '.git', 'refs', 'heads'), { recursive: true });
    await mkdir(join(directory, 'packages', 'app'), { recursive: true });
    await writeFile(join(directory, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(
      join(directory, '.git', 'refs', 'heads', 'main'),
      'abc123\n',
    );

    const resolved = await new GitRepositoryResolver().resolve(
      join(directory, 'packages', 'app'),
    );

    expect(resolved).toEqual({
      repositoryPath: await realpath(directory),
      baseBranch: 'main',
    });
    await expect(
      new GitRepositoryResolver().resolve(directory, 'missing.lock'),
    ).rejects.toMatchObject({ code: 'project.binding_invalid' });
  });

  test('resolves branches from the common gitdir of a linked worktree', async () => {
    directory = await mkdtemp(join(tmpdir(), 'apt-runner-worktree-'));
    const repository = join(directory, 'repository');
    const commonGitDirectory = join(directory, 'common.git');
    const gitDirectory = join(commonGitDirectory, 'worktrees', 'repository');
    await mkdir(repository, { recursive: true });
    await mkdir(join(commonGitDirectory, 'refs', 'heads'), { recursive: true });
    await mkdir(gitDirectory, { recursive: true });
    await writeFile(
      join(repository, '.git'),
      'gitdir: ../common.git/worktrees/repository\n',
    );
    await writeFile(join(gitDirectory, 'commondir'), '../..\n');
    await writeFile(join(gitDirectory, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(
      join(commonGitDirectory, 'refs', 'heads', 'main'),
      'abc123\n',
    );

    expect(await new GitRepositoryResolver().resolve(repository)).toEqual({
      repositoryPath: await realpath(repository),
      baseBranch: 'main',
    });
  });
});
