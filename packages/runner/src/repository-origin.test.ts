import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepositoryOrigin } from './repository-origin';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('读取并规范化本机仓库 origin，且拒绝相对路径', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'runner-origin-'));
  directories.push(repository);
  await runGit(repository, ['init']);
  expect(await readRepositoryOrigin(repository)).toBeNull();
  await runGit(repository, [
    'remote',
    'add',
    'origin',
    'git@Example.com:team/repository.git',
  ]);
  expect(await readRepositoryOrigin(repository)).toBe(
    'https://example.com/team/repository.git',
  );
  await expect(readRepositoryOrigin('./repository')).rejects.toThrow(
    '仓库路径必须是本机绝对路径',
  );
  const nonRepository = await mkdtemp(join(tmpdir(), 'runner-not-repository-'));
  directories.push(nonRepository);
  await expect(readRepositoryOrigin(nonRepository)).rejects.toThrow(
    '本机路径不是 Git 仓库',
  );
});

async function runGit(repository: string, args: string[]): Promise<void> {
  const child = Bun.spawn(['git', '-C', repository, ...args], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
}
