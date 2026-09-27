import { testDirectories } from '../testing/directories';
import { expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';

import { join } from 'node:path';
import { NodeLocalFileSystem } from './files';

const temporaryHome = testDirectories('xapt-files-');

test('原子写入在切换前中断时保留旧完整版本并清理临时文件', async () => {
  const home = await temporaryHome();
  const path = join(home, 'state', 'connection.json');
  const files = new NodeLocalFileSystem();
  await files.writeAtomic(path, '{"version":"old"}\n', 0o600);

  const interrupted = new NodeLocalFileSystem({
    beforeRename: async () => {
      throw new Error('simulated interruption');
    },
  });
  await expect(
    interrupted.writeAtomic(path, '{"version":"new"}\n', 0o600),
  ).rejects.toThrow('simulated interruption');

  expect(await readFile(path, 'utf8')).toBe('{"version":"old"}\n');
  expect(await files.list(join(home, 'state'))).toEqual(['connection.json']);
});

test('原子文件 Adapter 强制真实文件与目录 mode', async () => {
  const home = await temporaryHome();
  const privatePath = join(home, 'private', 'state.json');
  const executablePath = join(home, 'versions', '0.1.0', 'xapt');
  const plistPath = join(home, 'Library', 'LaunchAgents', 'xapt.plist');
  const files = new NodeLocalFileSystem();

  await files.writeAtomic(privatePath, '{}\n', 0o600);
  await files.writeAtomic(executablePath, 'binary', 0o755);
  await files.writeAtomic(plistPath, '<plist/>', 0o644);

  expect((await stat(join(home, 'private'))).mode & 0o777).toBe(0o700);
  expect((await stat(privatePath)).mode & 0o777).toBe(0o600);
  expect((await stat(executablePath)).mode & 0o777).toBe(0o755);
  expect((await stat(plistPath)).mode & 0o777).toBe(0o644);
});
