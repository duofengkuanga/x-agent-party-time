import { testDirectories } from '../testing/directories';
import { expect, test } from 'bun:test';

import { NodeCommandRunner } from './system';
import { LocalRepositoryInspector } from './repository';

const createTestDirectory = testDirectories('xapt-repository-');

test('真实临时 Git 仓库读取并规范化 remote origin', async () => {
  const path = await createTestDirectory();
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
  const path = await createTestDirectory('xapt-not-repository-');
  await expect(
    new LocalRepositoryInspector(new NodeCommandRunner()).origin(path),
  ).rejects.toMatchObject({ code: 'NOT_GIT_REPOSITORY' });
});
