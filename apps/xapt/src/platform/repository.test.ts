import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeCommandRunner } from './system';
import { LocalRepositoryInspector } from './repository';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('真实临时 Git 仓库读取并规范化 remote origin', async () => {
  const path = await mkdtemp(join(tmpdir(), 'xapt-repository-'));
  directories.push(path);
  const commands = new NodeCommandRunner();
  expect((await commands.run('git', ['-C', path, 'init'])).exitCode).toBe(0);
  expect(
    (
      await commands.run('git', [
        '-C',
        path,
        'remote',
        'add',
        'origin',
        'git@GitHub.com:Team/Repository.git',
      ])
    ).exitCode,
  ).toBe(0);

  expect(await new LocalRepositoryInspector(commands).origin(path)).toBe(
    'https://github.com/Team/Repository.git',
  );
});

test('非 Git 目录被明确拒绝', async () => {
  const path = await mkdtemp(join(tmpdir(), 'xapt-not-repository-'));
  directories.push(path);
  await expect(
    new LocalRepositoryInspector(new NodeCommandRunner()).origin(path),
  ).rejects.toMatchObject({ code: 'NOT_GIT_REPOSITORY' });
});
