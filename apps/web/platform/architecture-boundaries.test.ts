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

test('Platform 与本机 Agent 不反向依赖 Cooking 实现', async () => {
  const roots = [
    {
      root: resolve(import.meta.dir),
      forbidden: /(?:@\/cooking|features\/cooking)/u,
    },
    {
      root: resolve(import.meta.dir, '../../xapt/src'),
      forbidden: /(?:apps\/web|@\/cooking|@\/platform|features\/cooking)/u,
    },
  ];
  const violations: string[] = [];
  for (const { root, forbidden } of roots) {
    for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({
      cwd: root,
      onlyFiles: true,
    })) {
      if (file.includes('.test.')) continue;
      const source = await readFile(resolve(root, file), 'utf8');
      for (const match of source.matchAll(
        /(?:from\s+|import\s*\()(['"])([^'"]+)\1/gu,
      )) {
        if (forbidden.test(match[2]!)) violations.push(`${file}: ${match[2]}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
