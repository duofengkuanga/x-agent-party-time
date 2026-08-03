import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('Web 生产代码和测试不导入 xapt 或旧 Runner 内部实现', async () => {
  const webRoot = resolve(import.meta.dir, '..');
  const glob = new Bun.Glob('**/*.{ts,tsx}');
  const violations: string[] = [];
  const forbiddenImport =
    /(?:from\s+|import\s*\()(['"])[^'"]*(?:apps\/xapt|packages\/runner\/src)[^'"]*\1/gu;

  for await (const path of glob.scan({ cwd: webRoot, onlyFiles: true })) {
    const source = await readFile(resolve(webRoot, path), 'utf8');
    if (forbiddenImport.test(source)) violations.push(path);
    forbiddenImport.lastIndex = 0;
  }

  expect(violations).toEqual([]);
});
